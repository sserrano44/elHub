// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";
import {ILightClientVerifier} from "../interfaces/ILightClientVerifier.sol";
import {IAcrossBorrowFillEventVerifier} from "../interfaces/IAcrossBorrowFillEventVerifier.sol";
import {IAcrossBorrowFillProofBackend} from "../interfaces/IAcrossBorrowFillProofBackend.sol";
import {Constants} from "../libraries/Constants.sol";

/// @notice Canonical source-event backend for outbound fill proofs (borrow/withdraw).
/// @dev Verifies spoke finality + spoke BorrowFillRecorded inclusion and binds the proof to hub finalizer destination.
contract AcrossBorrowFillProofBackend is Ownable, IAcrossBorrowFillProofBackend {
    ILightClientVerifier public immutable lightClientVerifier;
    IAcrossBorrowFillEventVerifier public immutable eventVerifier;

    mapping(uint256 => address) public sourceReceiverByChain;

    event SourceReceiverSet(uint256 indexed sourceChainId, address indexed receiver);

    error InvalidVerifier(address verifier);
    error InvalidSourceReceiver(uint256 sourceChainId, address receiver);

    constructor(
        address owner_,
        ILightClientVerifier lightClientVerifier_,
        IAcrossBorrowFillEventVerifier eventVerifier_
    ) Ownable(owner_) {
        if (address(lightClientVerifier_) == address(0)) revert InvalidVerifier(address(lightClientVerifier_));
        if (address(eventVerifier_) == address(0)) revert InvalidVerifier(address(eventVerifier_));
        lightClientVerifier = lightClientVerifier_;
        eventVerifier = eventVerifier_;
    }

    function setSourceReceiver(uint256 sourceChainId, address receiver) external onlyOwner {
        if (sourceChainId == 0 || receiver == address(0)) {
            revert InvalidSourceReceiver(sourceChainId, receiver);
        }
        sourceReceiverByChain[sourceChainId] = receiver;
        emit SourceReceiverSet(sourceChainId, receiver);
    }

    function verifyCanonicalBorrowFill(
        IBorrowFillProofVerifier.BorrowFillWitness calldata witness,
        CanonicalSourceProof calldata proof,
        address destinationFinalizer,
        uint256 destinationChainId
    ) external view override returns (bool) {
        if (!_isSupportedIntentType(witness.intentType)) return false;

        address expectedReceiver = sourceReceiverByChain[witness.sourceChainId];
        if (expectedReceiver == address(0)) return false;
        if (proof.sourceReceiver != expectedReceiver) return false;

        if (
            !lightClientVerifier.verifyFinalizedBlock(
                witness.sourceChainId, proof.sourceBlockNumber, proof.sourceBlockHash, proof.finalityProof
            )
        ) {
            return false;
        }

        return eventVerifier.verifyBorrowFillRecorded(
            witness,
            proof.sourceBlockHash,
            proof.receiptsRoot,
            proof.sourceReceiver,
            destinationChainId,
            destinationFinalizer,
            proof.inclusionProof
        );
    }

    function _isSupportedIntentType(uint8 intentType) internal pure returns (bool) {
        return intentType == Constants.INTENT_BORROW || intentType == Constants.INTENT_WITHDRAW;
    }
}
