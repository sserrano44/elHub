// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";
import {IAcrossDepositProofBackend} from "../interfaces/IAcrossDepositProofBackend.sol";

/// @notice Verifies canonical source-event deposit proofs.
/// @dev Proof must include source finality + source event inclusion payloads bound to witness fields.
contract DepositProofVerifier is IDepositProofVerifier {
    uint8 internal constant CANONICAL_PROOF_SCHEMA_VERSION = 1;

    IAcrossDepositProofBackend public immutable backend;

    error InvalidBackend(address backend);
    error UnsupportedProofVersion(uint8 version);

    constructor(IAcrossDepositProofBackend backend_) {
        if (address(backend_) == address(0)) revert InvalidBackend(address(backend_));
        backend = backend_;
    }

    function verifyDepositProof(bytes calldata proof, DepositWitness calldata witness) external view override returns (bool) {
        if (
            witness.sourceChainId == 0 || witness.depositId == 0 || witness.user == address(0)
                || witness.spokeToken == address(0) || witness.hubAsset == address(0) || witness.amount == 0
                || witness.sourceTxHash == bytes32(0) || witness.messageHash == bytes32(0)
        ) {
            return false;
        }

        (bool ok, IAcrossDepositProofBackend.CanonicalSourceProof memory decoded) = _decodeCanonicalSourceProof(proof);
        if (!ok) return false;

        if (decoded.sourceBlockNumber == 0 || decoded.sourceBlockHash == bytes32(0) || decoded.sourceSpokePool == address(0))
        {
            return false;
        }

        return backend.verifyCanonicalDeposit(witness, decoded, msg.sender, block.chainid);
    }

    function _decodeCanonicalSourceProof(bytes calldata proof)
        internal
        view
        returns (bool ok, IAcrossDepositProofBackend.CanonicalSourceProof memory decoded)
    {
        try this.decodeCanonicalSourceProof(proof) returns (IAcrossDepositProofBackend.CanonicalSourceProof memory parsed) {
            return (true, parsed);
        } catch {
            return (false, decoded);
        }
    }

    function decodeCanonicalSourceProof(bytes calldata proof)
        external
        pure
        returns (IAcrossDepositProofBackend.CanonicalSourceProof memory decoded)
    {
        (uint8 version, bytes memory payload) = abi.decode(proof, (uint8, bytes));
        if (version != CANONICAL_PROOF_SCHEMA_VERSION) revert UnsupportedProofVersion(version);
        decoded = abi.decode(payload, (IAcrossDepositProofBackend.CanonicalSourceProof));
    }
}
