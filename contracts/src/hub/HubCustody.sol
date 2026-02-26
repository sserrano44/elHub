// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";

contract HubCustody is AccessControl, Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant CANONICAL_BRIDGE_RECEIVER_ROLE = keccak256("CANONICAL_BRIDGE_RECEIVER_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    struct BridgedDeposit {
        uint8 intentType;
        address user;
        address hubAsset;
        uint256 amount;
        bool consumed;
    }

    mapping(uint256 => mapping(uint256 => BridgedDeposit)) public deposits;
    mapping(bytes32 => bool) public usedAttestation;
    mapping(uint256 => mapping(uint256 => bytes32)) public depositAttestationKey;

    event BridgedDepositRegistered(
        uint256 indexed depositId,
        uint8 indexed intentType,
        address indexed user,
        address hubAsset,
        uint256 amount,
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex,
        bytes32 attestationKey
    );
    event BridgedDepositConsumed(uint256 indexed depositId, address indexed market);

    error DepositAlreadyExists(uint256 originChainId, uint256 depositId);
    error DepositNotFound(uint256 originChainId, uint256 depositId);
    error DepositAlreadyConsumed(uint256 originChainId, uint256 depositId);
    error DepositMismatch(uint256 originChainId, uint256 depositId);
    error InvalidOriginChainId(uint256 originChainId);
    error InvalidOriginTxHash();
    error AttestationAlreadyUsed(bytes32 attestationKey);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _disableInitializers();
    }

    function initializeProxy(address admin) external initializer {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function attestationKeyFor(
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex,
        uint256 depositId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(originChainId, originTxHash, originLogIndex, depositId));
    }

    function registerBridgedDeposit(
        uint256 depositId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex
    ) external onlyRole(CANONICAL_BRIDGE_RECEIVER_ROLE) {
        if (originChainId == 0) revert InvalidOriginChainId(originChainId);
        if (originTxHash == bytes32(0)) revert InvalidOriginTxHash();
        if (deposits[originChainId][depositId].hubAsset != address(0)) {
            revert DepositAlreadyExists(originChainId, depositId);
        }

        bytes32 attestationKey = attestationKeyFor(originChainId, originTxHash, originLogIndex, depositId);
        if (usedAttestation[attestationKey]) revert AttestationAlreadyUsed(attestationKey);
        usedAttestation[attestationKey] = true;
        depositAttestationKey[originChainId][depositId] = attestationKey;

        deposits[originChainId][depositId] = BridgedDeposit({
            intentType: intentType,
            user: user,
            hubAsset: hubAsset,
            amount: amount,
            consumed: false
        });

        emit BridgedDepositRegistered(
            depositId,
            intentType,
            user,
            hubAsset,
            amount,
            originChainId,
            originTxHash,
            originLogIndex,
            attestationKey
        );
    }

    function consumeDepositToMarket(
        uint256 originChainId,
        uint256 depositId,
        uint8 expectedIntentType,
        address expectedUser,
        address expectedHubAsset,
        uint256 expectedAmount,
        address market
    ) external onlyRole(SETTLEMENT_ROLE) returns (BridgedDeposit memory dep) {
        dep = deposits[originChainId][depositId];
        if (dep.hubAsset == address(0)) revert DepositNotFound(originChainId, depositId);
        if (dep.consumed) revert DepositAlreadyConsumed(originChainId, depositId);

        if (
            dep.intentType != expectedIntentType || dep.user != expectedUser || dep.hubAsset != expectedHubAsset
                || dep.amount != expectedAmount
        ) {
            revert DepositMismatch(originChainId, depositId);
        }

        deposits[originChainId][depositId].consumed = true;
        IERC20(dep.hubAsset).safeTransfer(market, dep.amount);

        emit BridgedDepositConsumed(depositId, market);
    }
}
