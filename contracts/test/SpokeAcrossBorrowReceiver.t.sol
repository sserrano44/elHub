// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {SpokeAcrossBorrowReceiver} from "../src/spoke/SpokeAcrossBorrowReceiver.sol";

contract SpokeAcrossBorrowReceiverTest is TestBase {
    address internal user;
    address internal relayer;
    address internal attacker;

    MockERC20 internal spokeUsdc;
    MockAcrossSpokePool internal spokePool;
    SpokeAcrossBorrowReceiver internal receiver;

    function setUp() external {
        user = vm.addr(0xA11CE);
        relayer = vm.addr(0xB0B);
        attacker = vm.addr(0xBAD);

        spokeUsdc = new MockERC20("Spoke USDC", "USDC", 6);
        spokePool = new MockAcrossSpokePool();
        receiver = new SpokeAcrossBorrowReceiver(address(this), address(spokePool));

        spokeUsdc.mint(address(spokePool), 1_000_000e6);
    }

    function test_withdrawCallbackTransfersAndMarksIntentFilled() external {
        bytes32 intentId = keccak256("withdraw-intent");
        uint256 amount = 100e6;
        uint256 fee = 3e6;

        bytes memory message = _encodeMessage(intentId, Constants.INTENT_WITHDRAW, amount, fee);
        spokePool.relayV3Deposit(8453, keccak256("origin"), 1, address(spokeUsdc), amount, address(receiver), message);

        assertEq(spokeUsdc.balanceOf(user), amount - fee, "recipient should receive withdraw proceeds minus fee");
        assertEq(spokeUsdc.balanceOf(relayer), fee, "relayer should receive fee on spoke");
        assertTrue(receiver.intentFilled(intentId), "intent should be marked as filled");
    }

    function test_rejectsUnsupportedIntentTypeInMessage() external {
        bytes memory message = _encodeMessage(keccak256("bad-intent"), Constants.INTENT_SUPPLY, 50e6, 2e6);

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

    function _encodeMessage(bytes32 intentId, uint8 intentType, uint256 amount, uint256 fee)
        internal
        returns (bytes memory)
    {
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
            destinationChainId: block.chainid,
            hubFinalizer: vm.addr(0xF1A1)
        });

        return abi.encode(msgPayload);
    }
}
