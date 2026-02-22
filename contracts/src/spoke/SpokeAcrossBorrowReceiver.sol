// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";

/// @notice Spoke-side receiver for Across borrow fulfillment callbacks.
/// @dev Callback input is untrusted until hub-side proof finalization verifies this event inclusion.
contract SpokeAcrossBorrowReceiver is AccessControl {
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
        uint256 destinationChainId;
        address hubFinalizer;
    }

    uint256 internal constant BORROW_DISPATCH_MESSAGE_BYTES = 32 * 11;

    address public spokePool;

    mapping(bytes32 => bool) public intentFilled;

    event SpokePoolSet(address indexed spokePool);
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
        uint256 destinationChainId,
        address hubFinalizer,
        bytes32 messageHash
    );

    error InvalidSpokePool(address spokePool);
    error UnauthorizedSpokePool(address caller);
    error InvalidMessageLength(uint256 length);
    error InvalidMessageChain(uint256 expected, uint256 got);
    error InvalidHubFinalizer(address finalizer);
    error InvalidMessageUser();
    error InvalidMessageAsset();
    error InvalidMessageAmount();
    error InvalidMessageFee(uint256 fee, uint256 amount);
    error InvalidIntentType(uint8 intentType);
    error TokenAmountMismatch(address tokenSent, uint256 amountReceived, address spokeToken, uint256 amount);
    error IntentAlreadyFilled(bytes32 intentId);

    constructor(address admin, address spokePool_) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
    }

    function setSpokePool(address spokePool_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
    }

    function handleV3AcrossMessage(address tokenSent, uint256 amountReceived, address, bytes calldata message) external {
        if (msg.sender != spokePool) revert UnauthorizedSpokePool(msg.sender);
        if (message.length != BORROW_DISPATCH_MESSAGE_BYTES) revert InvalidMessageLength(message.length);

        BorrowDispatchMessage memory decoded = abi.decode(message, (BorrowDispatchMessage));

        if (decoded.destinationChainId != block.chainid) {
            revert InvalidMessageChain(block.chainid, decoded.destinationChainId);
        }
        if (decoded.hubFinalizer == address(0)) revert InvalidHubFinalizer(decoded.hubFinalizer);
        if (decoded.user == address(0) || decoded.recipient == address(0) || decoded.relayer == address(0)) {
            revert InvalidMessageUser();
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
            decoded.destinationChainId,
            decoded.hubFinalizer,
            keccak256(message)
        );
    }
}
