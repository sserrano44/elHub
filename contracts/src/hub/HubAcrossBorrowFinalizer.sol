// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";
import {HubSettlement} from "./HubSettlement.sol";

/// @notice Hub-side proof-gated finalizer for Across outbound fills observed on spoke.
contract HubAcrossBorrowFinalizer is AccessControl {
    bytes32 public constant FINALIZER_ADMIN_ROLE = keccak256("FINALIZER_ADMIN_ROLE");

    HubSettlement public immutable settlement;
    IBorrowFillProofVerifier public verifier;

    mapping(bytes32 => bool) public usedFinalizationKey;

    event VerifierSet(address indexed verifier);
    event BorrowFillFinalized(
        bytes32 indexed intentId,
        bytes32 indexed finalizationKey,
        uint256 indexed sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        address caller
    );

    error InvalidSettlement(address settlement);
    error InvalidVerifier(address verifier);
    error FinalizationReplay(bytes32 finalizationKey);
    error InvalidBorrowFillProof();

    constructor(address admin, HubSettlement settlement_, IBorrowFillProofVerifier verifier_) {
        if (address(settlement_) == address(0)) revert InvalidSettlement(address(settlement_));
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FINALIZER_ADMIN_ROLE, admin);

        settlement = settlement_;
        verifier = verifier_;

        emit VerifierSet(address(verifier_));
    }

    function setVerifier(IBorrowFillProofVerifier verifier_) external onlyRole(FINALIZER_ADMIN_ROLE) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function finalizeBorrowFill(bytes calldata proof, IBorrowFillProofVerifier.BorrowFillWitness calldata witness) external {
        bytes32 finalizationKey = finalizationKeyFor(
            witness.sourceChainId, witness.sourceTxHash, witness.sourceLogIndex, witness.intentId, witness.messageHash
        );
        if (usedFinalizationKey[finalizationKey]) revert FinalizationReplay(finalizationKey);

        if (!verifier.verifyBorrowFillProof(proof, witness)) revert InvalidBorrowFillProof();

        usedFinalizationKey[finalizationKey] = true;

        _recordVerifiedFillEvidence(witness);

        emit BorrowFillFinalized(
            witness.intentId,
            finalizationKey,
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            msg.sender
        );
    }

    function _recordVerifiedFillEvidence(IBorrowFillProofVerifier.BorrowFillWitness calldata witness) internal {
        settlement.recordVerifiedFillEvidence(
            witness.intentId,
            witness.intentType,
            witness.user,
            witness.hubAsset,
            witness.amount,
            witness.fee,
            witness.relayer
        );
    }

    function finalizationKeyFor(
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        bytes32 intentId,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash, sourceLogIndex, intentId, messageHash));
    }
}
