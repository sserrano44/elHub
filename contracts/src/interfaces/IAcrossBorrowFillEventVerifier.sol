// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBorrowFillProofVerifier} from "./IBorrowFillProofVerifier.sol";

interface IAcrossBorrowFillEventVerifier {
    function verifyBorrowFillRecorded(
        IBorrowFillProofVerifier.BorrowFillWitness calldata witness,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot,
        address sourceReceiver,
        uint256 expectedDestinationChainId,
        address expectedHubDispatcher,
        address expectedHubFinalizer,
        bytes calldata proof
    ) external view returns (bool);
}
