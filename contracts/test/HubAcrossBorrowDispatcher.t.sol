// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {HubAcrossBorrowDispatcher} from "../src/hub/HubAcrossBorrowDispatcher.sol";

interface VmLogs {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract HubAcrossBorrowDispatcherTest is TestBase {
    VmLogs internal constant vmLogs = VmLogs(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant V3_FUNDS_DEPOSITED_SIG = keccak256(
        "V3FundsDeposited(uint256,address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes,address)"
    );

    uint256 internal constant DESTINATION_CHAIN_ID = 480;
    uint256 internal constant DISPATCH_AMOUNT = 100e6;

    address internal relayer;
    address internal user;
    address internal recipient;
    address internal spokeReceiver;
    address internal hubFinalizer;
    address internal routeExclusiveRelayer;

    MockERC20 internal hubUsdc;
    MockERC20 internal spokeUsdc;
    MockAcrossSpokePool internal spokePool;
    HubAcrossBorrowDispatcher internal dispatcher;

    function setUp() external {
        relayer = vm.addr(0xB0B);
        user = vm.addr(0xA11CE);
        recipient = vm.addr(0xA11CF);
        spokeReceiver = vm.addr(0xCA11);
        hubFinalizer = vm.addr(0xF1A1);
        routeExclusiveRelayer = relayer;

        hubUsdc = new MockERC20("Hub USDC", "USDC", 6);
        spokeUsdc = new MockERC20("Spoke USDC", "USDC", 6);
        spokePool = new MockAcrossSpokePool();

        dispatcher = new HubAcrossBorrowDispatcher(address(this), hubFinalizer);
        dispatcher.setAllowedCaller(relayer, true);

        hubUsdc.mint(relayer, 1_000_000e6);
    }

    function test_setRouteRejectsEnabledRouteWithoutExclusiveRelayer() external {
        vm.expectRevert(abi.encodeWithSelector(HubAcrossBorrowDispatcher.InvalidExclusiveRelayer.selector, address(0)));
        dispatcher.setRoute(
            address(hubUsdc),
            DESTINATION_CHAIN_ID,
            address(spokePool),
            address(spokeUsdc),
            spokeReceiver,
            address(0),
            300_000,
            1 hours,
            true
        );
    }

    function test_dispatchRevertsOnQuoteExclusiveRelayerMismatch() external {
        dispatcher.setRoute(
            address(hubUsdc),
            DESTINATION_CHAIN_ID,
            address(spokePool),
            address(spokeUsdc),
            spokeReceiver,
            routeExclusiveRelayer,
            300_000,
            1 hours,
            true
        );

        HubAcrossBorrowDispatcher.AcrossQuoteParams memory quote = _quote(DISPATCH_AMOUNT, vm.addr(0xDEAD), 0);

        vm.startPrank(relayer);
        hubUsdc.approve(address(dispatcher), DISPATCH_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                HubAcrossBorrowDispatcher.QuoteExclusiveRelayerMismatch.selector, routeExclusiveRelayer, vm.addr(0xDEAD)
            )
        );
        dispatcher.dispatchBorrowFill(
            keccak256("mismatch"),
            Constants.INTENT_BORROW,
            user,
            recipient,
            address(spokeUsdc),
            DISPATCH_AMOUNT,
            DESTINATION_CHAIN_ID,
            1e6,
            2e6,
            address(hubUsdc),
            quote
        );
        vm.stopPrank();
    }

    function test_dispatchUsesRouteExclusiveRelayerAndFullWindowExclusivity() external {
        dispatcher.setRoute(
            address(hubUsdc),
            DESTINATION_CHAIN_ID,
            address(spokePool),
            address(spokeUsdc),
            spokeReceiver,
            routeExclusiveRelayer,
            300_000,
            1 hours,
            true
        );

        HubAcrossBorrowDispatcher.AcrossQuoteParams memory quote = _quote(DISPATCH_AMOUNT, address(0), 0);

        vm.startPrank(relayer);
        hubUsdc.approve(address(dispatcher), DISPATCH_AMOUNT);
        vmLogs.recordLogs();
        dispatcher.dispatchBorrowFill(
            keccak256("exclusive"),
            Constants.INTENT_BORROW,
            user,
            recipient,
            address(spokeUsdc),
            DISPATCH_AMOUNT,
            DESTINATION_CHAIN_ID,
            1e6,
            2e6,
            address(hubUsdc),
            quote
        );
        VmLogs.Log[] memory logs = vmLogs.getRecordedLogs();
        vm.stopPrank();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            VmLogs.Log memory entry = logs[i];
            if (entry.emitter != address(spokePool) || entry.topics.length == 0 || entry.topics[0] != V3_FUNDS_DEPOSITED_SIG) {
                continue;
            }

            (
                address _inputToken,
                address _outputToken,
                uint256 _inputAmount,
                uint256 _outputAmount,
                uint256 _destinationChainId,
                address exclusiveRelayer,
                uint32 quoteTimestamp,
                uint32 fillDeadline,
                uint32 exclusivityDeadline,
                bytes memory _message,
                address _caller
            ) = abi.decode(entry.data, (address, address, uint256, uint256, uint256, address, uint32, uint32, uint32, bytes, address));

            assertEq(exclusiveRelayer, routeExclusiveRelayer, "route exclusive relayer must be enforced");
            assertTrue(fillDeadline > quoteTimestamp, "fill deadline must be after quote timestamp");
            assertEq(uint256(exclusivityDeadline), uint256(fillDeadline), "exclusivity window must span full fill window");
            _inputToken;
            _outputToken;
            _inputAmount;
            _outputAmount;
            _destinationChainId;
            _message;
            _caller;
            found = true;
            break;
        }

        assertTrue(found, "expected V3FundsDeposited log");
    }

    function _quote(uint256 outputAmount, address exclusiveRelayer, uint32 exclusivityDeadline)
        internal
        view
        returns (HubAcrossBorrowDispatcher.AcrossQuoteParams memory quote)
    {
        uint32 nowTs = uint32(block.timestamp);
        quote = HubAcrossBorrowDispatcher.AcrossQuoteParams({
            outputAmount: outputAmount,
            quoteTimestamp: nowTs,
            fillDeadline: nowTs + 2 hours,
            exclusivityDeadline: exclusivityDeadline,
            exclusiveRelayer: exclusiveRelayer
        });
    }
}
