// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {DataTypes} from "../src/libraries/DataTypes.sol";
import {IntentHasher} from "../src/libraries/IntentHasher.sol";
import {Constants} from "../src/libraries/Constants.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";
import {TokenRegistry} from "../src/hub/TokenRegistry.sol";
import {KinkInterestRateModel} from "../src/hub/KinkInterestRateModel.sol";
import {HubMoneyMarket} from "../src/hub/HubMoneyMarket.sol";
import {HubRiskManager} from "../src/hub/HubRiskManager.sol";
import {HubIntentInbox} from "../src/hub/HubIntentInbox.sol";
import {HubLockManager} from "../src/hub/HubLockManager.sol";
import {HubCustody} from "../src/hub/HubCustody.sol";
import {HubSettlement} from "../src/hub/HubSettlement.sol";
import {ITokenRegistry} from "../src/interfaces/ITokenRegistry.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {SpokePortal} from "../src/spoke/SpokePortal.sol";
import {MockBridgeAdapter} from "../src/spoke/MockBridgeAdapter.sol";
import {Verifier} from "../src/zk/Verifier.sol";
import {Groth16VerifierAdapter} from "../src/zk/Groth16VerifierAdapter.sol";

contract ProofBoundGeneratedVerifier {
    function verifyProof(uint256[2] calldata pA, uint256[2][2] calldata, uint256[2] calldata pC, uint256[4] calldata pubSignals)
        external
        pure
        returns (bool)
    {
        return pA[0] == pubSignals[0] && pA[1] == pubSignals[3] && pC[0] == pubSignals[1] && pC[1] == pubSignals[2];
    }
}

contract HubProtocolTest is TestBase {
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant RELAYER_PK = 0xB0B;
    uint256 internal constant BRIDGE_PK = 0xCAFE;

    bytes internal constant DEV_PROOF = "ZKHUB_DEV_PROOF";

    address internal user;
    address internal relayer;
    address internal bridgeOperator;
    address internal liquidator;

    MockERC20 internal hubUSDC;
    MockERC20 internal spokeUSDC;
    MockERC20 internal hubWETH;
    MockERC20 internal spokeWETH;

    TokenRegistry internal registry;
    MockOracle internal oracle;
    KinkInterestRateModel internal rateModel;
    HubMoneyMarket internal market;
    HubRiskManager internal risk;
    HubIntentInbox internal inbox;
    HubLockManager internal lockManager;
    HubCustody internal custody;
    Verifier internal verifier;
    HubSettlement internal settlement;

    SpokePortal internal portal;
    MockBridgeAdapter internal bridgeAdapter;
    uint256 internal nextAttestationLogIndex = 1;

    function setUp() external {
        user = vm.addr(USER_PK);
        relayer = vm.addr(RELAYER_PK);
        bridgeOperator = vm.addr(BRIDGE_PK);
        liquidator = vm.addr(0xD1CE);

        hubUSDC = new MockERC20("Hub USDC", "USDC", 6);
        spokeUSDC = new MockERC20("Spoke USDC", "USDC", 6);
        hubWETH = new MockERC20("Hub WETH", "WETH", 18);
        spokeWETH = new MockERC20("Spoke WETH", "WETH", 18);

        registry = new TokenRegistry(address(this));
        oracle = new MockOracle(address(this));

        rateModel = new KinkInterestRateModel(
            address(this),
            3170979198e9, // ~10% APR
            6341958396e9, // +20% APR to kink
            19025875190e9, // +60% APR after kink
            8e26,
            1e26 // 10% reserve factor
        );

        market = new HubMoneyMarket(address(this), registry, rateModel);
        risk = new HubRiskManager(address(this), registry, market, IPriceOracle(address(oracle)));
        inbox = new HubIntentInbox(address(this));
        lockManager = new HubLockManager(address(this), inbox, registry, risk, market);
        custody = new HubCustody(address(this));

        verifier = new Verifier(address(this), true, keccak256(DEV_PROOF), address(0), 4);
        settlement = new HubSettlement(address(this), verifier, market, custody, lockManager);

        portal = new SpokePortal(address(this), 8453);
        bridgeAdapter = new MockBridgeAdapter(address(this));

        _wireSystem();
        _seedBalances();
    }

    function test_interestAccrual_indicesMonotonic_andShareAccounting() external {
        uint256 supplyAmount = 1_000e6;
        uint256 borrowAmount = 400e6;

        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);

        vm.prank(user);
        market.supply(address(hubUSDC), supplyAmount, user);

        vm.prank(user);
        market.borrow(address(hubUSDC), borrowAmount, user);

        (, , uint256 supplyIndexBefore, uint256 borrowIndexBefore,, uint40 lastAccrualBefore,) =
            market.markets(address(hubUSDC));

        vm.warp(block.timestamp + 365 days);
        market.accrueInterest(address(hubUSDC));

        (, , uint256 supplyIndexAfter, uint256 borrowIndexAfter,, uint40 lastAccrualAfter,) =
            market.markets(address(hubUSDC));

        assertGt(borrowIndexAfter, borrowIndexBefore, "borrow index should increase");
        assertGt(supplyIndexAfter, supplyIndexBefore, "supply index should increase");
        assertGt(lastAccrualAfter, lastAccrualBefore, "last accrual should increase");

        uint256 userSupply = market.getUserSupply(user, address(hubUSDC));
        uint256 userDebt = market.getUserDebt(user, address(hubUSDC));

        assertTrue(userSupply >= supplyAmount, "supply should not decrease");
        assertGt(userDebt, borrowAmount, "debt assets should accrue");
    }

    function test_actionsRoot_isSnarkFieldElement() external view {
        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 42,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });

        bytes32 root = settlement.computeActionsRoot(batch);
        assertTrue(
            uint256(root) < Constants.SNARK_SCALAR_FIELD,
            "actions root must fit SNARK scalar field for production verifier"
        );
    }

    function test_prodVerifierPath_settlementRejectsTamperedProofAndAcceptsValid() external {
        ProofBoundGeneratedVerifier generated = new ProofBoundGeneratedVerifier();
        Groth16VerifierAdapter adapter = new Groth16VerifierAdapter(address(this), address(generated));
        Verifier prodVerifier = new Verifier(address(this), false, bytes32(0), address(adapter), 4);
        settlement.setVerifier(prodVerifier);

        uint256 depositId = 77_001;
        uint256 amount = 25e6;

        hubUSDC.mint(address(custody), amount);
        _registerAttestedDeposit(depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), amount);

        DataTypes.SupplyCredit[] memory supplyCredits = new DataTypes.SupplyCredit[](1);
        supplyCredits[0] = DataTypes.SupplyCredit({
            depositId: depositId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: amount
        });

        DataTypes.SettlementBatch memory badBatch = DataTypes.SettlementBatch({
            batchId: 99,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        badBatch.actionsRoot = settlement.computeActionsRoot(badBatch);

        uint256[2] memory badA = [uint256(123), uint256(456)];
        uint256[2][2] memory badB = [[uint256(0), uint256(0)], [uint256(0), uint256(0)]];
        uint256[2] memory badC = [uint256(789), uint256(101112)];
        bytes memory invalidProof = abi.encode(badA, badB, badC);
        vm.expectRevert(abi.encodeWithSelector(HubSettlement.InvalidProof.selector));
        settlement.settleBatch(badBatch, invalidProof);

        DataTypes.SettlementBatch memory goodBatch = DataTypes.SettlementBatch({
            batchId: 100,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        goodBatch.actionsRoot = settlement.computeActionsRoot(goodBatch);

        uint256[2] memory goodA = [uint256(goodBatch.batchId), uint256(goodBatch.actionsRoot)];
        uint256[2][2] memory goodB = [[uint256(0), uint256(0)], [uint256(0), uint256(0)]];
        uint256[2] memory goodC = [uint256(goodBatch.hubChainId), uint256(goodBatch.spokeChainId)];
        bytes memory validProof = abi.encode(goodA, goodB, goodC);
        settlement.settleBatch(goodBatch, validProof);

        uint256 supplied = market.getUserSupply(user, address(hubUSDC));
        assertEq(supplied, amount, "valid prod verifier proof should allow settlement");
    }

    function test_lockBorrowFailsWhenHealthFactorTooLow() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 100e6, user);

        DataTypes.Intent memory intent = _makeIntent(Constants.INTENT_BORROW, 90e6, 0);
        bytes memory sig = _signIntent(intent);

        vm.startPrank(relayer);
        vm.expectRevert();
        lockManager.lock(intent, sig);
        vm.stopPrank();
    }

    function test_lockWithdrawFailsWhenHealthFactorTooLow() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 100e6, user);

        vm.prank(user);
        market.borrow(address(hubUSDC), 70e6, user);

        DataTypes.Intent memory intent = _makeIntent(Constants.INTENT_WITHDRAW, 40e6, 1);
        bytes memory sig = _signIntent(intent);

        vm.startPrank(relayer);
        vm.expectRevert();
        lockManager.lock(intent, sig);
        vm.stopPrank();
    }

    function test_supplyThenBorrowLockFillSettleHappyPath() external {
        uint256 supplyAmount = 200e6;

        vm.prank(user);
        spokeUSDC.approve(address(portal), type(uint256).max);

        vm.prank(user);
        uint256 depositId = portal.initiateSupply(address(spokeUSDC), supplyAmount, user);

        hubUSDC.mint(address(custody), supplyAmount);

        _registerAttestedDeposit(depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), supplyAmount);

        DataTypes.SupplyCredit[] memory supplyCredits = new DataTypes.SupplyCredit[](1);
        supplyCredits[0] = DataTypes.SupplyCredit({
            depositId: depositId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: supplyAmount
        });

        DataTypes.RepayCredit[] memory repayCredits = new DataTypes.RepayCredit[](0);
        DataTypes.BorrowFinalize[] memory borrows = new DataTypes.BorrowFinalize[](0);
        DataTypes.WithdrawFinalize[] memory withdraws = new DataTypes.WithdrawFinalize[](0);

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 1,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: repayCredits,
            borrowFinalizations: borrows,
            withdrawFinalizations: withdraws
        });

        batch.actionsRoot = settlement.computeActionsRoot(batch);
        settlement.settleBatch(batch, DEV_PROOF);

        uint256 creditedCollateral = market.getUserSupply(user, address(hubUSDC));
        assertEq(creditedCollateral, supplyAmount, "supply should be credited after settlement");

        uint256 borrowAmount = 100e6;
        uint256 relayerFee = 1e6;

        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, borrowAmount, 2);
        bytes memory borrowSig = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, borrowSig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(
            intentId,
            Constants.INTENT_BORROW,
            user,
            address(hubUSDC),
            borrowAmount,
            relayerFee,
            relayer
        );

        DataTypes.SupplyCredit[] memory noSupply = new DataTypes.SupplyCredit[](0);
        DataTypes.RepayCredit[] memory noRepay = new DataTypes.RepayCredit[](0);
        DataTypes.BorrowFinalize[] memory borrowFinal = new DataTypes.BorrowFinalize[](1);
        borrowFinal[0] = DataTypes.BorrowFinalize({
            intentId: intentId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: borrowAmount,
            fee: relayerFee,
            relayer: relayer
        });
        DataTypes.WithdrawFinalize[] memory noWithdraw = new DataTypes.WithdrawFinalize[](0);

        DataTypes.SettlementBatch memory borrowBatch = DataTypes.SettlementBatch({
            batchId: 2,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: noSupply,
            repayCredits: noRepay,
            borrowFinalizations: borrowFinal,
            withdrawFinalizations: noWithdraw
        });

        borrowBatch.actionsRoot = settlement.computeActionsRoot(borrowBatch);

        uint256 relayerHubBefore = hubUSDC.balanceOf(relayer);
        settlement.settleBatch(borrowBatch, DEV_PROOF);

        uint256 relayerHubAfter = hubUSDC.balanceOf(relayer);
        assertEq(relayerHubAfter, relayerHubBefore + borrowAmount, "relayer reimbursement should occur on hub");

        assertTrue(settlement.isIntentSettled(intentId), "intent should be settled");
        (,,,,,,,, uint8 lockStatus) = lockManager.locks(intentId);
        assertEq(uint256(lockStatus), uint256(2), "lock must be consumed");

        uint256 userDebt = market.getUserDebt(user, address(hubUSDC));
        assertGt(userDebt, 0, "user debt should exist after finalize");
    }

    function test_replayProtection_batchIntentAndFill() external {
        uint256 supplyAmount = 50e6;

        vm.prank(user);
        spokeUSDC.approve(address(portal), type(uint256).max);

        vm.prank(user);
        uint256 depositId = portal.initiateSupply(address(spokeUSDC), supplyAmount, user);

        hubUSDC.mint(address(custody), supplyAmount);
        _registerAttestedDeposit(depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), supplyAmount);

        DataTypes.SupplyCredit[] memory supplyCredits = new DataTypes.SupplyCredit[](1);
        supplyCredits[0] = DataTypes.SupplyCredit(depositId, user, address(hubUSDC), supplyAmount);

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 77,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        settlement.settleBatch(batch, DEV_PROOF);

        vm.expectRevert();
        settlement.settleBatch(batch, DEV_PROOF);

        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, 10e6, 8);
        bytes memory borrowSig = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, borrowSig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), borrowIntent.amount, 0, relayer);

        vm.prank(relayer);
        vm.expectRevert();
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), borrowIntent.amount, 0, relayer);

        DataTypes.BorrowFinalize[] memory actions = new DataTypes.BorrowFinalize[](1);
        actions[0] = DataTypes.BorrowFinalize(intentId, user, address(hubUSDC), borrowIntent.amount, 0, relayer);

        DataTypes.SettlementBatch memory borrowBatch = DataTypes.SettlementBatch({
            batchId: 78,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: actions,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        borrowBatch.actionsRoot = settlement.computeActionsRoot(borrowBatch);

        settlement.settleBatch(borrowBatch, DEV_PROOF);

        DataTypes.SettlementBatch memory replayIntentBatch = DataTypes.SettlementBatch({
            batchId: 79,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: actions,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        replayIntentBatch.actionsRoot = settlement.computeActionsRoot(replayIntentBatch);

        vm.expectRevert();
        settlement.settleBatch(replayIntentBatch, DEV_PROOF);
    }

    function test_partialBorrowFill_canSettleBelowLockAmount() external {
        uint256 collateralAmount = 200e6;
        uint256 lockedAmount = 100e6;
        uint256 filledAmount = 95e6;
        uint256 relayerFee = 1e6;

        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), collateralAmount, user);

        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, lockedAmount, 9101);
        bytes memory borrowSig = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, borrowSig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(
            intentId,
            Constants.INTENT_BORROW,
            user,
            address(hubUSDC),
            filledAmount,
            relayerFee,
            relayer
        );

        DataTypes.BorrowFinalize[] memory borrowFinal = new DataTypes.BorrowFinalize[](1);
        borrowFinal[0] = DataTypes.BorrowFinalize({
            intentId: intentId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: filledAmount,
            fee: relayerFee,
            relayer: relayer
        });

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 9_500,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: borrowFinal,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        settlement.settleBatch(batch, DEV_PROOF);

        assertEq(market.getUserDebt(user, address(hubUSDC)), filledAmount, "debt should equal filled amount");
        assertTrue(settlement.isIntentSettled(intentId), "intent should be settled");
    }

    function test_partialBorrowFill_rejectsWhenFillAmountExceedsLock() external {
        uint256 collateralAmount = 200e6;
        uint256 lockedAmount = 100e6;

        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), collateralAmount, user);

        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, lockedAmount, 9102);
        bytes memory borrowSig = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, borrowSig);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubSettlement.FillEvidenceLockMismatch.selector, intentId));
        settlement.recordVerifiedFillEvidence(
            intentId,
            Constants.INTENT_BORROW,
            user,
            address(hubUSDC),
            lockedAmount + 1,
            0,
            relayer
        );
    }

    function test_settlementAllowsSameDepositIdAcrossDifferentSpokeChains() external {
        uint256 depositId = 42_424;
        uint256 amountChainA = 25e6;
        uint256 amountChainB = 35e6;
        uint256 chainA = 480;
        uint256 chainB = 481;

        hubUSDC.mint(address(custody), amountChainA + amountChainB);
        _registerAttestedDepositForChain(chainA, depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), amountChainA);
        _registerAttestedDepositForChain(chainB, depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), amountChainB);

        DataTypes.SupplyCredit[] memory chainASupply = new DataTypes.SupplyCredit[](1);
        chainASupply[0] = DataTypes.SupplyCredit({
            depositId: depositId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: amountChainA
        });

        DataTypes.SettlementBatch memory batchA = DataTypes.SettlementBatch({
            batchId: 9_300,
            hubChainId: block.chainid,
            spokeChainId: chainA,
            actionsRoot: bytes32(0),
            supplyCredits: chainASupply,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batchA.actionsRoot = settlement.computeActionsRoot(batchA);
        settlement.settleBatch(batchA, DEV_PROOF);

        assertEq(market.getUserSupply(user, address(hubUSDC)), amountChainA, "chain A supply should settle");
        assertTrue(settlement.depositSettled(chainA, depositId), "chain A deposit must be marked settled");
        assertTrue(!settlement.depositSettled(chainB, depositId), "chain B deposit must remain unsettled");

        DataTypes.SupplyCredit[] memory chainBSupply = new DataTypes.SupplyCredit[](1);
        chainBSupply[0] = DataTypes.SupplyCredit({
            depositId: depositId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: amountChainB
        });

        DataTypes.SettlementBatch memory batchB = DataTypes.SettlementBatch({
            batchId: 9_301,
            hubChainId: block.chainid,
            spokeChainId: chainB,
            actionsRoot: bytes32(0),
            supplyCredits: chainBSupply,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batchB.actionsRoot = settlement.computeActionsRoot(batchB);
        settlement.settleBatch(batchB, DEV_PROOF);

        assertEq(
            market.getUserSupply(user, address(hubUSDC)),
            amountChainA + amountChainB,
            "supplies from both chains should be credited"
        );
        assertTrue(settlement.depositSettled(chainB, depositId), "chain B deposit must be marked settled");

        (,,,, bool consumedA) = custody.deposits(chainA, depositId);
        (,,,, bool consumedB) = custody.deposits(chainB, depositId);
        assertTrue(consumedA, "chain A deposit should be consumed");
        assertTrue(consumedB, "chain B deposit should be consumed");
    }

    function test_failurePaths_missingLockMissingFillExpiredIntent() external {
        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, 10e6, 50);
        bytes32 intentId = IntentHasher.rawIntentId(borrowIntent);

        uint8 lockStatusNone = lockManager.LOCK_STATUS_NONE();
        vm.expectRevert(
            abi.encodeWithSelector(
                HubSettlement.FillEvidenceLockNotActive.selector, intentId, lockStatusNone
            )
        );
        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), borrowIntent.amount, 0, relayer);

        DataTypes.BorrowFinalize[] memory noLockAction = new DataTypes.BorrowFinalize[](1);
        noLockAction[0] = DataTypes.BorrowFinalize(intentId, user, address(hubUSDC), borrowIntent.amount, 0, relayer);

        DataTypes.SettlementBatch memory noLockBatch = DataTypes.SettlementBatch({
            batchId: 100,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: noLockAction,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        noLockBatch.actionsRoot = settlement.computeActionsRoot(noLockBatch);

        vm.expectRevert(abi.encodeWithSelector(HubSettlement.MissingFillEvidence.selector, intentId));
        settlement.settleBatch(noLockBatch, DEV_PROOF);

        DataTypes.Intent memory lockNoFillIntent = _makeIntent(Constants.INTENT_BORROW, 5e6, 51);
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 100e6, user);

        bytes memory sig = _signIntent(lockNoFillIntent);

        vm.prank(relayer);
        bytes32 lockedIntentId = lockManager.lock(lockNoFillIntent, sig);

        DataTypes.BorrowFinalize[] memory missingFillAction = new DataTypes.BorrowFinalize[](1);
        missingFillAction[0] = DataTypes.BorrowFinalize(lockedIntentId, user, address(hubUSDC), lockNoFillIntent.amount, 0, relayer);

        DataTypes.SettlementBatch memory missingFillBatch = DataTypes.SettlementBatch({
            batchId: 101,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: missingFillAction,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        missingFillBatch.actionsRoot = settlement.computeActionsRoot(missingFillBatch);

        vm.expectRevert();
        settlement.settleBatch(missingFillBatch, DEV_PROOF);

        DataTypes.Intent memory expiredIntent = _makeIntent(Constants.INTENT_BORROW, 1e6, 52);
        expiredIntent.deadline = block.timestamp - 1;
        bytes memory expiredSig = _signIntent(expiredIntent);

        vm.prank(relayer);
        vm.expectRevert();
        lockManager.lock(expiredIntent, expiredSig);
    }

    function test_supplyCapEnforcedOnDirectSupplyAndSettlementCredit() external {
        risk.setRiskParamsFlat(address(hubUSDC), 7500, 8000, 10500, 150e6, 10_000_000e6);

        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);

        vm.prank(user);
        market.supply(address(hubUSDC), 100e6, user);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.SupplyNotAllowed.selector));
        market.supply(address(hubUSDC), 60e6, user);

        uint256 depositId = 12_001;
        uint256 settlementAmount = 60e6;
        hubUSDC.mint(address(custody), settlementAmount);
        _registerAttestedDeposit(depositId, Constants.INTENT_SUPPLY, user, address(hubUSDC), settlementAmount);

        DataTypes.SupplyCredit[] memory supplyCredits = new DataTypes.SupplyCredit[](1);
        supplyCredits[0] = DataTypes.SupplyCredit({
            depositId: depositId,
            user: user,
            hubAsset: address(hubUSDC),
            amount: settlementAmount
        });

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 12_002,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.SupplyNotAllowed.selector));
        settlement.settleBatch(batch, DEV_PROOF);

        assertEq(market.getUserSupply(user, address(hubUSDC)), 100e6, "supply must remain capped");
    }

    function test_settlementRepayRefundsSurplusToUser() external {
        uint256 borrowAmount = 50e6;
        uint256 repayCreditAmount = 80e6;
        uint256 depositId = 12_010;

        vm.startPrank(user);
        hubWETH.approve(address(market), type(uint256).max);
        market.supply(address(hubWETH), 10e18, user);
        market.borrow(address(hubUSDC), borrowAmount, user);
        vm.stopPrank();

        hubUSDC.mint(address(custody), repayCreditAmount);
        _registerAttestedDeposit(depositId, Constants.INTENT_REPAY, user, address(hubUSDC), repayCreditAmount);

        uint256 debtBefore = market.getUserDebt(user, address(hubUSDC));
        uint256 userUsdcBefore = hubUSDC.balanceOf(user);
        uint256 marketUsdcBefore = hubUSDC.balanceOf(address(market));

        DataTypes.RepayCredit[] memory repayCredits = new DataTypes.RepayCredit[](1);
        repayCredits[0] =
            DataTypes.RepayCredit({depositId: depositId, user: user, hubAsset: address(hubUSDC), amount: repayCreditAmount});

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 12_011,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: repayCredits,
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        settlement.settleBatch(batch, DEV_PROOF);

        uint256 surplus = repayCreditAmount - debtBefore;
        assertEq(market.getUserDebt(user, address(hubUSDC)), 0, "repay credit should clear all debt");
        assertEq(
            hubUSDC.balanceOf(user) - userUsdcBefore,
            surplus,
            "surplus repay amount should be refunded to user"
        );
        assertEq(
            hubUSDC.balanceOf(address(market)) - marketUsdcBefore,
            debtBefore,
            "market should retain only actual repay amount"
        );
    }

    function test_settlementBorrowRechecksRiskAtFinalization() external {
        uint256 borrowAmount = 2_000e6;

        vm.prank(user);
        hubWETH.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubWETH), 1 ether, user);

        DataTypes.Intent memory borrowIntent = _makeIntent(Constants.INTENT_BORROW, borrowAmount, 620);
        bytes memory borrowSig = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, borrowSig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), borrowAmount, 0, relayer);

        oracle.setPrice(address(hubWETH), 2_000e8);

        DataTypes.BorrowFinalize[] memory actions = new DataTypes.BorrowFinalize[](1);
        actions[0] = DataTypes.BorrowFinalize(intentId, user, address(hubUSDC), borrowAmount, 0, relayer);

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 12_003,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: actions,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.BorrowNotAllowed.selector));
        settlement.settleBatch(batch, DEV_PROOF);

        assertTrue(!settlement.isIntentSettled(intentId), "borrow intent should not settle if risk changed");
        (,,,,,,,, uint8 status) = lockManager.locks(intentId);
        assertEq(uint256(status), uint256(1), "lock should remain active after reverted settlement");
    }

    function test_settlementWithdrawRechecksRiskAtFinalization() external {
        uint256 withdrawAmount = 0.1 ether;

        vm.prank(user);
        hubWETH.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubWETH), 1 ether, user);

        vm.prank(user);
        market.borrow(address(hubUSDC), 1_000e6, user);

        DataTypes.Intent memory withdrawIntent = _makeIntent(Constants.INTENT_WITHDRAW, withdrawAmount, 621);
        withdrawIntent.outputToken = address(spokeWETH);
        bytes memory withdrawSig = _signIntent(withdrawIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(withdrawIntent, withdrawSig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(
            intentId, Constants.INTENT_WITHDRAW, user, address(hubWETH), withdrawAmount, 0, relayer
        );

        oracle.setPrice(address(hubWETH), 1_300e8);

        DataTypes.WithdrawFinalize[] memory actions = new DataTypes.WithdrawFinalize[](1);
        actions[0] = DataTypes.WithdrawFinalize(intentId, user, address(hubWETH), withdrawAmount, 0, relayer);

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 12_004,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: actions
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.WithdrawNotAllowed.selector));
        settlement.settleBatch(batch, DEV_PROOF);

        assertTrue(!settlement.isIntentSettled(intentId), "withdraw intent should not settle if risk changed");
        (,,,,,,,, uint8 status) = lockManager.locks(intentId);
        assertEq(uint256(status), uint256(1), "lock should remain active after reverted settlement");
    }

    function test_lockRejectsUnregisteredOutputAsset() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 100e6, user);

        DataTypes.Intent memory intent = _makeIntent(Constants.INTENT_BORROW, 10e6, 630);
        intent.outputToken = address(0x123456);
        bytes memory sig = _signIntent(intent);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubLockManager.UnsupportedAsset.selector, intent.outputToken));
        lockManager.lock(intent, sig);
    }

    function test_fillEvidenceCannotBeOverwritten() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 200e6, user);

        DataTypes.Intent memory intent = _makeIntent(Constants.INTENT_BORROW, 50e6, 640);
        bytes memory sig = _signIntent(intent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(intent, sig);

        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), intent.amount, 0, relayer);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubSettlement.FillEvidenceAlreadyExists.selector, intentId));
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), intent.amount, 0, relayer);
    }

    function test_fillEvidenceRequiresProofRoleAndMatchingLock() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 200e6, user);

        DataTypes.Intent memory intent = _makeIntent(Constants.INTENT_BORROW, 50e6, 641);
        bytes memory sig = _signIntent(intent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(intent, sig);

        vm.prank(user);
        vm.expectRevert();
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), intent.amount, 0, user);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubSettlement.FillEvidenceLockMismatch.selector, intentId));
        settlement.recordVerifiedFillEvidence(intentId, Constants.INTENT_BORROW, user, address(hubUSDC), intent.amount + 1, 0, relayer);
    }

    function test_tokenRegistryReRegisterHubTokenClearsOldSpokeMapping() external {
        MockERC20 replacementSpokeToken = new MockERC20("Spoke USDC v2", "USDC2", 6);
        ITokenRegistry.TokenConfig memory cfg = registry.getConfigByHub(address(hubUSDC));
        registry.setTokenBehavior(address(replacementSpokeToken), TokenRegistry.TokenBehavior.STANDARD);

        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(hubUSDC),
                spokeToken: address(replacementSpokeToken),
                decimals: cfg.decimals,
                risk: cfg.risk,
                bridgeAdapterId: cfg.bridgeAdapterId,
                enabled: cfg.enabled
            })
        );

        assertEq(
            registry.getHubTokenBySpoke(block.chainid, address(spokeUSDC)),
            address(0),
            "old spoke mapping should be cleared"
        );
        assertEq(
            registry.getHubTokenBySpoke(block.chainid, address(replacementSpokeToken)),
            address(hubUSDC),
            "replacement spoke mapping should point to hub token"
        );
    }

    function test_tokenRegistryRejectsSpokeTokenCollisionAcrossHubAssets() external {
        ITokenRegistry.TokenConfig memory cfg = registry.getConfigByHub(address(hubWETH));

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenRegistry.SpokeTokenAlreadyRegistered.selector, address(spokeUSDC), address(hubUSDC)
            )
        );
        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(hubWETH),
                spokeToken: address(spokeUSDC),
                decimals: cfg.decimals,
                risk: cfg.risk,
                bridgeAdapterId: cfg.bridgeAdapterId,
                enabled: cfg.enabled
            })
        );
    }

    function test_tokenRegistryRejectsUnsupportedTokenBehavior() external {
        MockERC20 unsupportedHubToken = new MockERC20("Unsupported Hub", "UHUB", 6);
        MockERC20 supportedSpokeToken = new MockERC20("Supported Spoke", "SSPK", 6);
        ITokenRegistry.TokenConfig memory cfg = registry.getConfigByHub(address(hubUSDC));

        registry.setTokenBehavior(address(unsupportedHubToken), TokenRegistry.TokenBehavior.FEE_ON_TRANSFER);
        registry.setTokenBehavior(address(supportedSpokeToken), TokenRegistry.TokenBehavior.STANDARD);

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenRegistry.UnsupportedTokenBehavior.selector,
                address(unsupportedHubToken),
                TokenRegistry.TokenBehavior.FEE_ON_TRANSFER
            )
        );
        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(unsupportedHubToken),
                spokeToken: address(supportedSpokeToken),
                decimals: 6,
                risk: cfg.risk,
                bridgeAdapterId: cfg.bridgeAdapterId,
                enabled: cfg.enabled
            })
        );

        MockERC20 unsetBehaviorSpokeToken = new MockERC20("Unset Spoke", "USPK2", 6);
        registry.setTokenBehavior(address(unsupportedHubToken), TokenRegistry.TokenBehavior.STANDARD);

        vm.expectRevert(
            abi.encodeWithSelector(TokenRegistry.TokenBehaviorNotConfigured.selector, address(unsetBehaviorSpokeToken))
        );
        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(unsupportedHubToken),
                spokeToken: address(unsetBehaviorSpokeToken),
                decimals: 6,
                risk: cfg.risk,
                bridgeAdapterId: cfg.bridgeAdapterId,
                enabled: cfg.enabled
            })
        );
    }

    function test_adminSettersRejectZeroAddress() external {
        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.InvalidRiskManager.selector, address(0)));
        market.setRiskManager(address(0));

        vm.expectRevert(abi.encodeWithSelector(HubMoneyMarket.InvalidSettlement.selector, address(0)));
        market.setSettlement(address(0));

        vm.expectRevert(abi.encodeWithSelector(HubLockManager.InvalidSettlement.selector, address(0)));
        lockManager.setSettlement(address(0));

        vm.expectRevert(abi.encodeWithSelector(HubRiskManager.InvalidLockManager.selector, address(0)));
        risk.setLockManager(address(0));

        vm.expectRevert(abi.encodeWithSelector(SpokePortal.InvalidBridgeAdapter.selector, address(0)));
        portal.setBridgeAdapter(address(0));

        vm.expectRevert(abi.encodeWithSelector(SpokePortal.InvalidHubRecipient.selector, address(0)));
        portal.setHubRecipient(address(0));

        vm.expectRevert(abi.encodeWithSelector(HubSettlement.InvalidVerifier.selector, address(0)));
        settlement.setVerifier(Verifier(address(0)));

        vm.expectRevert(abi.encodeWithSelector(HubSettlement.InvalidMoneyMarket.selector, address(0)));
        settlement.setMoneyMarket(HubMoneyMarket(address(0)));

        vm.expectRevert(abi.encodeWithSelector(HubSettlement.InvalidCustody.selector, address(0)));
        settlement.setCustody(HubCustody(address(0)));

        vm.expectRevert(abi.encodeWithSelector(HubSettlement.InvalidLockManager.selector, address(0)));
        settlement.setLockManager(HubLockManager(address(0)));
    }

    function test_lockConcurrencyReservationsPreventOverBorrow() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 200e6, user);

        DataTypes.Intent memory intentA = _makeIntent(Constants.INTENT_BORROW, 100e6, 600);
        DataTypes.Intent memory intentB = _makeIntent(Constants.INTENT_BORROW, 50e6, 601);
        DataTypes.Intent memory intentC = _makeIntent(Constants.INTENT_BORROW, 20e6, 602);

        bytes memory sigA = _signIntent(intentA);
        bytes memory sigB = _signIntent(intentB);
        bytes memory sigC = _signIntent(intentC);

        vm.prank(relayer);
        lockManager.lock(intentA, sigA);

        vm.prank(relayer);
        lockManager.lock(intentB, sigB);

        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), 150e6, "reserved debt should include both locks");
        assertEq(
            lockManager.reservedLiquidity(address(hubUSDC)),
            150e6,
            "reserved liquidity should include both locks"
        );

        vm.prank(relayer);
        vm.expectRevert();
        lockManager.lock(intentC, sigC);
    }

    function test_lockExpiryBoundaryConsumeAndCancelPaths() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 300e6, user);

        DataTypes.Intent memory intentAtBoundary = _makeIntent(Constants.INTENT_BORROW, 100e6, 610);
        bytes memory sigAtBoundary = _signIntent(intentAtBoundary);

        vm.prank(relayer);
        bytes32 intentIdBoundary = lockManager.lock(intentAtBoundary, sigAtBoundary);

        (,,,,,,, uint256 expiryAtBoundary,) = lockManager.locks(intentIdBoundary);
        vm.warp(expiryAtBoundary);

        vm.prank(address(settlement));
        lockManager.consumeLock(
            intentIdBoundary,
            Constants.INTENT_BORROW,
            user,
            address(hubUSDC),
            intentAtBoundary.amount,
            relayer
        );

        (,,,,,,,, uint8 consumedStatus) = lockManager.locks(intentIdBoundary);
        assertEq(uint256(consumedStatus), uint256(2), "lock should be consumed at expiry boundary");

        DataTypes.Intent memory intentExpired = _makeIntent(Constants.INTENT_BORROW, 80e6, 611);
        bytes memory sigExpired = _signIntent(intentExpired);

        vm.prank(relayer);
        bytes32 intentIdExpired = lockManager.lock(intentExpired, sigExpired);
        (,,,,,,, uint256 expiryExpired,) = lockManager.locks(intentIdExpired);

        vm.warp(expiryExpired + 1);

        vm.prank(address(settlement));
        vm.expectRevert();
        lockManager.consumeLock(
            intentIdExpired,
            Constants.INTENT_BORROW,
            user,
            address(hubUSDC),
            intentExpired.amount,
            relayer
        );

        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), intentExpired.amount, "reservation should remain before cancel");

        vm.prank(user);
        lockManager.cancelExpiredLock(intentIdExpired);

        (,,,,,,,, uint8 cancelledStatus) = lockManager.locks(intentIdExpired);
        assertEq(uint256(cancelledStatus), uint256(3), "expired lock should be cancellable");
        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), 0, "reserved debt should clear after cancel");
        assertEq(lockManager.reservedLiquidity(address(hubUSDC)), 0, "reserved liquidity should clear after cancel");
    }

    function test_activeLockCanBeCancelledByRelayerOrOwner() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 300e6, user);

        DataTypes.Intent memory firstIntent = _makeIntent(Constants.INTENT_BORROW, 90e6, 615);
        bytes memory firstSig = _signIntent(firstIntent);

        vm.prank(relayer);
        bytes32 firstIntentId = lockManager.lock(firstIntent, firstSig);
        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), firstIntent.amount, "reservation should exist");

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(HubLockManager.UnauthorizedLockCanceller.selector, user));
        lockManager.cancelLock(firstIntentId);

        vm.prank(relayer);
        lockManager.cancelLock(firstIntentId);
        (,,,,,,,, uint8 firstStatus) = lockManager.locks(firstIntentId);
        assertEq(uint256(firstStatus), uint256(3), "relayer should be able to cancel active lock");
        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), 0, "reservation should clear after relayer cancel");

        DataTypes.Intent memory secondIntent = _makeIntent(Constants.INTENT_BORROW, 70e6, 616);
        bytes memory secondSig = _signIntent(secondIntent);

        vm.prank(relayer);
        bytes32 secondIntentId = lockManager.lock(secondIntent, secondSig);
        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), secondIntent.amount, "reservation should exist");

        lockManager.cancelLock(secondIntentId);
        (,,,,,,,, uint8 secondStatus) = lockManager.locks(secondIntentId);
        assertEq(uint256(secondStatus), uint256(3), "owner should be able to cancel active lock");
        assertEq(lockManager.reservedDebt(user, address(hubUSDC)), 0, "reservation should clear after owner cancel");
    }

    function test_intentInboxRejectsInvalidDomainSignaturesAndNonceReplay() external {
        vm.prank(user);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubUSDC), 500e6, user);

        DataTypes.Intent memory domainIntent = _makeIntent(Constants.INTENT_BORROW, 10e6, 700);

        bytes memory wrongChainSig = _signIntentWithDomain(domainIntent, block.chainid + 1, address(inbox));
        vm.prank(relayer);
        vm.expectRevert();
        lockManager.lock(domainIntent, wrongChainSig);

        bytes memory wrongContractSig = _signIntentWithDomain(domainIntent, block.chainid, address(lockManager));
        vm.prank(relayer);
        vm.expectRevert();
        lockManager.lock(domainIntent, wrongContractSig);

        DataTypes.Intent memory first = _makeIntent(Constants.INTENT_BORROW, 40e6, 701);
        DataTypes.Intent memory replay = _makeIntent(Constants.INTENT_BORROW, 41e6, 701);

        bytes memory sigFirst = _signIntent(first);
        bytes memory sigReplay = _signIntent(replay);

        vm.prank(relayer);
        lockManager.lock(first, sigFirst);

        vm.prank(relayer);
        vm.expectRevert();
        lockManager.lock(replay, sigReplay);
    }

    function test_liquidationRevertsWhenPositionHealthy() external {
        vm.prank(user);
        hubWETH.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubWETH), 1 ether, user);

        vm.prank(user);
        market.borrow(address(hubUSDC), 1_000e6, user);

        hubUSDC.mint(liquidator, 500e6);
        vm.startPrank(liquidator);
        hubUSDC.approve(address(market), type(uint256).max);
        vm.expectRevert();
        market.liquidate(user, address(hubUSDC), 500e6, address(hubWETH));
        vm.stopPrank();
    }

    function test_liquidationPartialAndFullRepayAcross18And6Decimals() external {
        vm.prank(user);
        hubWETH.approve(address(market), type(uint256).max);
        vm.prank(user);
        market.supply(address(hubWETH), 1 ether, user);

        vm.prank(user);
        market.borrow(address(hubUSDC), 1_800e6, user);

        oracle.setPrice(address(hubWETH), 1_500e8);
        assertTrue(risk.isLiquidatable(user), "position should be liquidatable after price drop");

        hubUSDC.mint(liquidator, 5_000e6);
        vm.prank(liquidator);
        hubUSDC.approve(address(market), type(uint256).max);

        uint256 debtBefore = market.getUserDebt(user, address(hubUSDC));
        uint256 collateralBefore = market.getUserSupply(user, address(hubWETH));
        uint256 liquidatorWethBefore = hubWETH.balanceOf(liquidator);

        uint256 partialRepay = 600e6;
        vm.prank(liquidator);
        market.liquidate(user, address(hubUSDC), partialRepay, address(hubWETH));

        uint256 debtAfterPartial = market.getUserDebt(user, address(hubUSDC));
        uint256 collateralAfterPartial = market.getUserSupply(user, address(hubWETH));
        uint256 liquidatorWethAfterPartial = hubWETH.balanceOf(liquidator);

        assertEq(debtAfterPartial, debtBefore - partialRepay, "partial liquidation should reduce debt by repay amount");

        uint256 expectedPartialSeize = _expectedCollateralSeize(partialRepay, 1e8, 1_500e8, 6, 18, 10_500);
        assertEq(
            liquidatorWethAfterPartial - liquidatorWethBefore,
            expectedPartialSeize,
            "seized collateral should match 6->18 decimal conversion math"
        );
        assertTrue(collateralAfterPartial < collateralBefore, "collateral should decrease after partial liquidation");

        uint256 remainingDebt = market.getUserDebt(user, address(hubUSDC));
        uint256 liquidatorUsdcBeforeFull = hubUSDC.balanceOf(liquidator);

        vm.prank(liquidator);
        market.liquidate(user, address(hubUSDC), remainingDebt + 1_000e6, address(hubWETH));

        uint256 debtAfterFull = market.getUserDebt(user, address(hubUSDC));
        uint256 collateralAfterFull = market.getUserSupply(user, address(hubWETH));
        uint256 liquidatorUsdcAfterFull = hubUSDC.balanceOf(liquidator);
        uint256 liquidatorWethAfterFull = hubWETH.balanceOf(liquidator);

        assertEq(debtAfterFull, 0, "full liquidation should clear remaining debt");
        assertEq(
            liquidatorUsdcBeforeFull - liquidatorUsdcAfterFull,
            remainingDebt,
            "over-repay input should only spend remaining debt"
        );
        assertTrue(collateralAfterFull < collateralAfterPartial, "full liquidation should seize more collateral");
        assertTrue(liquidatorWethAfterFull > liquidatorWethAfterPartial, "liquidator should receive additional collateral");
    }

    function test_settlementAtomicity_rollsBackWhenLaterActionFails() external {
        uint256 depositId1 = 9_001;
        uint256 depositId2 = 9_002;
        uint256 amount1 = 120e6;
        uint256 amount2 = 80e6;

        hubUSDC.mint(address(custody), amount1 + amount2);
        _registerAttestedDeposit(depositId1, Constants.INTENT_SUPPLY, user, address(hubUSDC), amount1);
        // Intentionally do NOT register depositId2 to force mid-batch failure.

        DataTypes.SupplyCredit[] memory supplyCredits = new DataTypes.SupplyCredit[](2);
        supplyCredits[0] = DataTypes.SupplyCredit({
            depositId: depositId1,
            user: user,
            hubAsset: address(hubUSDC),
            amount: amount1
        });
        supplyCredits[1] = DataTypes.SupplyCredit({
            depositId: depositId2,
            user: user,
            hubAsset: address(hubUSDC),
            amount: amount2
        });

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 9_100,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: supplyCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        uint256 userSupplyBefore = market.getUserSupply(user, address(hubUSDC));
        uint256 custodyBalanceBefore = hubUSDC.balanceOf(address(custody));

        vm.expectRevert();
        settlement.settleBatch(batch, DEV_PROOF);

        uint256 userSupplyAfter = market.getUserSupply(user, address(hubUSDC));
        uint256 custodyBalanceAfter = hubUSDC.balanceOf(address(custody));

        assertEq(userSupplyAfter, userSupplyBefore, "failed batch must not credit supply");
        assertEq(custodyBalanceAfter, custodyBalanceBefore, "failed batch must not transfer custody funds");
        assertTrue(!settlement.batchExecuted(batch.batchId), "failed batch must not be marked executed");
        assertTrue(!settlement.depositSettled(480, depositId1), "first action state must roll back");
        assertTrue(!settlement.depositSettled(480, depositId2), "second action must remain unsettled");

        (,,,, bool consumed) = custody.deposits(480, depositId1);
        assertTrue(!consumed, "custody deposit consumed flag must roll back");
    }

    function test_settlementRevertsWhenBatchExceedsMaxActions() external {
        uint256 count = 51;
        DataTypes.SupplyCredit[] memory oversizedCredits = new DataTypes.SupplyCredit[](count);
        for (uint256 i = 0; i < count; i++) {
            oversizedCredits[i] = DataTypes.SupplyCredit({
                depositId: 10_000 + i,
                user: user,
                hubAsset: address(hubUSDC),
                amount: 1
            });
        }

        DataTypes.SettlementBatch memory oversized = DataTypes.SettlementBatch({
            batchId: 9_200,
            hubChainId: block.chainid,
            spokeChainId: 480,
            actionsRoot: bytes32(0),
            supplyCredits: oversizedCredits,
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: new DataTypes.BorrowFinalize[](0),
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });

        vm.expectRevert();
        settlement.settleBatch(oversized, DEV_PROOF);
        assertTrue(!settlement.batchExecuted(oversized.batchId), "oversized batch must never execute");
    }

    function _registerAttestedDeposit(uint256 depositId, uint8 intentType, address depositUser, address hubAsset, uint256 amount)
        internal
    {
        _registerAttestedDepositForChain(480, depositId, intentType, depositUser, hubAsset, amount);
    }

    function _registerAttestedDepositForChain(
        uint256 originChainId,
        uint256 depositId,
        uint8 intentType,
        address depositUser,
        address hubAsset,
        uint256 amount
    ) internal {
        vm.prank(bridgeOperator);
        custody.registerBridgedDeposit(
            depositId,
            intentType,
            depositUser,
            hubAsset,
            amount,
            originChainId,
            keccak256(
                abi.encodePacked(
                    keccak256(bytes("origin")),
                    originChainId,
                    depositId,
                    intentType,
                    depositUser,
                    hubAsset,
                    amount,
                    nextAttestationLogIndex
                )
            ),
            nextAttestationLogIndex
        );
        nextAttestationLogIndex++;
    }

    function _wireSystem() internal {
        DataTypes.RiskParams memory usdcRisk = DataTypes.RiskParams({
            ltvBps: 7500,
            liquidationThresholdBps: 8000,
            liquidationBonusBps: 10500,
            supplyCap: 10_000_000e6,
            borrowCap: 10_000_000e6
        });
        DataTypes.RiskParams memory wethRisk = DataTypes.RiskParams({
            ltvBps: 7500,
            liquidationThresholdBps: 8000,
            liquidationBonusBps: 10500,
            supplyCap: 10_000_000e18,
            borrowCap: 10_000_000e18
        });

        registry.setTokenBehavior(address(hubUSDC), TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(address(spokeUSDC), TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(address(hubWETH), TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(address(spokeWETH), TokenRegistry.TokenBehavior.STANDARD);

        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(hubUSDC),
                spokeToken: address(spokeUSDC),
                decimals: 6,
                risk: usdcRisk,
                bridgeAdapterId: keccak256("mock-bridge"),
                enabled: true
            })
        );
        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(hubWETH),
                spokeToken: address(spokeWETH),
                decimals: 18,
                risk: wethRisk,
                bridgeAdapterId: keccak256("mock-bridge"),
                enabled: true
            })
        );

        risk.setRiskParams(address(hubUSDC), usdcRisk);
        risk.setRiskParams(address(hubWETH), wethRisk);

        market.initializeMarket(address(hubUSDC));
        market.initializeMarket(address(hubWETH));
        market.setRiskManager(address(risk));
        market.setSettlement(address(settlement));

        risk.setLockManager(address(lockManager));

        inbox.setConsumer(address(lockManager), true);

        lockManager.setSettlement(address(settlement));

        custody.grantRole(custody.CANONICAL_BRIDGE_RECEIVER_ROLE(), bridgeOperator);
        custody.grantRole(custody.SETTLEMENT_ROLE(), address(settlement));

        settlement.grantRole(settlement.PROOF_FILL_ROLE(), relayer);

        portal.setBridgeAdapter(address(bridgeAdapter));
        portal.setHubRecipient(address(custody));

        oracle.setPrice(address(hubUSDC), 1e8);
        oracle.setPrice(address(hubWETH), 3_000e8);
    }

    function _seedBalances() internal {
        hubUSDC.mint(address(market), 5_000_000e6);

        hubUSDC.mint(user, 1_000_000e6);
        hubWETH.mint(user, 1_000e18);
        spokeUSDC.mint(user, 1_000_000e6);
        spokeWETH.mint(user, 1_000e18);
    }

    function _makeIntent(uint8 intentType, uint256 amount, uint256 nonce)
        internal
        view
        returns (DataTypes.Intent memory intent)
    {
        intent = DataTypes.Intent({
            intentType: intentType,
            user: user,
            inputChainId: 480,
            outputChainId: block.chainid,
            inputToken: address(spokeUSDC),
            outputToken: address(spokeUSDC),
            amount: amount,
            recipient: user,
            maxRelayerFee: amount / 10,
            nonce: nonce,
            deadline: block.timestamp + 1 days
        });
    }

    function _signIntent(DataTypes.Intent memory intent) internal returns (bytes memory) {
        bytes32 structHash = IntentHasher.hashIntentStruct(intent);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", inbox.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signIntentWithDomain(DataTypes.Intent memory intent, uint256 chainId, address verifyingContract)
        internal
        returns (bytes memory)
    {
        bytes32 structHash = IntentHasher.hashIntentStruct(intent);
        bytes32 domainSeparator = _domainSeparatorFor(chainId, verifyingContract);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparatorFor(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 nameHash = keccak256(bytes("ElHubIntentInbox"));
        bytes32 versionHash = keccak256(bytes("1"));
        return keccak256(abi.encode(typeHash, nameHash, versionHash, chainId, verifyingContract));
    }

    function _expectedCollateralSeize(
        uint256 repayAmount,
        uint256 debtPriceE8,
        uint256 collateralPriceE8,
        uint8 debtDecimals,
        uint8 collateralDecimals,
        uint256 liquidationBonusBps
    ) internal pure returns (uint256) {
        uint256 debtValueE8 = repayAmount * debtPriceE8 / (10 ** debtDecimals);
        return debtValueE8 * liquidationBonusBps * (10 ** collateralDecimals)
            / (collateralPriceE8 * Constants.BPS);
    }
}
