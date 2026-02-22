// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";
import {IAcrossBorrowFillProofBackend} from "../interfaces/IAcrossBorrowFillProofBackend.sol";
import {Constants} from "../libraries/Constants.sol";

/// @notice Verifies canonical source-event outbound fill proofs (borrow/withdraw).
/// @dev Proof includes source finality and source receiver event inclusion payloads.
contract BorrowFillProofVerifier is IBorrowFillProofVerifier {
    IAcrossBorrowFillProofBackend public immutable backend;

    error InvalidBackend(address backend);

    constructor(IAcrossBorrowFillProofBackend backend_) {
        if (address(backend_) == address(0)) revert InvalidBackend(address(backend_));
        backend = backend_;
    }

    function verifyBorrowFillProof(bytes calldata proof, BorrowFillWitness calldata witness)
        external
        view
        override
        returns (bool)
    {
        if (
            witness.sourceChainId == 0 || witness.intentId == bytes32(0) || !_isSupportedIntentType(witness.intentType)
                || witness.user == address(0) || witness.recipient == address(0) || witness.spokeToken == address(0)
                || witness.hubAsset == address(0) || witness.relayer == address(0) || witness.amount == 0
                || witness.fee >= witness.amount || witness.sourceTxHash == bytes32(0) || witness.messageHash == bytes32(0)
        ) {
            return false;
        }

        (bool ok, IAcrossBorrowFillProofBackend.CanonicalSourceProof memory decoded) = _decodeCanonicalSourceProof(proof);
        if (!ok) return false;

        if (decoded.sourceBlockNumber == 0 || decoded.sourceBlockHash == bytes32(0) || decoded.sourceReceiver == address(0)) {
            return false;
        }

        return backend.verifyCanonicalBorrowFill(witness, decoded, msg.sender, block.chainid);
    }

    function _decodeCanonicalSourceProof(bytes calldata proof)
        internal
        view
        returns (bool ok, IAcrossBorrowFillProofBackend.CanonicalSourceProof memory decoded)
    {
        try this.decodeCanonicalSourceProof(proof) returns (IAcrossBorrowFillProofBackend.CanonicalSourceProof memory parsed) {
            return (true, parsed);
        } catch {
            return (false, decoded);
        }
    }

    function decodeCanonicalSourceProof(bytes calldata proof)
        external
        pure
        returns (IAcrossBorrowFillProofBackend.CanonicalSourceProof memory decoded)
    {
        decoded = abi.decode(proof, (IAcrossBorrowFillProofBackend.CanonicalSourceProof));
    }

    function _isSupportedIntentType(uint8 intentType) internal pure returns (bool) {
        return intentType == Constants.INTENT_BORROW || intentType == Constants.INTENT_WITHDRAW;
    }
}
