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
contract HubAcrossBorrowDispatcher is Ownable, Initializable, UUPSUpgradeable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint32 internal constant DEFAULT_FILL_DEADLINE_BUFFER = 2 hours;
    uint32 internal constant DEFAULT_MAX_QUOTE_AGE = 30 minutes;
    uint32 internal constant MAX_QUOTE_FUTURE_DRIFT = 5 minutes;

    struct Route {
        address spokePool;
        address spokeToken;
        address spokeReceiver;
        address exclusiveRelayer;
        uint32 fillDeadlineBuffer;
        uint32 maxQuoteAge;
        bool enabled;
    }

    struct AcrossQuoteParams {
        uint256 outputAmount;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        address exclusiveRelayer;
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

    mapping(bytes32 => Route) public routes;
    mapping(address => bool) public allowedCaller;

    address public hubFinalizer;
    uint32 public defaultFillDeadlineBuffer;
    uint32 public defaultMaxQuoteAge;

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
    event DefaultMaxQuoteAgeSet(uint32 maxQuoteAge);
    event HubFinalizerSet(address indexed finalizer);
    event BorrowDispatchInitiated(
        bytes32 indexed intentId,
        uint8 intentType,
        address indexed hubAsset,
        address indexed spokeToken,
        address spokePool,
        uint256 inputAmount,
        uint256 outputAmount,
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
    error QuoteExpired(uint32 quoteTimestamp, uint32 maxAge, uint256 currentTimestamp);
    error QuoteTimestampTooFarInFuture(uint32 quoteTimestamp, uint256 currentTimestamp);
    error InvalidQuoteOutputAmount(uint256 outputAmount, uint256 inputAmount);
    error InvalidQuoteDeadlines(uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline);
    error InvalidQuoteTimestamp();

    constructor(address owner_, address hubFinalizer_) Ownable(owner_) {
        defaultFillDeadlineBuffer = DEFAULT_FILL_DEADLINE_BUFFER;
        defaultMaxQuoteAge = DEFAULT_MAX_QUOTE_AGE;
        _setHubFinalizer(hubFinalizer_);
        _disableInitializers();
    }

    function initializeProxy(address owner_, address hubFinalizer_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
        defaultFillDeadlineBuffer = DEFAULT_FILL_DEADLINE_BUFFER;
        defaultMaxQuoteAge = DEFAULT_MAX_QUOTE_AGE;
        _setHubFinalizer(hubFinalizer_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

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

    function setDefaultMaxQuoteAge(uint32 maxQuoteAge) external onlyOwner {
        if (maxQuoteAge == 0) revert InvalidFillDeadlineBuffer();
        defaultMaxQuoteAge = maxQuoteAge;
        emit DefaultMaxQuoteAgeSet(maxQuoteAge);
    }

    function routeKey(address hubAsset, uint256 destinationChainId) public pure returns (bytes32) {
        return keccak256(abi.encode(hubAsset, destinationChainId));
    }

    function setRoute(
        address hubAsset,
        uint256 destinationChainId,
        address spokePool,
        address spokeToken,
        address spokeReceiver,
        bool enabled
    ) external onlyOwner {
        Route memory current = routes[routeKey(hubAsset, destinationChainId)];
        _setRoute(
            hubAsset,
            destinationChainId,
            spokePool,
            spokeToken,
            spokeReceiver,
            current.exclusiveRelayer,
            current.fillDeadlineBuffer,
            current.maxQuoteAge,
            enabled
        );
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
        _setRoute(
            hubAsset, 0, spokePool, spokeToken, spokeReceiver, exclusiveRelayer, fillDeadlineBuffer, 0, enabled
        );
    }

    function setRoute(
        address hubAsset,
        uint256 destinationChainId,
        address spokePool,
        address spokeToken,
        address spokeReceiver,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        uint32 maxQuoteAge,
        bool enabled
    ) external onlyOwner {
        _setRoute(
            hubAsset,
            destinationChainId,
            spokePool,
            spokeToken,
            spokeReceiver,
            exclusiveRelayer,
            fillDeadlineBuffer,
            maxQuoteAge,
            enabled
        );
    }

    function _setRoute(
        address hubAsset,
        uint256 destinationChainId,
        address spokePool,
        address spokeToken,
        address spokeReceiver,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        uint32 maxQuoteAge,
        bool enabled
    ) internal {
        if (hubAsset == address(0)) revert InvalidHubAsset(hubAsset);
        if (spokePool == address(0)) revert InvalidSpokePool(spokePool);
        if (spokeToken == address(0)) revert InvalidSpokeToken(spokeToken);
        if (spokeReceiver == address(0)) revert InvalidSpokeReceiver(spokeReceiver);

        routes[routeKey(hubAsset, destinationChainId)] = Route({
            spokePool: spokePool,
            spokeToken: spokeToken,
            spokeReceiver: spokeReceiver,
            exclusiveRelayer: exclusiveRelayer,
            fillDeadlineBuffer: fillDeadlineBuffer,
            maxQuoteAge: maxQuoteAge,
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
        AcrossQuoteParams memory quote = _defaultQuote(amount);
        return _dispatchBorrowFill(
            intentId,
            intentType,
            user,
            recipient,
            outputToken,
            amount,
            outputChainId,
            relayerFee,
            maxRelayerFee,
            hubAsset,
            quote
        );
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
        address hubAsset,
        AcrossQuoteParams calldata quote
    )
        external
        nonReentrant
        whenNotPaused
        returns (bytes32)
    {
        return _dispatchBorrowFill(
            intentId,
            intentType,
            user,
            recipient,
            outputToken,
            amount,
            outputChainId,
            relayerFee,
            maxRelayerFee,
            hubAsset,
            quote
        );
    }

    function _dispatchBorrowFill(
        bytes32 intentId,
        uint8 intentType,
        address user,
        address recipient,
        address outputToken,
        uint256 amount,
        uint256 outputChainId,
        uint256 relayerFee,
        uint256 maxRelayerFee,
        address hubAsset,
        AcrossQuoteParams memory quote
    ) internal returns (bytes32) {
        if (!allowedCaller[msg.sender]) revert UnauthorizedCaller(msg.sender);
        if (intentType != Constants.INTENT_BORROW && intentType != Constants.INTENT_WITHDRAW) {
            revert InvalidIntentType(intentType);
        }
        if (user == address(0) || recipient == address(0)) revert InvalidSpokeReceiver(recipient);
        if (hubAsset == address(0)) revert InvalidHubAsset(hubAsset);
        if (outputChainId == 0) revert InvalidDestinationChainId(outputChainId);
        if (relayerFee > maxRelayerFee) revert InvalidRelayerFee(relayerFee, maxRelayerFee, amount);

        Route memory route = routes[routeKey(hubAsset, outputChainId)];
        if (!route.enabled) {
            route = routes[routeKey(hubAsset, 0)];
        }
        if (!route.enabled || route.spokePool == address(0) || route.spokeToken == address(0) || route.spokeReceiver == address(0)) {
            revert RouteNotEnabled(hubAsset);
        }
        if (outputToken != route.spokeToken) {
            revert InvalidOutputToken(route.spokeToken, outputToken);
        }

        if (quote.outputAmount == 0) revert InvalidQuoteOutputAmount(quote.outputAmount, amount);
        if (relayerFee >= quote.outputAmount) {
            revert InvalidRelayerFee(relayerFee, maxRelayerFee, quote.outputAmount);
        }
        if (quote.quoteTimestamp == 0) revert InvalidQuoteTimestamp();
        uint32 maxQuoteAge = route.maxQuoteAge == 0 ? defaultMaxQuoteAge : route.maxQuoteAge;
        if (block.timestamp > uint256(quote.quoteTimestamp) + maxQuoteAge) {
            revert QuoteExpired(quote.quoteTimestamp, maxQuoteAge, block.timestamp);
        }
        if (uint256(quote.quoteTimestamp) > block.timestamp + MAX_QUOTE_FUTURE_DRIFT) {
            revert QuoteTimestampTooFarInFuture(quote.quoteTimestamp, block.timestamp);
        }
        if (quote.fillDeadline <= quote.quoteTimestamp || quote.fillDeadline <= block.timestamp) {
            revert InvalidQuoteDeadlines(quote.quoteTimestamp, quote.fillDeadline, quote.exclusivityDeadline);
        }
        if (quote.exclusivityDeadline > quote.fillDeadline) {
            revert InvalidQuoteDeadlines(quote.quoteTimestamp, quote.fillDeadline, quote.exclusivityDeadline);
        }

        bytes memory acrossMessage = _encodeBorrowDispatchMessage(
            intentId,
            intentType,
            user,
            recipient,
            route.spokeToken,
            hubAsset,
            quote.outputAmount,
            relayerFee,
            outputChainId,
            msg.sender
        );

        IERC20(hubAsset).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(hubAsset).safeApprove(route.spokePool, 0);
        IERC20(hubAsset).safeApprove(route.spokePool, amount);

        address exclusiveRelayer = quote.exclusiveRelayer == address(0) ? route.exclusiveRelayer : quote.exclusiveRelayer;

        IAcrossSpokePoolBorrowDispatcher(route.spokePool).depositV3(
            msg.sender,
            route.spokeReceiver,
            hubAsset,
            route.spokeToken,
            amount,
            quote.outputAmount,
            outputChainId,
            exclusiveRelayer,
            quote.quoteTimestamp,
            quote.fillDeadline,
            quote.exclusivityDeadline,
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
            quote.outputAmount,
            relayerFee,
            msg.sender,
            outputChainId,
            keccak256(acrossMessage),
            msg.sender
        );

        return intentId;
    }

    function _defaultQuote(uint256 amount) internal view returns (AcrossQuoteParams memory) {
        uint32 fillDeadlineBuffer = defaultFillDeadlineBuffer;
        if (fillDeadlineBuffer == 0) revert InvalidFillDeadlineBuffer();
        if (block.timestamp > type(uint32).max - fillDeadlineBuffer) revert TimestampOverflow();

        uint32 quoteTimestamp = uint32(block.timestamp);
        uint32 fillDeadline = uint32(block.timestamp) + fillDeadlineBuffer;
        return AcrossQuoteParams({
            outputAmount: amount,
            quoteTimestamp: quoteTimestamp,
            fillDeadline: fillDeadline,
            exclusivityDeadline: 0,
            exclusiveRelayer: address(0)
        });
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
