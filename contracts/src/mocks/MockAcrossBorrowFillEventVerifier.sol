// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAcrossBorrowFillEventVerifier} from "../interfaces/IAcrossBorrowFillEventVerifier.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";

/// @notice Dev/test mock that validates borrow-fill inclusion payload bindings.
/// @dev This does not validate Merkle proofs; it only checks that the encoded payload matches expected fields.
contract MockAcrossBorrowFillEventVerifier is IAcrossBorrowFillEventVerifier {
    struct BorrowFillInclusionPayload {
        uint256 sourceChainId;
        bytes32 sourceBlockHash;
        bytes32 receiptsRoot;
        bytes32 sourceTxHash;
        uint256 sourceLogIndex;
        address sourceReceiver;
        bytes32 intentId;
        uint8 intentType;
        address user;
        address recipient;
        address spokeToken;
        address hubAsset;
        uint256 amount;
        uint256 fee;
        address relayer;
        bytes32 messageHash;
        uint256 destinationChainId;
        address hubDispatcher;
        address hubFinalizer;
    }

    function verifyBorrowFillRecorded(
        IBorrowFillProofVerifier.BorrowFillWitness calldata witness,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot,
        address sourceReceiver,
        uint256 expectedDestinationChainId,
        address expectedHubDispatcher,
        address expectedHubFinalizer,
        bytes calldata proof
    ) external view override returns (bool) {
        BorrowFillInclusionPayload memory payload;
        try this.decodePayload(proof) returns (BorrowFillInclusionPayload memory parsed) {
            payload = parsed;
        } catch {
            return false;
        }

        return payload.sourceChainId == witness.sourceChainId && payload.sourceBlockHash == sourceBlockHash
            && payload.receiptsRoot == receiptsRoot && payload.sourceTxHash == witness.sourceTxHash
            && payload.sourceLogIndex == witness.sourceLogIndex && payload.sourceReceiver == sourceReceiver
            && payload.intentId == witness.intentId && payload.intentType == witness.intentType
            && payload.user == witness.user && payload.recipient == witness.recipient
            && payload.spokeToken == witness.spokeToken && payload.hubAsset == witness.hubAsset
            && payload.amount == witness.amount && payload.fee == witness.fee && payload.relayer == witness.relayer
            && payload.messageHash == witness.messageHash && payload.destinationChainId == expectedDestinationChainId
            && payload.hubDispatcher == expectedHubDispatcher
            && payload.hubFinalizer == expectedHubFinalizer;
    }

    function decodePayload(bytes calldata proof) external pure returns (BorrowFillInclusionPayload memory payload) {
        payload = abi.decode(proof, (BorrowFillInclusionPayload));
    }
}
