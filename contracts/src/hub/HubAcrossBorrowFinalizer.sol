// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IBorrowFillProofVerifier} from "../interfaces/IBorrowFillProofVerifier.sol";
import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";
import {HubSettlement} from "./HubSettlement.sol";
import {HubLockManager} from "./HubLockManager.sol";

/// @notice Hub-side proof-gated finalizer for Across outbound fills observed on spoke.
contract HubAcrossBorrowFinalizer is AccessControl, Initializable, UUPSUpgradeable {
    bytes32 public constant FINALIZER_ADMIN_ROLE = keccak256("FINALIZER_ADMIN_ROLE");

    HubSettlement public immutable settlement;
    IBorrowFillProofVerifier public verifier;

    mapping(bytes32 => bool) public usedFinalizationKey;

    event VerifierSet(address indexed verifier);
    event BorrowFillFinalized(
        bytes32 indexed intentId,
        bytes32 indexed finalizationKey,
        uint256 indexed sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        address caller
    );

    error InvalidSettlement(address settlement);
    error InvalidVerifier(address verifier);
    error FinalizationReplay(bytes32 finalizationKey);
    error InvalidBorrowFillProof();

    constructor(address admin, HubSettlement settlement_, IBorrowFillProofVerifier verifier_) {
        if (address(settlement_) == address(0)) revert InvalidSettlement(address(settlement_));
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FINALIZER_ADMIN_ROLE, admin);

        settlement = settlement_;
        verifier = verifier_;

        emit VerifierSet(address(verifier_));
        _disableInitializers();
    }

    function initializeProxy(address admin, IBorrowFillProofVerifier verifier_) external initializer {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FINALIZER_ADMIN_ROLE, admin);

        verifier = verifier_;

        emit VerifierSet(address(verifier_));
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function setVerifier(IBorrowFillProofVerifier verifier_) external onlyRole(FINALIZER_ADMIN_ROLE) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function finalizeBorrowFill(bytes calldata proof, IBorrowFillProofVerifier.BorrowFillWitness calldata witness) external {
        bytes32 finalizationKey = finalizationKeyFor(
            witness.sourceChainId, witness.sourceTxHash, witness.sourceLogIndex, witness.intentId, witness.messageHash
        );
        if (usedFinalizationKey[finalizationKey]) revert FinalizationReplay(finalizationKey);

        if (!verifier.verifyBorrowFillProof(proof, witness)) revert InvalidBorrowFillProof();

        usedFinalizationKey[finalizationKey] = true;

        _recordVerifiedFillEvidence(witness);

        emit BorrowFillFinalized(
            witness.intentId,
            finalizationKey,
            witness.sourceChainId,
            witness.sourceTxHash,
            witness.sourceLogIndex,
            msg.sender
        );
    }

    function _recordVerifiedFillEvidence(IBorrowFillProofVerifier.BorrowFillWitness calldata witness) internal {
        HubLockManager lockManager = settlement.lockManager();
        ITokenRegistry tokenRegistry = lockManager.tokenRegistry();
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfigByHub(witness.hubAsset);
        uint8 spokeDecimals = tokenRegistry.getSpokeDecimalsByHub(witness.sourceChainId, witness.hubAsset);

        uint256 hubAmount = _scaleAmount(witness.amount, spokeDecimals, cfg.decimals);
        uint256 hubFee = _scaleAmount(witness.fee, spokeDecimals, cfg.decimals);
        if (hubAmount == 0 || hubFee >= hubAmount) revert InvalidBorrowFillProof();

        settlement.recordVerifiedFillEvidence(
            witness.intentId,
            witness.intentType,
            witness.user,
            witness.hubAsset,
            hubAmount,
            hubFee,
            witness.relayer
        );
    }

    function finalizationKeyFor(
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 sourceLogIndex,
        bytes32 intentId,
        bytes32 messageHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash, sourceLogIndex, intentId, messageHash));
    }

    function _scaleAmount(uint256 amount, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return amount;
        if (fromDecimals > toDecimals) {
            uint256 divisor = 10 ** uint256(fromDecimals - toDecimals);
            return amount / divisor;
        }

        uint256 multiplier = 10 ** uint256(toDecimals - fromDecimals);
        return amount * multiplier;
    }
}
