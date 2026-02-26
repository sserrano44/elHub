// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IDepositProofVerifier} from "../interfaces/IDepositProofVerifier.sol";
import {ILightClientVerifier} from "../interfaces/ILightClientVerifier.sol";
import {IAcrossDepositEventVerifier} from "../interfaces/IAcrossDepositEventVerifier.sol";
import {IAcrossDepositProofBackend} from "../interfaces/IAcrossDepositProofBackend.sol";

/// @notice Canonical source-event deposit proof backend.
/// @dev Verifies source finality + source Across event inclusion and binds it to witness + destination receiver.
contract AcrossDepositProofBackend is Ownable, Initializable, UUPSUpgradeable, IAcrossDepositProofBackend {
    ILightClientVerifier public immutable lightClientVerifier;
    IAcrossDepositEventVerifier public immutable eventVerifier;

    mapping(uint256 => address) public sourceSpokePoolByChain;

    event SourceSpokePoolSet(uint256 indexed sourceChainId, address indexed spokePool);

    error InvalidVerifier(address verifier);
    error InvalidSourceSpokePool(uint256 sourceChainId, address spokePool);

    constructor(address owner_, ILightClientVerifier lightClientVerifier_, IAcrossDepositEventVerifier eventVerifier_)
        Ownable(owner_)
    {
        if (address(lightClientVerifier_) == address(0)) revert InvalidVerifier(address(lightClientVerifier_));
        if (address(eventVerifier_) == address(0)) revert InvalidVerifier(address(eventVerifier_));
        lightClientVerifier = lightClientVerifier_;
        eventVerifier = eventVerifier_;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setSourceSpokePool(uint256 sourceChainId, address spokePool) external onlyOwner {
        if (sourceChainId == 0 || spokePool == address(0)) {
            revert InvalidSourceSpokePool(sourceChainId, spokePool);
        }
        sourceSpokePoolByChain[sourceChainId] = spokePool;
        emit SourceSpokePoolSet(sourceChainId, spokePool);
    }

    function verifyCanonicalDeposit(
        IDepositProofVerifier.DepositWitness calldata witness,
        CanonicalSourceProof calldata proof,
        address destinationReceiver,
        uint256 destinationChainId
    ) external view override returns (bool) {
        address expectedSourceSpokePool = sourceSpokePoolByChain[witness.sourceChainId];
        if (expectedSourceSpokePool == address(0)) return false;
        if (proof.sourceSpokePool != expectedSourceSpokePool) return false;

        if (
            !lightClientVerifier.verifyFinalizedBlock(
                witness.sourceChainId, proof.sourceBlockNumber, proof.sourceBlockHash, proof.finalityProof
            )
        ) {
            return false;
        }

        return eventVerifier.verifyV3FundsDeposited(
            witness.sourceChainId,
            proof.sourceBlockHash,
            proof.receiptsRoot,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            proof.sourceSpokePool,
            witness.spokeToken,
            witness.messageHash,
            destinationReceiver,
            destinationChainId,
            witness.hubAsset,
            witness.amount,
            proof.inclusionProof
        );
    }
}
