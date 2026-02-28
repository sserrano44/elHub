// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";

/// @notice Spoke-side receiver for Across borrow fulfillment callbacks.
/// @dev Callback input is untrusted until hub-side proof finalization verifies this event inclusion.
contract SpokeAcrossBorrowReceiver is AccessControl, Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant RECEIVER_ADMIN_ROLE = keccak256("RECEIVER_ADMIN_ROLE");

    struct BorrowDispatchMessage {
        bytes32 intentId;
        uint8 intentType;
        address user;
        address recipient;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        uint256 fee;
        address relayer;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address hubDispatcher;
        address hubFinalizer;
    }

    uint256 internal constant BORROW_DISPATCH_MESSAGE_BYTES = 32 * 13;

    address public spokePool;
    address public expectedHubDispatcher;
    address public expectedHubFinalizer;
    uint256 public expectedHubChainId;
    address public expectedFillRelayer;

    mapping(bytes32 => bool) public intentFilled;

    event SpokePoolSet(address indexed spokePool);
    event ExpectedHubDispatcherSet(address indexed hubDispatcher);
    event ExpectedHubFinalizerSet(address indexed hubFinalizer);
    event ExpectedHubChainIdSet(uint256 indexed hubChainId);
    event ExpectedFillRelayerSet(address indexed fillRelayer);
    event BorrowFillRecorded(
        bytes32 indexed intentId,
        uint8 indexed intentType,
        address indexed user,
        address recipient,
        address spokeToken,
        address hubAsset,
        uint256 amount,
        uint256 fee,
        address relayer,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address hubDispatcher,
        address hubFinalizer,
        bytes32 messageHash
    );

    error InvalidSpokePool(address spokePool);
    error InvalidHubDispatcher(address hubDispatcher);
    error UnauthorizedSpokePool(address caller);
    error InvalidFillRelayer(address fillRelayer);
    error InvalidHubChainId(uint256 hubChainId);
    error InvalidMessageLength(uint256 length);
    error InvalidSourceChain(uint256 expected, uint256 got);
    error InvalidMessageChain(uint256 expected, uint256 got);
    error InvalidHubFinalizer(address finalizer);
    error InvalidMessageHubDispatcher(address expected, address got);
    error InvalidMessageHubFinalizer(address expected, address got);
    error InvalidCallbackRelayer(address expected, address got);
    error InvalidMessageUser();
    error InvalidMessageRelayer(address expected, address got);
    error InvalidMessageAsset();
    error InvalidMessageAmount();
    error InvalidMessageFee(uint256 fee, uint256 amount);
    error InvalidIntentType(uint8 intentType);
    error TokenAmountMismatch(address tokenSent, uint256 amountReceived, address spokeToken, uint256 amount);
    error IntentAlreadyFilled(bytes32 intentId);

    constructor(
        address admin,
        address spokePool_,
        address expectedHubDispatcher_,
        address expectedHubFinalizer_,
        uint256 expectedHubChainId_,
        address expectedFillRelayer_
    ) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        if (expectedHubDispatcher_ == address(0)) revert InvalidHubDispatcher(expectedHubDispatcher_);
        if (expectedHubFinalizer_ == address(0)) revert InvalidHubFinalizer(expectedHubFinalizer_);
        if (expectedHubChainId_ == 0) revert InvalidHubChainId(expectedHubChainId_);
        if (expectedFillRelayer_ == address(0)) revert InvalidFillRelayer(expectedFillRelayer_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
        expectedHubDispatcher = expectedHubDispatcher_;
        emit ExpectedHubDispatcherSet(expectedHubDispatcher_);
        expectedHubFinalizer = expectedHubFinalizer_;
        emit ExpectedHubFinalizerSet(expectedHubFinalizer_);
        expectedHubChainId = expectedHubChainId_;
        emit ExpectedHubChainIdSet(expectedHubChainId_);
        expectedFillRelayer = expectedFillRelayer_;
        emit ExpectedFillRelayerSet(expectedFillRelayer_);
        _disableInitializers();
    }

    function initializeProxy(
        address admin,
        address spokePool_,
        address expectedHubDispatcher_,
        address expectedHubFinalizer_,
        uint256 expectedHubChainId_,
        address expectedFillRelayer_
    ) external initializer {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        if (expectedHubDispatcher_ == address(0)) revert InvalidHubDispatcher(expectedHubDispatcher_);
        if (expectedHubFinalizer_ == address(0)) revert InvalidHubFinalizer(expectedHubFinalizer_);
        if (expectedHubChainId_ == 0) revert InvalidHubChainId(expectedHubChainId_);
        if (expectedFillRelayer_ == address(0)) revert InvalidFillRelayer(expectedFillRelayer_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
        expectedHubDispatcher = expectedHubDispatcher_;
        emit ExpectedHubDispatcherSet(expectedHubDispatcher_);
        expectedHubFinalizer = expectedHubFinalizer_;
        emit ExpectedHubFinalizerSet(expectedHubFinalizer_);
        expectedHubChainId = expectedHubChainId_;
        emit ExpectedHubChainIdSet(expectedHubChainId_);
        expectedFillRelayer = expectedFillRelayer_;
        emit ExpectedFillRelayerSet(expectedFillRelayer_);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function setSpokePool(address spokePool_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
    }

    function setExpectedHubDispatcher(address expectedHubDispatcher_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (expectedHubDispatcher_ == address(0)) revert InvalidHubDispatcher(expectedHubDispatcher_);
        expectedHubDispatcher = expectedHubDispatcher_;
        emit ExpectedHubDispatcherSet(expectedHubDispatcher_);
    }

    function setExpectedHubFinalizer(address expectedHubFinalizer_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (expectedHubFinalizer_ == address(0)) revert InvalidHubFinalizer(expectedHubFinalizer_);
        expectedHubFinalizer = expectedHubFinalizer_;
        emit ExpectedHubFinalizerSet(expectedHubFinalizer_);
    }

    function setExpectedHubChainId(uint256 expectedHubChainId_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (expectedHubChainId_ == 0) revert InvalidHubChainId(expectedHubChainId_);
        expectedHubChainId = expectedHubChainId_;
        emit ExpectedHubChainIdSet(expectedHubChainId_);
    }

    function setExpectedFillRelayer(address expectedFillRelayer_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (expectedFillRelayer_ == address(0)) revert InvalidFillRelayer(expectedFillRelayer_);
        expectedFillRelayer = expectedFillRelayer_;
        emit ExpectedFillRelayerSet(expectedFillRelayer_);
    }

    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amountReceived,
        address callbackRelayer,
        bytes calldata message
    ) external {
        if (msg.sender != spokePool) revert UnauthorizedSpokePool(msg.sender);
        if (message.length != BORROW_DISPATCH_MESSAGE_BYTES) revert InvalidMessageLength(message.length);
        if (callbackRelayer != expectedFillRelayer) {
            revert InvalidCallbackRelayer(expectedFillRelayer, callbackRelayer);
        }

        BorrowDispatchMessage memory decoded = abi.decode(message, (BorrowDispatchMessage));

        if (decoded.sourceChainId != expectedHubChainId) {
            revert InvalidSourceChain(expectedHubChainId, decoded.sourceChainId);
        }
        if (decoded.destinationChainId != block.chainid) {
            revert InvalidMessageChain(block.chainid, decoded.destinationChainId);
        }
        if (decoded.hubDispatcher != expectedHubDispatcher) {
            revert InvalidMessageHubDispatcher(expectedHubDispatcher, decoded.hubDispatcher);
        }
        if (decoded.hubFinalizer != expectedHubFinalizer) {
            revert InvalidMessageHubFinalizer(expectedHubFinalizer, decoded.hubFinalizer);
        }
        if (decoded.user == address(0) || decoded.recipient == address(0) || decoded.relayer == address(0)) {
            revert InvalidMessageUser();
        }
        if (decoded.relayer != callbackRelayer) {
            revert InvalidMessageRelayer(callbackRelayer, decoded.relayer);
        }
        if (decoded.intentType != Constants.INTENT_BORROW && decoded.intentType != Constants.INTENT_WITHDRAW) {
            revert InvalidIntentType(decoded.intentType);
        }
        if (decoded.spokeToken == address(0) || decoded.hubAsset == address(0) || tokenSent == address(0)) {
            revert InvalidMessageAsset();
        }
        if (decoded.amount == 0 || amountReceived == 0) revert InvalidMessageAmount();
        if (decoded.fee >= decoded.amount) revert InvalidMessageFee(decoded.fee, decoded.amount);

        if (tokenSent != decoded.spokeToken || amountReceived != decoded.amount) {
            revert TokenAmountMismatch(tokenSent, amountReceived, decoded.spokeToken, decoded.amount);
        }
        if (intentFilled[decoded.intentId]) revert IntentAlreadyFilled(decoded.intentId);

        intentFilled[decoded.intentId] = true;

        uint256 userAmount = decoded.amount - decoded.fee;
        IERC20(tokenSent).safeTransfer(decoded.recipient, userAmount);
        if (decoded.fee > 0) {
            IERC20(tokenSent).safeTransfer(decoded.relayer, decoded.fee);
        }

        emit BorrowFillRecorded(
            decoded.intentId,
            decoded.intentType,
            decoded.user,
            decoded.recipient,
            decoded.spokeToken,
            decoded.hubAsset,
            decoded.amount,
            decoded.fee,
            decoded.relayer,
            decoded.sourceChainId,
            decoded.destinationChainId,
            decoded.hubDispatcher,
            decoded.hubFinalizer,
            keccak256(message)
        );
    }
}
