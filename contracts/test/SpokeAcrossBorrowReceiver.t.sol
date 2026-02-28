// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {SpokeAcrossBorrowReceiver} from "../src/spoke/SpokeAcrossBorrowReceiver.sol";

contract SpokeAcrossBorrowReceiverTest is TestBase {
    uint256 internal constant HUB_CHAIN_ID = 8453;

    address internal user;
    address internal relayer;
    address internal attacker;
    address internal hubDispatcher;
    address internal hubFinalizer;

    MockERC20 internal spokeUsdc;
    MockAcrossSpokePool internal spokePool;
    SpokeAcrossBorrowReceiver internal receiver;

    function setUp() external {
        user = vm.addr(0xA11CE);
        relayer = vm.addr(0xB0B);
        attacker = vm.addr(0xBAD);
        hubDispatcher = vm.addr(0xD15);
        hubFinalizer = vm.addr(0xF1A1);

        spokeUsdc = new MockERC20("Spoke USDC", "USDC", 6);
        spokePool = new MockAcrossSpokePool();
        receiver = new SpokeAcrossBorrowReceiver(
            address(this), address(spokePool), hubDispatcher, hubFinalizer, HUB_CHAIN_ID, relayer
        );

        spokeUsdc.mint(address(spokePool), 1_000_000e6);
    }

    function test_withdrawCallbackTransfersAndMarksIntentFilled() external {
        bytes32 intentId = keccak256("withdraw-intent");
        uint256 amount = 100e6;
        uint256 fee = 3e6;

        bytes memory message = _encodeMessage(intentId, Constants.INTENT_WITHDRAW, amount, fee);
        vm.prank(relayer);
        spokePool.relayV3Deposit(8453, keccak256("origin"), 1, address(spokeUsdc), amount, address(receiver), message);

        assertEq(spokeUsdc.balanceOf(user), amount - fee, "recipient should receive withdraw proceeds minus fee");
        assertEq(spokeUsdc.balanceOf(relayer), fee, "relayer should receive fee on spoke");
        assertTrue(receiver.intentFilled(intentId), "intent should be marked as filled");
    }

    function test_rejectsUnsupportedIntentTypeInMessage() external {
        bytes memory message = _encodeMessage(keccak256("bad-intent"), Constants.INTENT_SUPPLY, 50e6, 2e6);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(SpokeAcrossBorrowReceiver.InvalidIntentType.selector, Constants.INTENT_SUPPLY)
        );
        spokePool.relayV3Deposit(8453, keccak256("origin"), 2, address(spokeUsdc), 50e6, address(receiver), message);
    }

    function test_rejectsUnauthorizedCallbackSender() external {
        bytes memory message = _encodeMessage(keccak256("unauthorized"), Constants.INTENT_BORROW, 25e6, 1e6);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SpokeAcrossBorrowReceiver.UnauthorizedSpokePool.selector, attacker));
        receiver.handleV3AcrossMessage(address(spokeUsdc), 25e6, relayer, message);
    }

    function test_rejectsCallbackRelayerMismatch() external {
        bytes memory message = _encodeMessage(keccak256("relayer-mismatch"), Constants.INTENT_BORROW, 25e6, 1e6);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SpokeAcrossBorrowReceiver.InvalidCallbackRelayer.selector, relayer, attacker));
        spokePool.relayV3Deposit(8453, keccak256("origin"), 3, address(spokeUsdc), 25e6, address(receiver), message);
    }

    function test_rejectsHubDispatcherMismatch() external {
        bytes memory message = _encodeMessageWithOverrides(
            keccak256("dispatcher-mismatch"), Constants.INTENT_BORROW, 25e6, 1e6, HUB_CHAIN_ID, vm.addr(0xDEAD), hubFinalizer
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpokeAcrossBorrowReceiver.InvalidMessageHubDispatcher.selector, hubDispatcher, vm.addr(0xDEAD)
            )
        );
        spokePool.relayV3Deposit(8453, keccak256("origin"), 4, address(spokeUsdc), 25e6, address(receiver), message);
    }

    function test_rejectsHubFinalizerMismatch() external {
        bytes memory message = _encodeMessageWithOverrides(
            keccak256("finalizer-mismatch"), Constants.INTENT_BORROW, 25e6, 1e6, HUB_CHAIN_ID, hubDispatcher, vm.addr(0xDEAD)
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpokeAcrossBorrowReceiver.InvalidMessageHubFinalizer.selector, hubFinalizer, vm.addr(0xDEAD)
            )
        );
        spokePool.relayV3Deposit(8453, keccak256("origin"), 5, address(spokeUsdc), 25e6, address(receiver), message);
    }

    function test_rejectsSourceChainMismatch() external {
        bytes memory message = _encodeMessageWithOverrides(
            keccak256("source-chain-mismatch"), Constants.INTENT_BORROW, 25e6, 1e6, HUB_CHAIN_ID + 1, hubDispatcher, hubFinalizer
        );

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpokeAcrossBorrowReceiver.InvalidSourceChain.selector, HUB_CHAIN_ID, HUB_CHAIN_ID + 1
            )
        );
        spokePool.relayV3Deposit(8453, keccak256("origin"), 6, address(spokeUsdc), 25e6, address(receiver), message);
    }

    function test_rejectsReplayForSameIntent() external {
        bytes32 intentId = keccak256("replay-intent");
        bytes memory message = _encodeMessage(intentId, Constants.INTENT_BORROW, 25e6, 1e6);

        vm.prank(relayer);
        spokePool.relayV3Deposit(8453, keccak256("origin"), 7, address(spokeUsdc), 25e6, address(receiver), message);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SpokeAcrossBorrowReceiver.IntentAlreadyFilled.selector, intentId));
        spokePool.relayV3Deposit(8453, keccak256("origin"), 8, address(spokeUsdc), 25e6, address(receiver), message);
    }

    function _encodeMessage(bytes32 intentId, uint8 intentType, uint256 amount, uint256 fee)
        internal
        returns (bytes memory)
    {
        return _encodeMessageWithOverrides(intentId, intentType, amount, fee, HUB_CHAIN_ID, hubDispatcher, hubFinalizer);
    }

    function _encodeMessageWithOverrides(
        bytes32 intentId,
        uint8 intentType,
        uint256 amount,
        uint256 fee,
        uint256 sourceChainId,
        address hubDispatcher_,
        address hubFinalizer_
    ) internal returns (bytes memory) {
        SpokeAcrossBorrowReceiver.BorrowDispatchMessage memory msgPayload = SpokeAcrossBorrowReceiver.BorrowDispatchMessage({
            intentId: intentId,
            intentType: intentType,
            user: user,
            recipient: user,
            spokeToken: address(spokeUsdc),
            hubAsset: address(spokeUsdc),
            amount: amount,
            fee: fee,
            relayer: relayer,
            sourceChainId: sourceChainId,
            destinationChainId: block.chainid,
            hubDispatcher: hubDispatcher_,
            hubFinalizer: hubFinalizer_
        });

        return abi.encode(msgPayload);
    }
}
