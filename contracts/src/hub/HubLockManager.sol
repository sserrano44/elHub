// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {DataTypes} from "../libraries/DataTypes.sol";
import {Constants} from "../libraries/Constants.sol";
import {HubIntentInbox} from "./HubIntentInbox.sol";
import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";
import {IHubRiskManager} from "../interfaces/IHubRiskManager.sol";
import {IHubMoneyMarket} from "../interfaces/IHubMoneyMarket.sol";

contract HubLockManager is Ownable, Initializable, UUPSUpgradeable, Pausable, ReentrancyGuard {
    uint8 public constant LOCK_STATUS_NONE = 0;
    uint8 public constant LOCK_STATUS_ACTIVE = 1;
    uint8 public constant LOCK_STATUS_CONSUMED = 2;
    uint8 public constant LOCK_STATUS_CANCELLED = 3;
    uint256 internal constant DEFAULT_LOCK_TTL = 30 minutes;

    HubIntentInbox public immutable intentInbox;
    ITokenRegistry public immutable tokenRegistry;
    IHubRiskManager public immutable riskManager;
    IHubMoneyMarket public immutable moneyMarket;

    address public settlement;
    uint256 public lockTtl;

    mapping(bytes32 => DataTypes.Lock) public locks;

    mapping(address => mapping(address => uint256)) public reservedDebt;
    mapping(address => mapping(address => uint256)) public reservedWithdraw;
    mapping(address => uint256) public reservedLiquidity;

    event SettlementSet(address indexed settlement);
    event LockTtlSet(uint256 lockTtl);

    event BorrowLocked(bytes32 indexed intentId, address indexed user, address indexed asset, uint256 amount, address relayer);
    event WithdrawLocked(bytes32 indexed intentId, address indexed user, address indexed asset, uint256 amount, address relayer);
    event LockCancelled(bytes32 indexed intentId, address indexed user, address indexed relayer);
    event LockConsumed(bytes32 indexed intentId, address indexed user, address indexed relayer);

    error InvalidIntentType(uint8 intentType);
    error LockAlreadyExists(bytes32 intentId);
    error InsufficientHubLiquidity(address asset, uint256 requested, uint256 availableAfterReservations);
    error RiskCheckFailed(bytes32 intentId);
    error LockNotFound(bytes32 intentId);
    error LockNotActive(bytes32 intentId);
    error LockNotExpired(bytes32 intentId, uint256 expiry);
    error LockExpired(bytes32 intentId, uint256 expiry);
    error UnauthorizedSettlement(address caller);
    error UnauthorizedLockCanceller(address caller);
    error LockMismatch(bytes32 intentId);
    error UnsupportedAsset(address token);
    error InvalidSettlement(address settlement);
    error InvalidTokenDecimals(uint8 decimals);
    error InvalidAmountScaling(uint256 amount, uint8 fromDecimals, uint8 toDecimals);

    modifier onlySettlement() {
        if (msg.sender != settlement) revert UnauthorizedSettlement(msg.sender);
        _;
    }

    constructor(
        address owner_,
        HubIntentInbox intentInbox_,
        ITokenRegistry tokenRegistry_,
        IHubRiskManager riskManager_,
        IHubMoneyMarket moneyMarket_
    ) Ownable(owner_) {
        intentInbox = intentInbox_;
        tokenRegistry = tokenRegistry_;
        riskManager = riskManager_;
        moneyMarket = moneyMarket_;
        lockTtl = DEFAULT_LOCK_TTL;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
        lockTtl = DEFAULT_LOCK_TTL;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert InvalidSettlement(settlement_);
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function setLockTtl(uint256 lockTtl_) external onlyOwner {
        lockTtl = lockTtl_;
        emit LockTtlSet(lockTtl_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function lock(DataTypes.Intent calldata intent, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 intentId)
    {
        if (intent.intentType != Constants.INTENT_BORROW && intent.intentType != Constants.INTENT_WITHDRAW) {
            revert InvalidIntentType(intent.intentType);
        }

        intentId = intentInbox.consumeIntent(intent, signature);
        if (locks[intentId].status != LOCK_STATUS_NONE) {
            revert LockAlreadyExists(intentId);
        }

        address asset = _resolveHubAsset(intent.outputChainId, intent.outputToken);
        uint256 hubAmount = _toHubUnits(intent.outputChainId, asset, intent.amount);

        uint256 liquidity = moneyMarket.availableLiquidity(asset);
        uint256 reserved = reservedLiquidity[asset];
        uint256 availableAfterReservations = liquidity > reserved ? liquidity - reserved : 0;
        if (availableAfterReservations < hubAmount) {
            revert InsufficientHubLiquidity(asset, hubAmount, availableAfterReservations);
        }

        bool canLock;
        if (intent.intentType == Constants.INTENT_BORROW) {
            canLock = riskManager.canLockBorrow(intent.user, asset, hubAmount);
        } else {
            canLock = riskManager.canLockWithdraw(intent.user, asset, hubAmount);
        }
        if (!canLock) revert RiskCheckFailed(intentId);

        uint256 expiry = block.timestamp + lockTtl;
        if (expiry > intent.deadline) {
            expiry = intent.deadline;
        }

        DataTypes.Lock memory lockData = DataTypes.Lock({
            intentId: intentId,
            user: intent.user,
            intentType: intent.intentType,
            asset: asset,
            amount: hubAmount,
            relayer: msg.sender,
            lockTimestamp: block.timestamp,
            expiry: expiry,
            status: LOCK_STATUS_ACTIVE
        });

        locks[intentId] = lockData;

        reservedLiquidity[asset] += hubAmount;
        if (intent.intentType == Constants.INTENT_BORROW) {
            reservedDebt[intent.user][asset] += hubAmount;
            emit BorrowLocked(intentId, intent.user, asset, hubAmount, msg.sender);
        } else {
            reservedWithdraw[intent.user][asset] += hubAmount;
            emit WithdrawLocked(intentId, intent.user, asset, hubAmount, msg.sender);
        }
    }

    function cancelExpiredLock(bytes32 intentId) external nonReentrant {
        DataTypes.Lock storage lockData = locks[intentId];
        if (lockData.status == LOCK_STATUS_NONE) revert LockNotFound(intentId);
        if (lockData.status != LOCK_STATUS_ACTIVE) revert LockNotActive(intentId);
        if (block.timestamp < lockData.expiry) revert LockNotExpired(intentId, lockData.expiry);

        _releaseReservation(lockData);
        lockData.status = LOCK_STATUS_CANCELLED;

        emit LockCancelled(intentId, lockData.user, lockData.relayer);
    }

    function cancelLock(bytes32 intentId) external nonReentrant {
        DataTypes.Lock storage lockData = locks[intentId];
        if (lockData.status == LOCK_STATUS_NONE) revert LockNotFound(intentId);
        if (lockData.status != LOCK_STATUS_ACTIVE) revert LockNotActive(intentId);
        if (msg.sender != lockData.relayer && msg.sender != owner()) revert UnauthorizedLockCanceller(msg.sender);

        _releaseReservation(lockData);
        lockData.status = LOCK_STATUS_CANCELLED;

        emit LockCancelled(intentId, lockData.user, lockData.relayer);
    }

    function consumeLock(
        bytes32 intentId,
        uint8 expectedIntentType,
        address expectedUser,
        address expectedAsset,
        uint256 expectedAmount,
        address expectedRelayer
    ) external onlySettlement returns (DataTypes.Lock memory lockData) {
        lockData = locks[intentId];
        if (lockData.status == LOCK_STATUS_NONE) revert LockNotFound(intentId);
        if (lockData.status != LOCK_STATUS_ACTIVE) revert LockNotActive(intentId);
        if (block.timestamp > lockData.expiry) revert LockExpired(intentId, lockData.expiry);

        if (
            lockData.intentType != expectedIntentType || lockData.user != expectedUser
                || lockData.asset != expectedAsset || expectedAmount == 0 || expectedAmount > lockData.amount
                || lockData.relayer != expectedRelayer
        ) {
            revert LockMismatch(intentId);
        }

        _releaseReservation(lockData);
        locks[intentId].status = LOCK_STATUS_CONSUMED;

        emit LockConsumed(intentId, lockData.user, lockData.relayer);
    }

    function _releaseReservation(DataTypes.Lock memory lockData) internal {
        reservedLiquidity[lockData.asset] -= lockData.amount;
        if (lockData.intentType == Constants.INTENT_BORROW) {
            reservedDebt[lockData.user][lockData.asset] -= lockData.amount;
        } else {
            reservedWithdraw[lockData.user][lockData.asset] -= lockData.amount;
        }
    }

    function _resolveHubAsset(uint256 outputChainId, address outputToken) internal view returns (address asset) {
        asset = tokenRegistry.getHubTokenBySpoke(outputChainId, outputToken);
        if (asset == address(0)) {
            ITokenRegistry.TokenConfig memory directCfg = tokenRegistry.getConfigByHub(outputToken);
            if (directCfg.hubToken == outputToken) {
                asset = outputToken;
            }
        }
        if (asset == address(0)) revert UnsupportedAsset(outputToken);

        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfigByHub(asset);
        if (cfg.hubToken != asset || !cfg.enabled) revert UnsupportedAsset(outputToken);
    }

    function _toHubUnits(uint256 outputChainId, address hubAsset, uint256 amount) internal view returns (uint256) {
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfigByHub(hubAsset);
        if (cfg.hubToken != hubAsset || !cfg.enabled) revert UnsupportedAsset(hubAsset);

        uint8 spokeDecimals = tokenRegistry.getSpokeDecimalsByHub(outputChainId, hubAsset);
        uint8 hubDecimals = cfg.decimals;
        return _scaleAmount(amount, spokeDecimals, hubDecimals);
    }

    function _scaleAmount(uint256 amount, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return amount;
        if (fromDecimals > 77 || toDecimals > 77) revert InvalidTokenDecimals(fromDecimals > toDecimals ? fromDecimals : toDecimals);

        if (fromDecimals > toDecimals) {
            uint256 divisor = _pow10(fromDecimals - toDecimals);
            uint256 scaled = amount / divisor;
            if (scaled == 0) revert InvalidAmountScaling(amount, fromDecimals, toDecimals);
            return scaled;
        }

        uint256 multiplier = _pow10(toDecimals - fromDecimals);
        return amount * multiplier;
    }

    function _pow10(uint8 exponent) internal pure returns (uint256) {
        if (exponent > 77) revert InvalidTokenDecimals(exponent);
        return 10 ** uint256(exponent);
    }
}
