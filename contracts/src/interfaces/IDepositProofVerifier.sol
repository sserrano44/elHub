// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDepositProofVerifier {
    struct DepositWitness {
        uint256 sourceChainId;
        uint256 depositId;
        uint8 intentType;
        address user;
        address hubAsset;
        uint256 amount;
        bytes32 sourceTxHash;
        uint256 sourceLogIndex;
        bytes32 messageHash;
    }

    function verifyDepositProof(bytes calldata proof, DepositWitness calldata witness) external view returns (bool);
}
