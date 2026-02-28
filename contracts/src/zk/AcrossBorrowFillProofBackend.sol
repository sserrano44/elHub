// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";
import {ILightClientVerifier} from "../interfaces/ILightClientVerifier.sol";
import {IAcrossBorrowFillEventVerifier} from "../interfaces/IAcrossBorrowFillEventVerifier.sol";
import {IAcrossBorrowFillProofBackend} from "../interfaces/IAcrossBorrowFillProofBackend.sol";
import {Constants} from "../libraries/Constants.sol";

/// @notice Canonical source-event backend for outbound fill proofs (borrow/withdraw).
/// @dev Verifies spoke finality + spoke BorrowFillRecorded inclusion and binds the proof to hub finalizer destination.
contract AcrossBorrowFillProofBackend is Ownable, Initializable, UUPSUpgradeable, IAcrossBorrowFillProofBackend {
    ILightClientVerifier public immutable lightClientVerifier;
    IAcrossBorrowFillEventVerifier public immutable eventVerifier;

    mapping(uint256 => address) public sourceReceiverByChain;
    address public destinationDispatcher;

    event SourceReceiverSet(uint256 indexed sourceChainId, address indexed receiver);
    event DestinationDispatcherSet(address indexed destinationDispatcher);

    error InvalidVerifier(address verifier);
    error InvalidSourceReceiver(uint256 sourceChainId, address receiver);
    error InvalidDestinationDispatcher(address destinationDispatcher);

    constructor(
        address owner_,
        ILightClientVerifier lightClientVerifier_,
        IAcrossBorrowFillEventVerifier eventVerifier_
    ) Ownable(owner_) {
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

    function setSourceReceiver(uint256 sourceChainId, address receiver) external onlyOwner {
        if (sourceChainId == 0 || receiver == address(0)) {
            revert InvalidSourceReceiver(sourceChainId, receiver);
        }
        sourceReceiverByChain[sourceChainId] = receiver;
        emit SourceReceiverSet(sourceChainId, receiver);
    }

    function setDestinationDispatcher(address destinationDispatcher_) external onlyOwner {
        if (destinationDispatcher_ == address(0)) revert InvalidDestinationDispatcher(destinationDispatcher_);
        destinationDispatcher = destinationDispatcher_;
        emit DestinationDispatcherSet(destinationDispatcher_);
    }

    function verifyCanonicalBorrowFill(
        IBorrowFillProofVerifier.BorrowFillWitness calldata witness,
        CanonicalSourceProof calldata proof,
        address destinationFinalizer,
        uint256 destinationChainId
    ) external view override returns (bool) {
        if (!_isSupportedIntentType(witness.intentType)) return false;
        if (destinationDispatcher == address(0)) return false;

        address expectedReceiver = sourceReceiverByChain[witness.sourceChainId];
        if (expectedReceiver == address(0)) return false;
        if (proof.sourceReceiver != expectedReceiver) return false;

        if (
            !lightClientVerifier.verifyFinalizedBlock(
                witness.sourceChainId, proof.sourceBlockNumber, proof.sourceBlockHash, proof.finalityProof
            )
        ) {
            return false;
        }

        return eventVerifier.verifyBorrowFillRecorded(
            witness,
            proof.sourceBlockHash,
            proof.receiptsRoot,
            proof.sourceReceiver,
            destinationChainId,
            destinationDispatcher,
            destinationFinalizer,
            proof.inclusionProof
        );
    }

    function _isSupportedIntentType(uint8 intentType) internal pure returns (bool) {
        return intentType == Constants.INTENT_BORROW || intentType == Constants.INTENT_WITHDRAW;
    }
}
