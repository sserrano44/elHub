// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";
import {HubCustody} from "./HubCustody.sol";
import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";

/// @notice Hub-side receiver for Across callbacks.
/// @dev Callback messages are untrusted until finalized through `verifyDepositProof`.
contract HubAcrossReceiver is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant RECEIVER_ADMIN_ROLE = keccak256("RECEIVER_ADMIN_ROLE");

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

    struct PendingDeposit {
        bool exists;
        bool finalized;
        uint256 sourceChainId;
        uint256 depositId;
        uint8 intentType;
        address user;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        address tokenReceived;
        uint256 amountReceived;
        address relayer;
        bytes32 messageHash;
    }

    uint256 internal constant ACROSS_DEPOSIT_MESSAGE_BYTES = 32 * 8;

    HubCustody public immutable custody;
    IDepositProofVerifier public verifier;
    address public spokePool;

    mapping(bytes32 => PendingDeposit) public pendingDeposits;
    mapping(bytes32 => bool) public usedFinalizationKey;

    event SpokePoolSet(address indexed spokePool);
    event VerifierSet(address indexed verifier);
    event PendingDepositRecorded(
        bytes32 indexed pendingId,
        uint256 indexed sourceChainId,
        uint256 indexed depositId,
        uint8 intentType,
        address user,
        address spokeToken,
        address hubAsset,
        uint256 amount,
        address tokenReceived,
        uint256 amountReceived,
        address relayer,
        bytes32 messageHash
    );
    event PendingDepositFinalized(
        bytes32 indexed pendingId,
        bytes32 indexed finalizationKey,
        uint256 indexed sourceChainId,
        uint256 depositId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        bytes32 messageHash,
        address caller
    );

    error InvalidCustodyAddress();
    error InvalidVerifier(address verifier);
    error InvalidSpokePool(address spokePool);
    error UnauthorizedSpokePool(address caller);
    error InvalidMessageLength(uint256 length);
    error UnsupportedIntentType(uint8 intentType);
    error InvalidMessageChain(uint256 expectedHubChainId, uint256 gotHubChainId);
    error InvalidMessageUser();
    error InvalidMessageAsset();
    error InvalidMessageAmount();
    error PendingAlreadyExists(bytes32 pendingId);
    error PendingNotFound(bytes32 pendingId);
    error PendingAlreadyFinalized(bytes32 pendingId);
    error PendingFillMismatch(bytes32 pendingId, address tokenReceived, uint256 amountReceived);
    error WitnessMismatch(bytes32 pendingId);
    error FinalizationReplay(bytes32 finalizationKey);
    error InvalidDepositProof();

    constructor(address admin, HubCustody custody_, IDepositProofVerifier verifier_, address spokePool_) {
        if (address(custody_) == address(0)) revert InvalidCustodyAddress();
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RECEIVER_ADMIN_ROLE, admin);

        custody = custody_;
        verifier = verifier_;
        spokePool = spokePool_;

        emit VerifierSet(address(verifier_));
        emit SpokePoolSet(spokePool_);
    }

    function setVerifier(IDepositProofVerifier verifier_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function setSpokePool(address spokePool_) external onlyRole(RECEIVER_ADMIN_ROLE) {
        if (spokePool_ == address(0)) revert InvalidSpokePool(spokePool_);
        spokePool = spokePool_;
        emit SpokePoolSet(spokePool_);
    }

    /// @notice Across V3 callback entrypoint.
    /// @dev Signature matches Across message handler callback shape.
    function handleV3AcrossMessage(address tokenSent, uint256 amountReceived, address relayer, bytes calldata message)
        external
    {
        if (msg.sender != spokePool) revert UnauthorizedSpokePool(msg.sender);
        if (message.length != ACROSS_DEPOSIT_MESSAGE_BYTES) revert InvalidMessageLength(message.length);

        AcrossDepositMessage memory decoded = abi.decode(message, (AcrossDepositMessage));
        if (decoded.intentType != Constants.INTENT_SUPPLY && decoded.intentType != Constants.INTENT_REPAY) {
            revert UnsupportedIntentType(decoded.intentType);
        }
        if (decoded.destinationChainId != block.chainid) {
            revert InvalidMessageChain(block.chainid, decoded.destinationChainId);
        }
        if (decoded.user == address(0)) revert InvalidMessageUser();
        if (decoded.hubAsset == address(0) || tokenSent == address(0)) revert InvalidMessageAsset();
        if (decoded.amount == 0 || amountReceived == 0) revert InvalidMessageAmount();

        bytes32 messageHash = keccak256(message);
        bytes32 pendingId = pendingIdFor(
            decoded.sourceChainId,
            decoded.depositId,
            decoded.intentType,
            decoded.user,
            decoded.hubAsset,
            decoded.amount,
            messageHash
        );

        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (pending.exists) revert PendingAlreadyExists(pendingId);

        pending.exists = true;
        pending.finalized = false;
        pending.sourceChainId = decoded.sourceChainId;
        pending.depositId = decoded.depositId;
        pending.intentType = decoded.intentType;
        pending.user = decoded.user;
        pending.spokeToken = decoded.spokeToken;
        pending.hubAsset = decoded.hubAsset;
        pending.amount = decoded.amount;
        pending.tokenReceived = tokenSent;
        pending.amountReceived = amountReceived;
        pending.relayer = relayer;
        pending.messageHash = messageHash;

        emit PendingDepositRecorded(
            pendingId,
            decoded.sourceChainId,
            decoded.depositId,
            decoded.intentType,
            decoded.user,
            decoded.spokeToken,
            decoded.hubAsset,
            decoded.amount,
            tokenSent,
            amountReceived,
            relayer,
            messageHash
        );
    }

    function finalizePendingDeposit(
        bytes32 pendingId,
        bytes calldata proof,
        IDepositProofVerifier.DepositWitness calldata witness
    ) external {
        PendingDeposit storage pending = pendingDeposits[pendingId];
        if (!pending.exists) revert PendingNotFound(pendingId);
        if (pending.finalized) revert PendingAlreadyFinalized(pendingId);

        if (
            pending.sourceChainId != witness.sourceChainId || pending.depositId != witness.depositId
                || pending.intentType != witness.intentType || pending.user != witness.user
                || pending.hubAsset != witness.hubAsset || pending.amount != witness.amount
                || pending.messageHash != witness.messageHash
        ) {
            revert WitnessMismatch(pendingId);
        }

        if (pending.tokenReceived != witness.hubAsset || pending.amountReceived != witness.amount) {
            revert PendingFillMismatch(pendingId, pending.tokenReceived, pending.amountReceived);
        }

        bytes32 finalizationKey = finalizationKeyFor(
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            witness.depositId,
            witness.messageHash
        );
        if (usedFinalizationKey[finalizationKey]) revert FinalizationReplay(finalizationKey);

        if (!verifier.verifyDepositProof(proof, witness)) revert InvalidDepositProof();

        usedFinalizationKey[finalizationKey] = true;
        pending.finalized = true;

        IERC20(pending.tokenReceived).safeTransfer(address(custody), pending.amountReceived);

        custody.registerBridgedDeposit(
            witness.depositId,
            witness.intentType,
            witness.user,
            witness.hubAsset,
            witness.amount,
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex
        );

        emit PendingDepositFinalized(
            pendingId,
            finalizationKey,
            witness.sourceChainId,
            witness.depositId,
            witness.intentType,
            witness.user,
            witness.hubAsset,
            witness.amount,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            witness.messageHash,
            msg.sender
        );
    }

    function pendingIdFor(
        uint256 sourceChainId,
        uint256 depositId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, depositId, intentType, user, hubAsset, amount, messageHash));
    }

    function finalizationKeyFor(
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        uint256 depositId,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash, sourceLogIndex, depositId, messageHash));
    }
}
