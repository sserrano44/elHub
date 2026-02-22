// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {DataTypes} from "../src/libraries/DataTypes.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {IntentHasher} from "../src/libraries/IntentHasher.sol";
import {ITokenRegistry} from "../src/interfaces/ITokenRegistry.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockOracle} from "../src/mocks/MockOracle.sol";

import {TokenRegistry} from "../src/hub/TokenRegistry.sol";
import {KinkInterestRateModel} from "../src/hub/KinkInterestRateModel.sol";
import {HubMoneyMarket} from "../src/hub/HubMoneyMarket.sol";
import {HubRiskManager} from "../src/hub/HubRiskManager.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {HubIntentInbox} from "../src/hub/HubIntentInbox.sol";
import {HubLockManager} from "../src/hub/HubLockManager.sol";
import {HubCustody} from "../src/hub/HubCustody.sol";
import {HubSettlement} from "../src/hub/HubSettlement.sol";

import {SpokePortal} from "../src/spoke/SpokePortal.sol";
import {MockBridgeAdapter} from "../src/spoke/MockBridgeAdapter.sol";
import {Verifier} from "../src/zk/Verifier.sol";

interface IERC20MinimalFork {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH9Fork {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

contract ForkCrossChainE2ETest is TestBase {
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant RELAYER_PK = 0xB0B;
    uint256 internal constant BRIDGE_PK = 0xCAFE;

    bytes internal constant DEV_PROOF = "ZKHUB_DEV_PROOF";

    // Canonical Base WETH.
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    bool internal forkReady;
    uint256 internal baseForkId;
    uint256 internal spokeForkId;
    uint256 internal baseChainId;
    uint256 internal spokeChainId;

    address internal user;
    address internal relayer;
    address internal bridgeOperator;

    MockERC20 internal hubUsdc;
    MockERC20 internal spokeUsdc;
    MockERC20 internal spokeWeth;

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

    function setUp() external {
        if (!_isForkModeEnabled()) {
            forkReady = false;
            return;
        }

        string memory baseForkUrl = _readBaseForkUrl();
        string memory spokeForkUrl = _readSpokeForkUrl();

        baseForkId = vm.createFork(baseForkUrl);
        spokeForkId = vm.createFork(spokeForkUrl);

        user = vm.addr(USER_PK);
        relayer = vm.addr(RELAYER_PK);
        bridgeOperator = vm.addr(BRIDGE_PK);

        vm.selectFork(baseForkId);
        baseChainId = block.chainid;

        vm.selectFork(spokeForkId);
        spokeChainId = block.chainid;
        spokeUsdc = new MockERC20("Spoke USDC", "USDC", 6);
        spokeWeth = new MockERC20("Spoke WETH", "WETH", 18);
        portal = new SpokePortal(address(this), baseChainId);
        bridgeAdapter = new MockBridgeAdapter(address(this));
        portal.setBridgeAdapter(address(bridgeAdapter));

        vm.selectFork(baseForkId);
        hubUsdc = new MockERC20("Hub USDC", "USDC", 6);
        registry = new TokenRegistry(address(this));
        oracle = new MockOracle(address(this));
        rateModel = new KinkInterestRateModel(
            address(this),
            3_170_979_198_000_000_000,
            6_341_958_396_000_000_000,
            19_025_875_190_000_000_000,
            800_000_000_000_000_000_000_000_000,
            100_000_000_000_000_000_000_000_000
        );
        market = new HubMoneyMarket(address(this), registry, rateModel);
        risk = new HubRiskManager(address(this), registry, market, IPriceOracle(address(oracle)));
        inbox = new HubIntentInbox(address(this));
        lockManager = new HubLockManager(address(this), inbox, registry, risk, market);
        custody = new HubCustody(address(this));
        verifier = new Verifier(address(this), true, keccak256(DEV_PROOF), address(0), 4);
        settlement = new HubSettlement(address(this), verifier, market, custody, lockManager);

        _wireBaseAndSpoke();
        _seedLiquidity();
        forkReady = true;
    }

    function test_fork_crossChainSupplyEthAndBorrowUsdcSettlement() external {
        if (!forkReady) {
            return;
        }

        uint256 supplyEthAmount = 1 ether;
        uint256 borrowUsdcAmount = 500e6;
        uint256 relayerFee = 5e6;

        vm.selectFork(baseForkId);
        vm.deal(user, 10 ether);

        vm.startPrank(user);
        IWETH9Fork(BASE_WETH).deposit{value: supplyEthAmount}();
        IWETH9Fork(BASE_WETH).approve(address(market), type(uint256).max);
        market.supply(BASE_WETH, supplyEthAmount, user);
        vm.stopPrank();

        uint256 suppliedEth = market.getUserSupply(user, BASE_WETH);
        assertEq(suppliedEth, supplyEthAmount, "ETH collateral should be supplied on base");

        DataTypes.Intent memory borrowIntent = _makeBorrowIntent(borrowUsdcAmount);
        bytes memory signature = _signIntent(borrowIntent);

        vm.prank(relayer);
        bytes32 intentId = lockManager.lock(borrowIntent, signature);

        vm.selectFork(spokeForkId);
        spokeUsdc.mint(relayer, borrowUsdcAmount);
        uint256 userSpokeUsdcBefore = spokeUsdc.balanceOf(user);

        vm.startPrank(relayer);
        IERC20MinimalFork(address(spokeUsdc)).approve(address(portal), type(uint256).max);
        portal.fillBorrow(borrowIntent, relayerFee, "");
        vm.stopPrank();

        uint256 userSpokeUsdcAfter = spokeUsdc.balanceOf(user);
        assertEq(
            userSpokeUsdcAfter,
            userSpokeUsdcBefore + (borrowUsdcAmount - relayerFee),
            "user should receive borrow proceeds on spoke"
        );

        vm.selectFork(baseForkId);
        vm.prank(relayer);
        settlement.recordVerifiedFillEvidence(
            intentId,
            Constants.INTENT_BORROW,
            user,
            address(hubUsdc),
            borrowUsdcAmount,
            relayerFee,
            relayer
        );

        DataTypes.BorrowFinalize[] memory borrows = new DataTypes.BorrowFinalize[](1);
        borrows[0] = DataTypes.BorrowFinalize({
            intentId: intentId,
            user: user,
            hubAsset: address(hubUsdc),
            amount: borrowUsdcAmount,
            fee: relayerFee,
            relayer: relayer
        });

        DataTypes.SettlementBatch memory batch = DataTypes.SettlementBatch({
            batchId: 1,
            hubChainId: baseChainId,
            spokeChainId: spokeChainId,
            actionsRoot: bytes32(0),
            supplyCredits: new DataTypes.SupplyCredit[](0),
            repayCredits: new DataTypes.RepayCredit[](0),
            borrowFinalizations: borrows,
            withdrawFinalizations: new DataTypes.WithdrawFinalize[](0)
        });
        batch.actionsRoot = settlement.computeActionsRoot(batch);

        uint256 relayerHubBefore = hubUsdc.balanceOf(relayer);
        settlement.settleBatch(batch, DEV_PROOF);

        uint256 relayerHubAfter = hubUsdc.balanceOf(relayer);
        assertEq(relayerHubAfter, relayerHubBefore + borrowUsdcAmount, "relayer must be reimbursed on base");

        uint256 userHubDebt = market.getUserDebt(user, address(hubUsdc));
        assertEq(userHubDebt, borrowUsdcAmount, "hub debt should be minted after settlement");
        assertTrue(!risk.isLiquidatable(user), "position should remain healthy after borrow");
        assertTrue(settlement.isIntentSettled(intentId), "intent should be settled");

        (,,,,,,,, uint8 status) = lockManager.locks(intentId);
        assertEq(uint256(status), uint256(2), "lock should be consumed");
    }

    function _wireBaseAndSpoke() internal {
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

        registry.setTokenBehavior(address(hubUsdc), TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(address(spokeUsdc), TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(BASE_WETH, TokenRegistry.TokenBehavior.STANDARD);
        registry.setTokenBehavior(address(spokeWeth), TokenRegistry.TokenBehavior.STANDARD);

        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: address(hubUsdc),
                spokeToken: address(spokeUsdc),
                decimals: 6,
                risk: usdcRisk,
                bridgeAdapterId: keccak256("fork-e2e"),
                enabled: true
            })
        );
        registry.registerToken(
            ITokenRegistry.TokenConfig({
                hubToken: BASE_WETH,
                spokeToken: address(spokeWeth),
                decimals: 18,
                risk: wethRisk,
                bridgeAdapterId: keccak256("fork-e2e"),
                enabled: true
            })
        );

        risk.setRiskParams(address(hubUsdc), usdcRisk);
        risk.setRiskParams(BASE_WETH, wethRisk);

        market.initializeMarket(address(hubUsdc));
        market.initializeMarket(BASE_WETH);
        market.setRiskManager(address(risk));
        market.setSettlement(address(settlement));

        risk.setLockManager(address(lockManager));
        inbox.setConsumer(address(lockManager), true);
        lockManager.setSettlement(address(settlement));

        custody.grantRole(custody.CANONICAL_BRIDGE_RECEIVER_ROLE(), bridgeOperator);
        custody.grantRole(custody.SETTLEMENT_ROLE(), address(settlement));
        settlement.grantRole(settlement.PROOF_FILL_ROLE(), relayer);

        oracle.setPrice(address(hubUsdc), 1e8);
        oracle.setPrice(BASE_WETH, 3_000e8);

        vm.selectFork(spokeForkId);
        portal.setHubRecipient(address(custody));
        vm.selectFork(baseForkId);
    }

    function _seedLiquidity() internal {
        hubUsdc.mint(address(market), 5_000_000e6);
    }

    function _makeBorrowIntent(uint256 amount) internal view returns (DataTypes.Intent memory intent) {
        intent = DataTypes.Intent({
            intentType: Constants.INTENT_BORROW,
            user: user,
            inputChainId: baseChainId,
            outputChainId: spokeChainId,
            inputToken: BASE_WETH,
            outputToken: address(spokeUsdc),
            amount: amount,
            recipient: user,
            maxRelayerFee: amount / 10,
            nonce: 1,
            deadline: block.timestamp + 1 days
        });
    }

    function _signIntent(DataTypes.Intent memory intent) internal returns (bytes memory) {
        bytes32 structHash = IntentHasher.hashIntentStruct(intent);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", inbox.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _isForkModeEnabled() internal returns (bool) {
        try vm.envString("RUN_FORK_TESTS") returns (string memory value) {
            return keccak256(bytes(value)) == keccak256(bytes("1"));
        } catch {
            return false;
        }
    }

    function _readBaseForkUrl() internal returns (string memory) {
        try vm.envString("BASE_FORK_URL") returns (string memory value) {
            return value;
        } catch {
            try vm.envString("BASE_RPC_URL") returns (string memory fallbackValue) {
                return fallbackValue;
            } catch {
                return "http://127.0.0.1:8545";
            }
        }
    }

    function _readSpokeForkUrl() internal returns (string memory) {
        bytes32 network = _readSpokeNetwork();
        bytes32 worldchain = keccak256(bytes("worldchain"));
        bytes32 ethereum = keccak256(bytes("ethereum"));
        bytes32 bsc = keccak256(bytes("bsc"));

        if (network == worldchain) {
            try vm.envString("SPOKE_WORLDCHAIN_RPC_URL") returns (string memory value) {
                return value;
            } catch {
                return "http://127.0.0.1:8546";
            }
        }

        if (network == ethereum) {
            try vm.envString("SPOKE_ETHEREUM_RPC_URL") returns (string memory value) {
                return value;
            } catch {
                revert("Set SPOKE_ETHEREUM_RPC_URL for SPOKE_NETWORK=ethereum");
            }
        }

        if (network == bsc) {
            try vm.envString("SPOKE_BSC_RPC_URL") returns (string memory value) {
                return value;
            } catch {
                revert("Set SPOKE_BSC_RPC_URL for SPOKE_NETWORK=bsc");
            }
        }

        revert("Unsupported SPOKE_NETWORK");
    }

    function _readSpokeNetwork() internal returns (bytes32) {
        string memory network = "worldchain";
        try vm.envString("SPOKE_NETWORK") returns (string memory value) {
            network = value;
        } catch {}

        bytes32 hash = keccak256(bytes(network));
        if (hash == keccak256(bytes("eth"))) return keccak256(bytes("ethereum"));
        if (hash == keccak256(bytes("bnb"))) return keccak256(bytes("bsc"));
        return hash;
    }
}
