// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {IAcrossDepositEventVerifier} from "../interfaces/IAcrossDepositEventVerifier.sol";

/// @notice Adapter forwarding Across V3FundsDeposited inclusion checks to external verifier network contract.
contract ExternalAcrossDepositEventVerifier is Ownable, IAcrossDepositEventVerifier {
    IAcrossDepositEventVerifier public verifier;

    event VerifierSet(address indexed verifier);

    error InvalidVerifier(address verifier);

    constructor(address owner_, IAcrossDepositEventVerifier verifier_) Ownable(owner_) {
        _setVerifier(verifier_);
    }

    function setVerifier(IAcrossDepositEventVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    function verifyV3FundsDeposited(
        uint256 sourceChainId,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        address sourceSpokePool,
        address expectedInputToken,
        bytes32 expectedMessageHash,
        address expectedRecipient,
        uint256 expectedDestinationChainId,
        address expectedOutputToken,
        uint256 expectedOutputAmount,
        bytes calldata proof
    ) external view returns (bool) {
        return verifier.verifyV3FundsDeposited(
            sourceChainId,
            sourceBlockHash,
            receiptsRoot,
            sourceTxHash,
            sourceLogIndex,
            sourceSpokePool,
            expectedInputToken,
            expectedMessageHash,
            expectedRecipient,
            expectedDestinationChainId,
            expectedOutputToken,
            expectedOutputAmount,
            proof
        );
    }

    function _setVerifier(IAcrossDepositEventVerifier verifier_) internal {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }
}

