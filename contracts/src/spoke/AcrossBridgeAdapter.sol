// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
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
contract AcrossBridgeAdapter is Ownable, Initializable, UUPSUpgradeable, Pausable, ReentrancyGuard, IBridgeAdapter {
    using SafeERC20 for IERC20;
    uint32 internal constant DEFAULT_FILL_DEADLINE_BUFFER = 2 hours;
    uint32 internal constant DEFAULT_MAX_QUOTE_AGE = 30 minutes;
    uint32 internal constant MAX_QUOTE_FUTURE_DRIFT = 5 minutes;

    struct Route {
        address spokePool;
        address hubToken;
        address exclusiveRelayer;
        uint32 fillDeadlineBuffer;
        uint32 maxQuoteAge;
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
    uint32 public defaultFillDeadlineBuffer;
    uint32 public defaultMaxQuoteAge;

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
    event DefaultMaxQuoteAgeSet(uint32 maxQuoteAge);
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
    error QuoteExpired(uint32 quoteTimestamp, uint32 maxAge, uint256 currentTimestamp);
    error QuoteTimestampTooFarInFuture(uint32 quoteTimestamp, uint256 currentTimestamp);
    error InvalidQuoteOutputAmount(uint256 outputAmount, uint256 inputAmount);
    error InvalidQuoteDeadlines(uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline);
    error InvalidQuoteTimestamp();

    constructor(address owner_, uint256 destinationChainId_) Ownable(owner_) {
        if (destinationChainId_ == 0) revert InvalidDestinationChainId(destinationChainId_);
        destinationChainId = destinationChainId_;
        defaultFillDeadlineBuffer = DEFAULT_FILL_DEADLINE_BUFFER;
        defaultMaxQuoteAge = DEFAULT_MAX_QUOTE_AGE;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
        defaultFillDeadlineBuffer = DEFAULT_FILL_DEADLINE_BUFFER;
        defaultMaxQuoteAge = DEFAULT_MAX_QUOTE_AGE;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

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

    function setDefaultMaxQuoteAge(uint32 maxQuoteAge) external onlyOwner {
        if (maxQuoteAge == 0) revert InvalidFillDeadlineBuffer();
        defaultMaxQuoteAge = maxQuoteAge;
        emit DefaultMaxQuoteAgeSet(maxQuoteAge);
    }

    function setRoute(
        address localToken,
        address spokePool,
        address hubToken,
        bool enabled
    ) external onlyOwner {
        Route memory current = routes[localToken];
        _setRoute(
            localToken,
            spokePool,
            hubToken,
            current.exclusiveRelayer,
            current.fillDeadlineBuffer,
            current.maxQuoteAge,
            enabled
        );
    }

    function setRoute(
        address localToken,
        address spokePool,
        address hubToken,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        bool enabled
    ) external onlyOwner {
        Route memory current = routes[localToken];
        _setRoute(
            localToken,
            spokePool,
            hubToken,
            exclusiveRelayer,
            fillDeadlineBuffer,
            current.maxQuoteAge,
            enabled
        );
    }

    function setRoute(
        address localToken,
        address spokePool,
        address hubToken,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        uint32 maxQuoteAge,
        bool enabled
    ) external onlyOwner {
        _setRoute(localToken, spokePool, hubToken, exclusiveRelayer, fillDeadlineBuffer, maxQuoteAge, enabled);
    }

    function _setRoute(
        address localToken,
        address spokePool,
        address hubToken,
        address exclusiveRelayer,
        uint32 fillDeadlineBuffer,
        uint32 maxQuoteAge,
        bool enabled
    ) internal {
        if (localToken == address(0)) revert InvalidToken(localToken);
        if (spokePool == address(0)) revert InvalidSpokePool(spokePool);
        if (hubToken == address(0)) revert InvalidToken(hubToken);

        routes[localToken] = Route({
            spokePool: spokePool,
            hubToken: hubToken,
            exclusiveRelayer: exclusiveRelayer,
            fillDeadlineBuffer: fillDeadlineBuffer,
            maxQuoteAge: maxQuoteAge,
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

        if (extraData.length != 32 * 12) revert InvalidPortalMetadataLength(extraData.length);
        (
            uint256 depositId,
            uint8 intentType,
            address user,
            address spokeToken,
            uint256 spokeAmount,
            uint256 sourceChainId,
            uint256 messageDestinationChainId,
            uint256 quoteOutputAmount,
            uint32 quoteTimestamp,
            uint32 quoteFillDeadline,
            uint32 quoteExclusivityDeadline,
            address quoteExclusiveRelayer
        ) = abi.decode(extraData, (uint256, uint8, address, address, uint256, uint256, uint256, uint256, uint32, uint32, uint32, address));

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
        if (quoteOutputAmount == 0 || quoteOutputAmount > amount) {
            revert InvalidQuoteOutputAmount(quoteOutputAmount, amount);
        }
        if (quoteTimestamp == 0) revert InvalidQuoteTimestamp();

        uint32 maxQuoteAge = route.maxQuoteAge == 0 ? defaultMaxQuoteAge : route.maxQuoteAge;
        if (block.timestamp > uint256(quoteTimestamp) + maxQuoteAge) {
            revert QuoteExpired(quoteTimestamp, maxQuoteAge, block.timestamp);
        }
        if (uint256(quoteTimestamp) > block.timestamp + MAX_QUOTE_FUTURE_DRIFT) {
            revert QuoteTimestampTooFarInFuture(quoteTimestamp, block.timestamp);
        }
        if (quoteFillDeadline <= quoteTimestamp || quoteFillDeadline <= block.timestamp) {
            revert InvalidQuoteDeadlines(quoteTimestamp, quoteFillDeadline, quoteExclusivityDeadline);
        }
        if (quoteExclusivityDeadline > quoteFillDeadline) {
            revert InvalidQuoteDeadlines(quoteTimestamp, quoteFillDeadline, quoteExclusivityDeadline);
        }

        AcrossDepositMessage memory messagePayload = AcrossDepositMessage({
            depositId: depositId,
            intentType: intentType,
            user: user,
            spokeToken: token,
            hubAsset: route.hubToken,
            amount: quoteOutputAmount,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId
        });
        bytes memory acrossMessage = abi.encode(messagePayload);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).safeApprove(route.spokePool, 0);
        IERC20(token).safeApprove(route.spokePool, amount);

        address exclusiveRelayer = quoteExclusiveRelayer == address(0) ? route.exclusiveRelayer : quoteExclusiveRelayer;

        IAcrossSpokePool(route.spokePool).depositV3(
            msg.sender,
            hubRecipient,
            token,
            route.hubToken,
            amount,
            quoteOutputAmount,
            destinationChainId,
            exclusiveRelayer,
            quoteTimestamp,
            quoteFillDeadline,
            quoteExclusivityDeadline,
            acrossMessage
        );

        IERC20(token).safeApprove(route.spokePool, 0);

        emit AcrossBridgeInitiated(
            token,
            route.hubToken,
            hubRecipient,
            route.spokePool,
            amount,
            exclusiveRelayer,
            quoteTimestamp,
            quoteFillDeadline,
            acrossMessage,
            msg.sender
        );
    }
}
