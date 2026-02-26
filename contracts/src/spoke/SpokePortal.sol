// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";
import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";

contract SpokePortal is Ownable, Initializable, UUPSUpgradeable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint32 internal constant DEFAULT_FILL_DEADLINE_BUFFER = 2 hours;

    struct Deposit {
        uint8 intentType;
        address user;
        address token;
        uint256 amount;
        uint256 timestamp;
    }

    struct AcrossQuoteParams {
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        address exclusiveRelayer;
    }

    uint256 public immutable hubChainId;

    IBridgeAdapter public bridgeAdapter;
    address public hubRecipient;

    uint256 public nextDepositId;

    mapping(uint256 => Deposit) public deposits;

    event BridgeAdapterSet(address indexed adapter);
    event HubRecipientSet(address indexed hubRecipient);

    event SupplyInitiated(
        uint256 indexed depositId,
        address indexed user,
        address indexed token,
        uint256 amount,
        uint256 hubChainId,
        uint256 timestamp
    );

    event RepayInitiated(
        uint256 indexed depositId,
        address indexed user,
        address indexed token,
        uint256 amount,
        uint256 hubChainId,
        uint256 timestamp
    );

    error InvalidAmount();
    error AdapterNotSet();
    error HubRecipientNotSet();
    error InvalidBridgeAdapter(address adapter);
    error InvalidHubRecipient(address recipient);

    constructor(address owner_, uint256 hubChainId_) Ownable(owner_) {
        hubChainId = hubChainId_;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setBridgeAdapter(address bridgeAdapter_) external onlyOwner {
        if (bridgeAdapter_ == address(0)) revert InvalidBridgeAdapter(bridgeAdapter_);
        bridgeAdapter = IBridgeAdapter(bridgeAdapter_);
        emit BridgeAdapterSet(bridgeAdapter_);
    }

    function setHubRecipient(address hubRecipient_) external onlyOwner {
        if (hubRecipient_ == address(0)) revert InvalidHubRecipient(hubRecipient_);
        hubRecipient = hubRecipient_;
        emit HubRecipientSet(hubRecipient_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function initiateSupply(address token, uint256 amount, address user)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 depositId)
    {
        depositId = _initiateInbound(
            Constants.INTENT_SUPPLY, token, amount, user, _defaultQuote(amount)
        );
        emit SupplyInitiated(depositId, user, token, amount, hubChainId, block.timestamp);
    }

    function initiateSupply(address token, uint256 amount, address user, AcrossQuoteParams calldata quote)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 depositId)
    {
        depositId = _initiateInbound(Constants.INTENT_SUPPLY, token, amount, user, quote);
        emit SupplyInitiated(depositId, user, token, amount, hubChainId, block.timestamp);
    }

    function initiateRepay(address token, uint256 amount, address user)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 depositId)
    {
        depositId = _initiateInbound(
            Constants.INTENT_REPAY, token, amount, user, _defaultQuote(amount)
        );
        emit RepayInitiated(depositId, user, token, amount, hubChainId, block.timestamp);
    }

    function initiateRepay(address token, uint256 amount, address user, AcrossQuoteParams calldata quote)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 depositId)
    {
        depositId = _initiateInbound(Constants.INTENT_REPAY, token, amount, user, quote);
        emit RepayInitiated(depositId, user, token, amount, hubChainId, block.timestamp);
    }

    function _initiateInbound(
        uint8 intentType,
        address token,
        uint256 amount,
        address user,
        AcrossQuoteParams memory quote
    )
        internal
        returns (uint256 depositId)
    {
        // Spoke only escrows and forwards to bridge adapter; accounting stays on hub.
        if (amount == 0) revert InvalidAmount();
        if (address(bridgeAdapter) == address(0)) revert AdapterNotSet();
        if (hubRecipient == address(0)) revert HubRecipientNotSet();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        depositId = ++nextDepositId;
        deposits[depositId] = Deposit({
            intentType: intentType,
            user: user,
            token: token,
            amount: amount,
            timestamp: block.timestamp
        });

        IERC20(token).safeApprove(address(bridgeAdapter), 0);
        IERC20(token).safeApprove(address(bridgeAdapter), amount);

        bridgeAdapter.bridgeToHub(
            token,
            amount,
            hubRecipient,
            abi.encode(
                depositId,
                intentType,
                user,
                token,
                amount,
                block.chainid,
                hubChainId,
                quote.outputAmount,
                quote.quoteTimestamp,
                quote.fillDeadline,
                quote.exclusivityDeadline,
                quote.exclusiveRelayer
            )
        );
    }

    function _defaultQuote(uint256 amount) internal view returns (AcrossQuoteParams memory) {
        uint32 nowTs = uint32(block.timestamp);
        return AcrossQuoteParams({
            outputAmount: amount,
            quoteTimestamp: nowTs,
            fillDeadline: nowTs + DEFAULT_FILL_DEADLINE_BUFFER,
            exclusivityDeadline: 0,
            exclusiveRelayer: address(0)
        });
    }
}
