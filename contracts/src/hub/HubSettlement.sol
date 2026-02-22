// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {Constants} from "../libraries/Constants.sol";
import {DataTypes} from "../libraries/DataTypes.sol";
import {ProofHash} from "../libraries/ProofHash.sol";
import {IVerifier} from "../interfaces/IVerifier.sol";
import {HubMoneyMarket} from "./HubMoneyMarket.sol";
import {HubCustody} from "./HubCustody.sol";
import {HubLockManager} from "./HubLockManager.sol";
import {IHubSettlement} from "../interfaces/IHubSettlement.sol";

contract HubSettlement is AccessControl, Pausable, ReentrancyGuard, IHubSettlement {
    bytes32 public constant SETTLEMENT_ADMIN_ROLE = keccak256("SETTLEMENT_ADMIN_ROLE");
    bytes32 public constant PROOF_FILL_ROLE = keccak256("PROOF_FILL_ROLE");

    IVerifier public verifier;
    HubMoneyMarket public moneyMarket;
    HubCustody public custody;
    HubLockManager public lockManager;

    struct FillEvidence {
        uint8 intentType;
        address user;
        address hubAsset;
        uint256 amount;
        uint256 fee;
        address relayer;
        bool exists;
        bool consumed;
    }

    struct FillEvidenceInput {
        uint8 intentType;
        address user;
        address hubAsset;
        uint256 amount;
        uint256 fee;
        address relayer;
    }

    struct LockSnapshot {
        address user;
        uint8 intentType;
        address hubAsset;
        uint256 amount;
        address relayer;
        uint256 expiry;
        uint8 status;
    }

    mapping(uint256 => bool) public batchExecuted;
    mapping(uint256 => mapping(uint256 => bool)) public depositSettled;
    mapping(bytes32 => FillEvidence) public fillEvidence;
    mapping(bytes32 => bool) public intentSettled;

    event VerifierSet(address indexed verifier);
    event MoneyMarketSet(address indexed market);
    event CustodySet(address indexed custody);
    event LockManagerSet(address indexed lockManager);
    event FillEvidenceRecorded(
        bytes32 indexed intentId,
        uint8 indexed intentType,
        address indexed user,
        address hubAsset,
        uint256 amount,
        uint256 fee,
        address relayer
    );
    event RepaySurplusRefunded(uint256 indexed depositId, address indexed user, address indexed hubAsset, uint256 amount);
    event BatchSettled(uint256 indexed batchId, bytes32 indexed actionsRoot, uint256 actionCount);

    error BatchAlreadyExecuted(uint256 batchId);
    error InvalidHubChain(uint256 expected, uint256 got);
    error TooManyActions(uint256 count, uint256 max);
    error InvalidActionsRoot(bytes32 expected, bytes32 got);
    error InvalidProof();
    error DepositAlreadySettled(uint256 spokeChainId, uint256 depositId);
    error IntentAlreadySettled(bytes32 intentId);
    error MissingFillEvidence(bytes32 intentId);
    error FillEvidenceMismatch(bytes32 intentId);
    error FillEvidenceAlreadyExists(bytes32 intentId);
    error FillEvidenceAlreadyConsumed(bytes32 intentId);
    error UnsupportedFillEvidenceIntentType(uint8 intentType);
    error FillEvidenceLockNotActive(bytes32 intentId, uint8 status);
    error FillEvidenceLockExpired(bytes32 intentId, uint256 expiry);
    error FillEvidenceLockMismatch(bytes32 intentId);
    error InvalidVerifier(address verifier);
    error InvalidMoneyMarket(address market);
    error InvalidCustody(address custody);
    error InvalidLockManager(address lockManager);

    constructor(address admin, IVerifier verifier_, HubMoneyMarket moneyMarket_, HubCustody custody_, HubLockManager lockManager_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTLEMENT_ADMIN_ROLE, admin);

        verifier = verifier_;
        moneyMarket = moneyMarket_;
        custody = custody_;
        lockManager = lockManager_;
    }

    function setVerifier(IVerifier verifier_) external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        if (address(verifier_) == address(0)) revert InvalidVerifier(address(verifier_));
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function setMoneyMarket(HubMoneyMarket moneyMarket_) external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        if (address(moneyMarket_) == address(0)) revert InvalidMoneyMarket(address(moneyMarket_));
        moneyMarket = moneyMarket_;
        emit MoneyMarketSet(address(moneyMarket_));
    }

    function setCustody(HubCustody custody_) external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        if (address(custody_) == address(0)) revert InvalidCustody(address(custody_));
        custody = custody_;
        emit CustodySet(address(custody_));
    }

    function setLockManager(HubLockManager lockManager_) external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        if (address(lockManager_) == address(0)) revert InvalidLockManager(address(lockManager_));
        lockManager = lockManager_;
        emit LockManagerSet(address(lockManager_));
    }

    function pause() external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(SETTLEMENT_ADMIN_ROLE) {
        _unpause();
    }

    function recordVerifiedFillEvidence(
        bytes32 intentId,
        uint8 intentType,
        address user,
        address hubAsset,
        uint256 amount,
        uint256 fee,
        address relayer
    ) external onlyRole(PROOF_FILL_ROLE) {
        if (intentType != Constants.INTENT_BORROW && intentType != Constants.INTENT_WITHDRAW) {
            revert UnsupportedFillEvidenceIntentType(intentType);
        }
        _recordFillEvidence(
            intentId,
            FillEvidenceInput({
                intentType: intentType,
                user: user,
                hubAsset: hubAsset,
                amount: amount,
                fee: fee,
                relayer: relayer
            })
        );
    }

    function _recordFillEvidence(bytes32 intentId, FillEvidenceInput memory input) internal {
        LockSnapshot memory lock = _snapshotLock(intentId);

        uint8 lockActiveStatus = lockManager.LOCK_STATUS_ACTIVE();
        if (lock.status != lockActiveStatus) {
            revert FillEvidenceLockNotActive(intentId, lock.status);
        }
        if (block.timestamp > lock.expiry) {
            revert FillEvidenceLockExpired(intentId, lock.expiry);
        }
        if (
            lock.intentType != input.intentType || lock.user != input.user || lock.hubAsset != input.hubAsset
                || lock.amount != input.amount || lock.relayer != input.relayer
        ) {
            revert FillEvidenceLockMismatch(intentId);
        }

        FillEvidence storage ev = fillEvidence[intentId];
        if (ev.exists) {
            if (ev.consumed) revert FillEvidenceAlreadyConsumed(intentId);
            revert FillEvidenceAlreadyExists(intentId);
        }

        fillEvidence[intentId] = FillEvidence({
            intentType: input.intentType,
            user: input.user,
            hubAsset: input.hubAsset,
            amount: input.amount,
            fee: input.fee,
            relayer: input.relayer,
            exists: true,
            consumed: false
        });

        emit FillEvidenceRecorded(
            intentId, input.intentType, input.user, input.hubAsset, input.amount, input.fee, input.relayer
        );
    }

    function _snapshotLock(bytes32 intentId) internal view returns (LockSnapshot memory snapshot) {
        (
            ,
            snapshot.user,
            snapshot.intentType,
            snapshot.hubAsset,
            snapshot.amount,
            snapshot.relayer,
            ,
            snapshot.expiry,
            snapshot.status
        ) = lockManager.locks(intentId);
    }

    function settleBatch(DataTypes.SettlementBatch calldata batch, bytes calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        // Global batch replay protection.
        if (batchExecuted[batch.batchId]) revert BatchAlreadyExecuted(batch.batchId);
        if (batch.hubChainId != block.chainid) {
            revert InvalidHubChain(block.chainid, batch.hubChainId);
        }

        uint256 actionCount = batch.supplyCredits.length + batch.repayCredits.length + batch.borrowFinalizations.length
            + batch.withdrawFinalizations.length;
        if (actionCount > Constants.MAX_BATCH_ACTIONS) {
            revert TooManyActions(actionCount, Constants.MAX_BATCH_ACTIONS);
        }

        bytes32 computedRoot = computeActionsRoot(batch);
        if (computedRoot != batch.actionsRoot) {
            revert InvalidActionsRoot(computedRoot, batch.actionsRoot);
        }

        uint256[] memory publicInputs = new uint256[](4);
        publicInputs[0] = ProofHash.toField(batch.batchId);
        publicInputs[1] = ProofHash.toField(batch.hubChainId);
        publicInputs[2] = ProofHash.toField(batch.spokeChainId);
        publicInputs[3] = ProofHash.toField(uint256(batch.actionsRoot));

        // Verifier interface is stable across dev/prod proof backends.
        if (!verifier.verifyProof(proof, publicInputs)) {
            revert InvalidProof();
        }

        batchExecuted[batch.batchId] = true;

        _applySupplyCredits(batch.spokeChainId, batch.supplyCredits);
        _applyRepayCredits(batch.spokeChainId, batch.repayCredits);
        _applyBorrowFinalizations(batch.borrowFinalizations);
        _applyWithdrawFinalizations(batch.withdrawFinalizations);

        emit BatchSettled(batch.batchId, batch.actionsRoot, actionCount);
    }

    function isIntentSettled(bytes32 intentId) external view returns (bool) {
        return intentSettled[intentId];
    }

    function computeActionsRoot(DataTypes.SettlementBatch calldata batch) public pure returns (bytes32) {
        uint256 actionCount = batch.supplyCredits.length + batch.repayCredits.length + batch.borrowFinalizations.length
            + batch.withdrawFinalizations.length;
        if (actionCount > Constants.MAX_BATCH_ACTIONS) {
            revert TooManyActions(actionCount, Constants.MAX_BATCH_ACTIONS);
        }

        uint256 state = ProofHash.hashPair(ProofHash.toField(batch.batchId), ProofHash.toField(batch.hubChainId));
        state = ProofHash.hashPair(state, ProofHash.toField(batch.spokeChainId));
        state = ProofHash.hashPair(state, actionCount);

        for (uint256 i = 0; i < batch.supplyCredits.length; i++) {
            state = ProofHash.hashPair(state, _hashSupplyCredit(batch.supplyCredits[i]));
        }
        for (uint256 i = 0; i < batch.repayCredits.length; i++) {
            state = ProofHash.hashPair(state, _hashRepayCredit(batch.repayCredits[i]));
        }
        for (uint256 i = 0; i < batch.borrowFinalizations.length; i++) {
            state = ProofHash.hashPair(state, _hashBorrowFinalize(batch.borrowFinalizations[i]));
        }
        for (uint256 i = 0; i < batch.withdrawFinalizations.length; i++) {
            state = ProofHash.hashPair(state, _hashWithdrawFinalize(batch.withdrawFinalizations[i]));
        }

        // Pad to a fixed action width for stable circuit witness shape.
        for (uint256 i = actionCount; i < Constants.MAX_BATCH_ACTIONS; i++) {
            state = ProofHash.hashPair(state, 0);
        }

        return bytes32(state);
    }

    function _hashSupplyCredit(DataTypes.SupplyCredit calldata action) internal pure returns (uint256) {
        uint256 h = ProofHash.hashPair(Constants.INTENT_SUPPLY, action.depositId);
        h = ProofHash.hashPair(h, uint256(uint160(action.user)));
        h = ProofHash.hashPair(h, uint256(uint160(action.hubAsset)));
        return ProofHash.hashPair(h, action.amount);
    }

    function _hashRepayCredit(DataTypes.RepayCredit calldata action) internal pure returns (uint256) {
        uint256 h = ProofHash.hashPair(Constants.INTENT_REPAY, action.depositId);
        h = ProofHash.hashPair(h, uint256(uint160(action.user)));
        h = ProofHash.hashPair(h, uint256(uint160(action.hubAsset)));
        return ProofHash.hashPair(h, action.amount);
    }

    function _hashBorrowFinalize(DataTypes.BorrowFinalize calldata action) internal pure returns (uint256) {
        uint256 h = ProofHash.hashPair(Constants.INTENT_BORROW, uint256(action.intentId));
        h = ProofHash.hashPair(h, uint256(uint160(action.user)));
        h = ProofHash.hashPair(h, uint256(uint160(action.hubAsset)));
        h = ProofHash.hashPair(h, action.amount);
        h = ProofHash.hashPair(h, action.fee);
        return ProofHash.hashPair(h, uint256(uint160(action.relayer)));
    }

    function _hashWithdrawFinalize(DataTypes.WithdrawFinalize calldata action) internal pure returns (uint256) {
        uint256 h = ProofHash.hashPair(Constants.INTENT_WITHDRAW, uint256(action.intentId));
        h = ProofHash.hashPair(h, uint256(uint160(action.user)));
        h = ProofHash.hashPair(h, uint256(uint160(action.hubAsset)));
        h = ProofHash.hashPair(h, action.amount);
        h = ProofHash.hashPair(h, action.fee);
        return ProofHash.hashPair(h, uint256(uint160(action.relayer)));
    }

    function _applySupplyCredits(uint256 spokeChainId, DataTypes.SupplyCredit[] calldata credits) internal {
        for (uint256 i = 0; i < credits.length; i++) {
            DataTypes.SupplyCredit calldata sc = credits[i];
            if (depositSettled[spokeChainId][sc.depositId]) revert DepositAlreadySettled(spokeChainId, sc.depositId);
            depositSettled[spokeChainId][sc.depositId] = true;

            // Deposit must already exist in custody (bridged) before crediting market accounting.
            custody.consumeDepositToMarket(
                spokeChainId,
                sc.depositId,
                Constants.INTENT_SUPPLY,
                sc.user,
                sc.hubAsset,
                sc.amount,
                address(moneyMarket)
            );

            moneyMarket.settlementCreditSupply(sc.user, sc.hubAsset, sc.amount);
        }
    }

    function _applyRepayCredits(uint256 spokeChainId, DataTypes.RepayCredit[] calldata credits) internal {
        for (uint256 i = 0; i < credits.length; i++) {
            DataTypes.RepayCredit calldata rc = credits[i];
            if (depositSettled[spokeChainId][rc.depositId]) revert DepositAlreadySettled(spokeChainId, rc.depositId);
            depositSettled[spokeChainId][rc.depositId] = true;

            custody.consumeDepositToMarket(
                spokeChainId,
                rc.depositId,
                Constants.INTENT_REPAY,
                rc.user,
                rc.hubAsset,
                rc.amount,
                address(moneyMarket)
            );

            uint256 actualRepay = moneyMarket.settlementCreditRepay(rc.user, rc.hubAsset, rc.amount);
            if (actualRepay < rc.amount) {
                uint256 surplus = rc.amount - actualRepay;
                moneyMarket.settlementRefund(rc.hubAsset, rc.user, surplus);
                emit RepaySurplusRefunded(rc.depositId, rc.user, rc.hubAsset, surplus);
            }
        }
    }

    function _applyBorrowFinalizations(DataTypes.BorrowFinalize[] calldata actions) internal {
        for (uint256 i = 0; i < actions.length; i++) {
            DataTypes.BorrowFinalize calldata action = actions[i];
            if (intentSettled[action.intentId]) revert IntentAlreadySettled(action.intentId);

            FillEvidence storage ev = fillEvidence[action.intentId];
            if (!ev.exists) revert MissingFillEvidence(action.intentId);
            if (ev.consumed) revert FillEvidenceAlreadyConsumed(action.intentId);
            if (
                ev.intentType != Constants.INTENT_BORROW || ev.user != action.user || ev.hubAsset != action.hubAsset
                    || ev.amount != action.amount || ev.fee != action.fee || ev.relayer != action.relayer
            ) {
                revert FillEvidenceMismatch(action.intentId);
            }
            ev.consumed = true;
            intentSettled[action.intentId] = true;

            // Lock consumption enforces hub-side reservation + relayer binding.
            lockManager.consumeLock(
                action.intentId,
                Constants.INTENT_BORROW,
                action.user,
                action.hubAsset,
                action.amount,
                action.relayer
            );

            moneyMarket.settlementFinalizeBorrow(action.user, action.hubAsset, action.amount, action.relayer, action.fee);
        }
    }

    function _applyWithdrawFinalizations(DataTypes.WithdrawFinalize[] calldata actions) internal {
        for (uint256 i = 0; i < actions.length; i++) {
            DataTypes.WithdrawFinalize calldata action = actions[i];
            if (intentSettled[action.intentId]) revert IntentAlreadySettled(action.intentId);

            FillEvidence storage ev = fillEvidence[action.intentId];
            if (!ev.exists) revert MissingFillEvidence(action.intentId);
            if (ev.consumed) revert FillEvidenceAlreadyConsumed(action.intentId);
            if (
                ev.intentType != Constants.INTENT_WITHDRAW || ev.user != action.user || ev.hubAsset != action.hubAsset
                    || ev.amount != action.amount || ev.fee != action.fee || ev.relayer != action.relayer
            ) {
                revert FillEvidenceMismatch(action.intentId);
            }
            ev.consumed = true;
            intentSettled[action.intentId] = true;

            lockManager.consumeLock(
                action.intentId,
                Constants.INTENT_WITHDRAW,
                action.user,
                action.hubAsset,
                action.amount,
                action.relayer
            );

            moneyMarket.settlementFinalizeWithdraw(action.user, action.hubAsset, action.amount, action.relayer, action.fee);
        }
    }
}
