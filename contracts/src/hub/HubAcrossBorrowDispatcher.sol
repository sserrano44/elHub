// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";

interface IAcrossSpokePoolBorrowDispatcher {
    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable;
}

/// @notice Hub-side Across dispatcher for borrow fulfillment.
/// @dev Relayers pre-fund the bridge leg from hub and are reimbursed on settlement finalization.
contract HubAcrossBorrowDispatcher is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        address spokePool;
        address spokeToken;
        address spokeReceiver;
        address exclusiveRelayer;
        uint32 fillDeadlineBuffer;
        bool enabled;
    }

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

    mapping(address => Route) public routes;
    mapping(address => bool) public allowedCaller;

    address public hubFinalizer;
    uint32 public defaultFillDeadlineBuffer = 2 hours;

    event RouteSet(
        address indexed hubAsset,
        address indexed spokePool,
        address indexed spokeToken,
        address spokeReceiver,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        bool enabled
    );
    event AllowedCallerSet(address indexed caller, bool allowed);
    event DefaultFillDeadlineBufferSet(uint32 fillDeadlineBuffer);
    event HubFinalizerSet(address indexed finalizer);
    event BorrowDispatchInitiated(
        bytes32 indexed intentId,
        uint8 intentType,
        address indexed hubAsset,
        address indexed spokeToken,
        address spokePool,
        uint256 amount,
        uint256 relayerFee,
        address relayer,
        uint256 destinationChainId,
        bytes32 messageHash,
        address caller
    );

    error UnauthorizedCaller(address caller);
    error InvalidHubAsset(address hubAsset);
    error InvalidSpokePool(address spokePool);
    error InvalidSpokeToken(address spokeToken);
    error InvalidSpokeReceiver(address receiver);
    error RouteNotEnabled(address hubAsset);
    error InvalidOutputToken(address expected, address got);
    error InvalidRelayerFee(uint256 fee, uint256 maxFee, uint256 amount);
    error InvalidHubFinalizer(address finalizer);
    error InvalidFillDeadlineBuffer();
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidIntentType(uint8 intentType);
    error TimestampOverflow();

    constructor(address owner_, address hubFinalizer_) Ownable(owner_) {
        _setHubFinalizer(hubFinalizer_);
    }

    function setAllowedCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert UnauthorizedCaller(caller);
        allowedCaller[caller] = allowed;
        emit AllowedCallerSet(caller, allowed);
    }

    function setHubFinalizer(address hubFinalizer_) external onlyOwner {
        _setHubFinalizer(hubFinalizer_);
    }

    function setDefaultFillDeadlineBuffer(uint32 fillDeadlineBuffer) external onlyOwner {
        if (fillDeadlineBuffer == 0) revert InvalidFillDeadlineBuffer();
        defaultFillDeadlineBuffer = fillDeadlineBuffer;
        emit DefaultFillDeadlineBufferSet(fillDeadlineBuffer);
    }

    function setRoute(
        address hubAsset,
        address spokePool,
        address spokeToken,
        address spokeReceiver,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        bool enabled
    ) external onlyOwner {
        if (hubAsset == address(0)) revert InvalidHubAsset(hubAsset);
        if (spokePool == address(0)) revert InvalidSpokePool(spokePool);
        if (spokeToken == address(0)) revert InvalidSpokeToken(spokeToken);
        if (spokeReceiver == address(0)) revert InvalidSpokeReceiver(spokeReceiver);

        routes[hubAsset] = Route({
            spokePool: spokePool,
            spokeToken: spokeToken,
            spokeReceiver: spokeReceiver,
            exclusiveRelayer: exclusiveRelayer,
            fillDeadlineBuffer: fillDeadlineBuffer,
            enabled: enabled
        });

        emit RouteSet(hubAsset, spokePool, spokeToken, spokeReceiver, exclusiveRelayer, fillDeadlineBuffer, enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function dispatchBorrowFill(
        bytes32 intentId,
        uint8 intentType,
        address user,
        address recipient,
        address outputToken,
        uint256 amount,
        uint256 outputChainId,
        uint256 relayerFee,
        uint256 maxRelayerFee,
        address hubAsset
    )
        external
        nonReentrant
        whenNotPaused
        returns (bytes32)
    {
        if (!allowedCaller[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (intentType != Constants.INTENT_BORROW && intentType != Constants.INTENT_WITHDRAW) {
            revert InvalidIntentType(intentType);
        }
        if (user == address(0) || recipient == address(0)) revert InvalidSpokeReceiver(recipient);
        if (hubAsset == address(0)) revert InvalidHubAsset(hubAsset);
        if (outputChainId == 0) revert InvalidDestinationChainId(outputChainId);
        if (relayerFee > maxRelayerFee || relayerFee >= amount) {
            revert InvalidRelayerFee(relayerFee, maxRelayerFee, amount);
        }

        Route memory route = routes[hubAsset];
        if (!route.enabled || route.spokePool == address(0) || route.spokeToken == address(0) || route.spokeReceiver == address(0)) {
            revert RouteNotEnabled(hubAsset);
        }
        if (outputToken != route.spokeToken) {
            revert InvalidOutputToken(route.spokeToken, outputToken);
        }

        uint32 fillDeadlineBuffer = route.fillDeadlineBuffer == 0 ? defaultFillDeadlineBuffer : route.fillDeadlineBuffer;
        if (fillDeadlineBuffer == 0) revert InvalidFillDeadlineBuffer();
        if (block.timestamp > type(uint32).max - fillDeadlineBuffer) revert TimestampOverflow();

        uint32 quoteTimestamp = uint32(block.timestamp);
        uint32 fillDeadline = uint32(block.timestamp) + fillDeadlineBuffer;

        bytes memory acrossMessage = _encodeBorrowDispatchMessage(
            intentId, intentType, user, recipient, route.spokeToken, hubAsset, amount, relayerFee, outputChainId, msg.sender
        );

        IERC20(hubAsset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(hubAsset).safeApprove(route.spokePool, 0);
        IERC20(hubAsset).safeApprove(route.spokePool, amount);

        IAcrossSpokePoolBorrowDispatcher(route.spokePool).depositV3(
            msg.sender,
            route.spokeReceiver,
            hubAsset,
            route.spokeToken,
            amount,
            amount,
            outputChainId,
            route.exclusiveRelayer,
            quoteTimestamp,
            fillDeadline,
            0,
            acrossMessage
        );

        IERC20(hubAsset).safeApprove(route.spokePool, 0);

        emit BorrowDispatchInitiated(
            intentId,
            intentType,
            hubAsset,
            route.spokeToken,
            route.spokePool,
            amount,
            relayerFee,
            msg.sender,
            outputChainId,
            keccak256(acrossMessage),
            msg.sender
        );

        return intentId;
    }

    function _setHubFinalizer(address hubFinalizer_) internal {
        if (hubFinalizer_ == address(0)) revert InvalidHubFinalizer(hubFinalizer_);
        hubFinalizer = hubFinalizer_;
        emit HubFinalizerSet(hubFinalizer_);
    }

    function _encodeBorrowDispatchMessage(
        bytes32 intentId,
        uint8 intentType,
        address user,
        address recipient,
        address spokeToken,
        address hubAsset,
        uint256 amount,
        uint256 relayerFee,
        uint256 outputChainId,
        address relayer
    ) internal view returns (bytes memory) {
        return abi.encode(
            intentId,
            intentType,
            user,
            recipient,
            spokeToken,
            hubAsset,
            amount,
            relayerFee,
            relayer,
            outputChainId,
            hubFinalizer
        );
    }
}
