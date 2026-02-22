// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IBridgeAdapter} from "../interfaces/IBridgeAdapter.sol";
import {Constants} from "../libraries/Constants.sol";

interface IAcrossSpokePool {
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

/// @notice Across transport adapter for spoke->hub deposits.
/// @dev This adapter preserves SpokePortal's bridge adapter interface.
contract AcrossBridgeAdapter is Ownable, Pausable, ReentrancyGuard, IBridgeAdapter {
    using SafeERC20 for IERC20;

    struct Route {
        address spokePool;
        address hubToken;
        address exclusiveRelayer;
        uint32 fillDeadlineBuffer;
        bool enabled;
    }

    struct AcrossDepositMessage {
        uint256 depositId;
        uint8 intentType;
        address user;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        uint256 sourceChainId;
        uint256 destinationChainId;
    }

    mapping(address => Route) public routes;
    mapping(address => bool) public allowedCaller;

    uint256 public immutable destinationChainId;
    uint32 public defaultFillDeadlineBuffer = 2 hours;

    event RouteSet(
        address indexed localToken,
        address indexed spokePool,
        address indexed hubToken,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        bool enabled
    );
    event AllowedCallerSet(address indexed caller, bool allowed);
    event DefaultFillDeadlineBufferSet(uint32 fillDeadlineBuffer);
    event AcrossBridgeInitiated(
        address indexed localToken,
        address indexed hubToken,
        address indexed hubRecipient,
        address spokePool,
        uint256 amount,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes message,
        address caller
    );

    error InvalidToken(address token);
    error InvalidSpokePool(address spokePool);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error InvalidDestinationChainId(uint256 destinationChainId);
    error InvalidFillDeadlineBuffer();
    error UnauthorizedCaller(address caller);
    error RouteNotEnabled(address localToken);
    error InvalidPortalMetadataLength(uint256 length);
    error InvalidPortalMetadataIntent(uint8 intentType);
    error InvalidPortalMetadataChainId(uint256 expected, uint256 got);
    error InvalidPortalMetadataToken(address expected, address got);
    error InvalidPortalMetadataAmount(uint256 expected, uint256 got);
    error TimestampOverflow();

    constructor(address owner_, uint256 destinationChainId_) Ownable(owner_) {
        if (destinationChainId_ == 0) revert InvalidDestinationChainId(destinationChainId_);
        destinationChainId = destinationChainId_;
    }

    function setAllowedCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert UnauthorizedCaller(caller);
        allowedCaller[caller] = allowed;
        emit AllowedCallerSet(caller, allowed);
    }

    function setDefaultFillDeadlineBuffer(uint32 fillDeadlineBuffer) external onlyOwner {
        if (fillDeadlineBuffer == 0) revert InvalidFillDeadlineBuffer();
        defaultFillDeadlineBuffer = fillDeadlineBuffer;
        emit DefaultFillDeadlineBufferSet(fillDeadlineBuffer);
    }

    function setRoute(
        address localToken,
        address spokePool,
        address hubToken,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        bool enabled
    ) external onlyOwner {
        if (localToken == address(0)) revert InvalidToken(localToken);
        if (spokePool == address(0)) revert InvalidSpokePool(spokePool);
        if (hubToken == address(0)) revert InvalidToken(hubToken);

        routes[localToken] = Route({
            spokePool: spokePool,
            hubToken: hubToken,
            exclusiveRelayer: exclusiveRelayer,
            fillDeadlineBuffer: fillDeadlineBuffer,
            enabled: enabled
        });

        emit RouteSet(localToken, spokePool, hubToken, exclusiveRelayer, fillDeadlineBuffer, enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function bridgeToHub(address token, uint256 amount, address hubRecipient, bytes calldata extraData)
        external
        nonReentrant
        whenNotPaused
    {
        if (!allowedCaller[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (token == address(0)) revert InvalidToken(token);
        if (hubRecipient == address(0)) revert InvalidRecipient(hubRecipient);
        if (amount == 0) revert InvalidAmount();

        Route memory route = routes[token];
        if (!route.enabled || route.spokePool == address(0) || route.hubToken == address(0)) {
            revert RouteNotEnabled(token);
        }

        if (extraData.length != 32 * 7) revert InvalidPortalMetadataLength(extraData.length);
        (
            uint256 depositId,
            uint8 intentType,
            address user,
            address spokeToken,
            uint256 spokeAmount,
            uint256 sourceChainId,
            uint256 messageDestinationChainId
        ) = abi.decode(extraData, (uint256, uint8, address, address, uint256, uint256, uint256));

        if (intentType != Constants.INTENT_SUPPLY && intentType != Constants.INTENT_REPAY) {
            revert InvalidPortalMetadataIntent(intentType);
        }
        if (messageDestinationChainId != destinationChainId) {
            revert InvalidPortalMetadataChainId(destinationChainId, messageDestinationChainId);
        }
        if (sourceChainId != block.chainid) {
            revert InvalidPortalMetadataChainId(block.chainid, sourceChainId);
        }
        if (spokeToken != token) {
            revert InvalidPortalMetadataToken(token, spokeToken);
        }
        if (spokeAmount != amount) {
            revert InvalidPortalMetadataAmount(amount, spokeAmount);
        }

        AcrossDepositMessage memory messagePayload = AcrossDepositMessage({
            depositId: depositId,
            intentType: intentType,
            user: user,
            spokeToken: token,
            hubAsset: route.hubToken,
            amount: amount,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId
        });
        bytes memory acrossMessage = abi.encode(messagePayload);

        uint32 fillDeadlineBuffer = route.fillDeadlineBuffer == 0 ? defaultFillDeadlineBuffer : route.fillDeadlineBuffer;
        if (fillDeadlineBuffer == 0) revert InvalidFillDeadlineBuffer();
        if (block.timestamp > type(uint32).max - fillDeadlineBuffer) revert TimestampOverflow();

        uint32 quoteTimestamp = uint32(block.timestamp);
        uint32 fillDeadline = uint32(block.timestamp) + fillDeadlineBuffer;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).safeApprove(route.spokePool, 0);
        IERC20(token).safeApprove(route.spokePool, amount);

        IAcrossSpokePool(route.spokePool).depositV3(
            msg.sender,
            hubRecipient,
            token,
            route.hubToken,
            amount,
            amount,
            destinationChainId,
            route.exclusiveRelayer,
            quoteTimestamp,
            fillDeadline,
            0,
            acrossMessage
        );

        IERC20(token).safeApprove(route.spokePool, 0);

        emit AcrossBridgeInitiated(
            token,
            route.hubToken,
            hubRecipient,
            route.spokePool,
            amount,
            route.exclusiveRelayer,
            quoteTimestamp,
            fillDeadline,
            acrossMessage,
            msg.sender
        );
    }
}
