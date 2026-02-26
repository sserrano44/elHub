// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {IAcrossBorrowFillEventVerifier} from "../interfaces/IAcrossBorrowFillEventVerifier.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";

/// @notice Adapter forwarding borrow fill event inclusion checks to external verifier network contract.
contract ExternalAcrossBorrowFillEventVerifier is Ownable, IAcrossBorrowFillEventVerifier {
    IAcrossBorrowFillEventVerifier public verifier;

    event VerifierSet(address indexed verifier);

    error InvalidVerifier(address verifier);

    constructor(address owner_, IAcrossBorrowFillEventVerifier verifier_) Ownable(owner_) {
        _setVerifier(verifier_);
    }

    function setVerifier(IAcrossBorrowFillEventVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    function verifyBorrowFillRecorded(
        IBorrowFillProofVerifier.BorrowFillWitness calldata witness,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot,
        address sourceReceiver,
        uint256 expectedDestinationChainId,
        address expectedHubFinalizer,
        bytes calldata proof
    ) external view returns (bool) {
        return verifier.verifyBorrowFillRecorded(
            witness,
            sourceBlockHash,
            receiptsRoot,
            sourceReceiver,
            expectedDestinationChainId,
            expectedHubFinalizer,
            proof
        );
    }

    function _setVerifier(IAcrossBorrowFillEventVerifier verifier_) internal {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }
}

