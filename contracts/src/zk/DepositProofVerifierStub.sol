// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";

/// @notice Development-only verifier that binds proofs to witness bytes.
/// @dev Production deployments must replace this verifier with a real light-client/ZK verifier.
contract DepositProofVerifierStub is IDepositProofVerifier {
    function verifyDepositProof(bytes calldata proof, DepositWitness calldata witness)
        external
        pure
        override
        returns (bool)
    {
        return keccak256(proof) == keccak256(abi.encode(witness));
    }
}
