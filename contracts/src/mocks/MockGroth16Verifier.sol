// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal verifier shape expected by Groth16VerifierAdapter.
contract MockGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata
    ) external pure returns (bool) {
        return true;
    }
}
