// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";
import {IVerifier} from "../interfaces/IVerifier.sol";
import {Constants} from "../libraries/Constants.sol";
import {ProofHash} from "../libraries/ProofHash.sol";

/// @notice Verifies deposit witnesses against the shared Groth16 verifier interface.
/// @dev Reuses the 4-public-input settlement verifier shape via a deterministic witness->public-input mapping.
contract DepositProofVerifier is IDepositProofVerifier {
    uint256 internal constant SYNTHETIC_ACTION_DEPOSIT_ID = 1;
    uint256 internal constant SYNTHETIC_ACTION_USER = uint256(uint160(address(0x000000000000000000000000000000000000dEaD)));
    uint256 internal constant SYNTHETIC_ACTION_ASSET = uint256(uint160(address(0x0000000000000000000000000000000000000001)));
    uint256 internal constant SYNTHETIC_ACTION_COUNT = 1;

    IVerifier public immutable verifier;

    error InvalidVerifier(address verifier);

    constructor(IVerifier verifier_) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
    }

    function verifyDepositProof(bytes calldata proof, DepositWitness calldata witness) external view override returns (bool) {
        uint256[] memory publicInputs = _publicInputsFor(witness);
        return verifier.verifyProof(proof, publicInputs);
    }

    function publicInputsForWitness(DepositWitness calldata witness) external pure returns (uint256[4] memory inputs) {
        uint256[] memory dyn = _publicInputsFor(witness);
        inputs[0] = dyn[0];
        inputs[1] = dyn[1];
        inputs[2] = dyn[2];
        inputs[3] = dyn[3];
    }

    function _publicInputsFor(DepositWitness calldata witness) internal pure returns (uint256[] memory inputs) {
        uint256 batchId = ProofHash.toField(witness.sourceChainId);
        uint256 hubChainId = ProofHash.toField(witness.depositId);
        uint256 spokeChainId =
            ProofHash.hashPair(ProofHash.toField(witness.intentType), ProofHash.toField(uint256(uint160(witness.user))));
        uint256 witnessCommitment = _witnessCommitment(witness);
        uint256 actionId = _syntheticActionId(witnessCommitment);
        uint256 actionsRoot = _syntheticActionsRoot(batchId, hubChainId, spokeChainId, actionId);

        inputs = new uint256[](4);
        inputs[0] = batchId;
        inputs[1] = hubChainId;
        inputs[2] = spokeChainId;
        inputs[3] = actionsRoot;
    }

    function _witnessCommitment(DepositWitness calldata witness) internal pure returns (uint256) {
        uint256 state = ProofHash.hashPair(ProofHash.toField(witness.sourceChainId), ProofHash.toField(witness.depositId));
        state = ProofHash.hashPair(state, ProofHash.toField(witness.intentType));
        state = ProofHash.hashPair(state, ProofHash.toField(uint256(uint160(witness.user))));
        state = ProofHash.hashPair(state, ProofHash.toField(uint256(uint160(witness.hubAsset))));
        state = ProofHash.hashPair(state, ProofHash.toField(witness.amount));
        state = ProofHash.hashPair(state, ProofHash.toField(uint256(witness.sourceTxHash)));
        state = ProofHash.hashPair(state, ProofHash.toField(witness.sourceLogIndex));
        state = ProofHash.hashPair(state, ProofHash.toField(uint256(witness.messageHash)));
        return state;
    }

    function _syntheticActionId(uint256 witnessCommitment) internal pure returns (uint256) {
        uint256 state = ProofHash.hashPair(Constants.INTENT_SUPPLY, SYNTHETIC_ACTION_DEPOSIT_ID);
        state = ProofHash.hashPair(state, SYNTHETIC_ACTION_USER);
        state = ProofHash.hashPair(state, SYNTHETIC_ACTION_ASSET);
        return ProofHash.hashPair(state, witnessCommitment);
    }

    function _syntheticActionsRoot(uint256 batchId, uint256 hubChainId, uint256 spokeChainId, uint256 actionId)
        internal
        pure
        returns (uint256)
    {
        uint256 state = ProofHash.hashPair(batchId, hubChainId);
        state = ProofHash.hashPair(state, spokeChainId);
        state = ProofHash.hashPair(state, SYNTHETIC_ACTION_COUNT);
        state = ProofHash.hashPair(state, actionId);
        for (uint256 i = SYNTHETIC_ACTION_COUNT; i < Constants.MAX_BATCH_ACTIONS; i++) {
            state = ProofHash.hashPair(state, 0);
        }
        return state;
    }
}
