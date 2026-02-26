// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {ILightClientVerifier} from "../interfaces/ILightClientVerifier.sol";

/// @notice Adapter forwarding finalized-block checks to an external verifier network contract.
contract ExternalLightClientVerifier is Ownable, ILightClientVerifier {
    ILightClientVerifier public verifier;

    event VerifierSet(address indexed verifier);

    error InvalidVerifier(address verifier);

    constructor(address owner_, ILightClientVerifier verifier_) Ownable(owner_) {
        _setVerifier(verifier_);
    }

    function setVerifier(ILightClientVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    function verifyFinalizedBlock(
        uint256 sourceChainId,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        bytes calldata proof
    ) external view returns (bool) {
        return verifier.verifyFinalizedBlock(sourceChainId, sourceBlockNumber, sourceBlockHash, proof);
    }

    function _setVerifier(ILightClientVerifier verifier_) internal {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }
}

