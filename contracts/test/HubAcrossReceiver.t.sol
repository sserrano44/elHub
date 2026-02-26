// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAcrossSpokePool} from "../src/mocks/MockAcrossSpokePool.sol";
import {MockLightClientVerifier} from "../src/mocks/MockLightClientVerifier.sol";
import {MockAcrossDepositEventVerifier} from "../src/mocks/MockAcrossDepositEventVerifier.sol";
import {HubCustody} from "../src/hub/HubCustody.sol";
import {HubAcrossReceiver} from "../src/hub/HubAcrossReceiver.sol";
import {DepositProofVerifier} from "../src/zk/DepositProofVerifier.sol";
import {AcrossDepositProofBackend} from "../src/zk/AcrossDepositProofBackend.sol";
import {IDepositProofVerifier} from "../src/interfaces/IDepositProofVerifier.sol";
import {IAcrossDepositProofBackend} from "../src/interfaces/IAcrossDepositProofBackend.sol";

contract HubAcrossReceiverTest is TestBase {
    uint8 internal constant CANONICAL_PROOF_SCHEMA_VERSION = 1;
    uint256 internal constant SOURCE_CHAIN_ID = 8453;
    uint256 internal constant SOURCE_BLOCK_NUMBER = 12345;

    address internal relayer;
    address internal attacker;

    MockERC20 internal hubUsdc;
    HubCustody internal custody;
    MockLightClientVerifier internal lightClientVerifier;
    MockAcrossDepositEventVerifier internal eventVerifier;
    AcrossDepositProofBackend internal proofBackend;
    DepositProofVerifier internal verifier;
    MockAcrossSpokePool internal spokePool;
    HubAcrossReceiver internal receiver;

    function setUp() external {
        relayer = vm.addr(0xB0B);
        attacker = vm.addr(0xBAD);

        hubUsdc = new MockERC20("Hub USDC", "USDC", 6);
        custody = new HubCustody(address(this));
        lightClientVerifier = new MockLightClientVerifier();
        eventVerifier = new MockAcrossDepositEventVerifier();
        proofBackend = new AcrossDepositProofBackend(address(this), lightClientVerifier, eventVerifier);
        spokePool = new MockAcrossSpokePool();
        proofBackend.setSourceSpokePool(SOURCE_CHAIN_ID, address(spokePool));
        verifier = new DepositProofVerifier(proofBackend);
        receiver = new HubAcrossReceiver(address(this), custody, verifier, address(spokePool));

        custody.grantRole(custody.CANONICAL_BRIDGE_RECEIVER_ROLE(), address(receiver));
        hubUsdc.mint(address(spokePool), 10_000_000e6);
    }

    function test_unauthorizedCallbackSenderRejected() external {
        bytes memory message = _encodeMessage(1, Constants.INTENT_SUPPLY, attacker, 25e6);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(HubAcrossReceiver.UnauthorizedSpokePool.selector, attacker));
        receiver.handleV3AcrossMessage(address(hubUsdc), 25e6, attacker, message);
    }

    function test_callbackAloneDoesNotCreditCustody() external {
        (bytes32 pendingId,,,,,) = _relayPendingDeposit(2, Constants.INTENT_SUPPLY, attacker, 50e6);

        (,,,, bool consumed) = custody.deposits(SOURCE_CHAIN_ID, 2);
        assertTrue(!consumed, "deposit must not be consumed before finalize");

        (, , address hubAsset,,) = custody.deposits(SOURCE_CHAIN_ID, 2);
        assertEq(hubAsset, address(0), "callback alone must not register custody deposit");
        assertEq(hubUsdc.balanceOf(address(custody)), 0, "callback alone must not move funds into custody");

        (bool exists, bool finalized,,,,,,,,,,,) = receiver.pendingDeposits(pendingId);
        assertTrue(exists, "pending deposit should exist after callback");
        assertTrue(!finalized, "pending deposit should not be finalized yet");
    }

    function test_invalidProofRejected() external {
        (bytes32 pendingId, IDepositProofVerifier.DepositWitness memory witness,,,,) =
            _relayPendingDeposit(3, Constants.INTENT_SUPPLY, attacker, 40e6);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubAcrossReceiver.InvalidDepositProof.selector));
        receiver.finalizePendingDeposit(pendingId, hex"1234", witness);

        (, , address hubAsset,,) = custody.deposits(SOURCE_CHAIN_ID, 3);
        assertEq(hubAsset, address(0), "invalid proof must not register custody deposit");
        assertEq(hubUsdc.balanceOf(address(custody)), 0, "invalid proof must not move custody funds");
    }

    function test_replayFinalizationRejected() external {
        (bytes32 pendingId, IDepositProofVerifier.DepositWitness memory witness, bytes32 sourceBlockHash, bytes32 receiptsRoot,,) =
            _relayPendingDeposit(4, Constants.INTENT_SUPPLY, attacker, 75e6);
        bytes memory proof = _buildCanonicalProof(witness, sourceBlockHash, receiptsRoot);

        vm.prank(attacker);
        receiver.finalizePendingDeposit(pendingId, proof, witness);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubAcrossReceiver.PendingAlreadyFinalized.selector, pendingId));
        receiver.finalizePendingDeposit(pendingId, proof, witness);

        assertEq(hubUsdc.balanceOf(address(custody)), 75e6, "finalization must credit custody exactly once");
    }

    function test_validCallbackAndProofCreditsExactlyOnce() external {
        (bytes32 pendingId, IDepositProofVerifier.DepositWitness memory witness, bytes32 sourceBlockHash, bytes32 receiptsRoot,,) =
            _relayPendingDeposit(5, Constants.INTENT_REPAY, attacker, 120e6);
        bytes memory proof = _buildCanonicalProof(witness, sourceBlockHash, receiptsRoot);

        vm.prank(attacker);
        receiver.finalizePendingDeposit(pendingId, proof, witness);

        (uint8 intentType, address user, address hubAsset, uint256 amount, bool consumed) =
            custody.deposits(SOURCE_CHAIN_ID, 5);
        assertEq(uint256(intentType), uint256(Constants.INTENT_REPAY), "intent type must match");
        assertEq(user, attacker, "user must match");
        assertEq(hubAsset, address(hubUsdc), "hub asset must match");
        assertEq(amount, 120e6, "amount must match");
        assertTrue(!consumed, "deposit should remain unconsumed after registration");

        assertEq(hubUsdc.balanceOf(address(custody)), 120e6, "custody must receive bridged funds after valid proof");
    }

    function test_operatorCannotForgeDepositWithoutValidProof() external {
        (
            bytes32 pendingId,
            IDepositProofVerifier.DepositWitness memory witness,
            bytes32 sourceBlockHash,
            bytes32 receiptsRoot,
            bytes32 messageHash,
        ) = _relayPendingDeposit(6, Constants.INTENT_SUPPLY, attacker, 33e6);

        IDepositProofVerifier.DepositWitness memory forgedWitness = IDepositProofVerifier.DepositWitness({
            sourceChainId: witness.sourceChainId,
            depositId: witness.depositId,
            intentType: witness.intentType,
            user: witness.user,
            spokeToken: witness.spokeToken,
            hubAsset: witness.hubAsset,
            amount: witness.amount + 1,
            sourceTxHash: witness.sourceTxHash,
            sourceLogIndex: witness.sourceLogIndex,
            messageHash: messageHash
        });

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubAcrossReceiver.WitnessMismatch.selector, pendingId));
        receiver.finalizePendingDeposit(pendingId, _buildCanonicalProof(witness, sourceBlockHash, receiptsRoot), forgedWitness);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HubAcrossReceiver.InvalidDepositProof.selector));
        receiver.finalizePendingDeposit(pendingId, hex"deadbeef", witness);

        (, , address hubAsset,,) = custody.deposits(SOURCE_CHAIN_ID, 6);
        assertEq(hubAsset, address(0), "forged attempts must not register custody deposit");
    }

    function _relayPendingDeposit(uint256 depositId, uint8 intentType, address user, uint256 amount)
        internal
        returns (
            bytes32 pendingId,
            IDepositProofVerifier.DepositWitness memory witness,
            bytes32 sourceBlockHash,
            bytes32 receiptsRoot,
            bytes32 messageHash,
            bytes memory message
        )
    {
        message = _encodeMessage(depositId, intentType, user, amount);
        messageHash = keccak256(message);
        bytes32 sourceTxHash = keccak256(abi.encodePacked("source", depositId, intentType, user, amount));
        uint256 sourceLogIndex = depositId + 99;
        sourceBlockHash = keccak256(abi.encodePacked("source-block", depositId, intentType));
        receiptsRoot = keccak256(abi.encodePacked("receipts-root", depositId, intentType));

        pendingId = receiver.pendingIdFor(
            SOURCE_CHAIN_ID,
            depositId,
            intentType,
            user,
            address(hubUsdc),
            amount,
            messageHash
        );

        vm.prank(relayer);
        spokePool.relayV3Deposit(
            SOURCE_CHAIN_ID,
            sourceTxHash,
            sourceLogIndex,
            address(hubUsdc),
            amount,
            address(receiver),
            message
        );

        witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: SOURCE_CHAIN_ID,
            depositId: depositId,
            intentType: intentType,
            user: user,
            spokeToken: address(hubUsdc),
            hubAsset: address(hubUsdc),
            amount: amount,
            sourceTxHash: sourceTxHash,
            sourceLogIndex: sourceLogIndex,
            messageHash: messageHash
        });
    }

    function _buildCanonicalProof(
        IDepositProofVerifier.DepositWitness memory witness,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot
    ) internal view returns (bytes memory) {
        bytes memory finalityProof = abi.encode(
            MockLightClientVerifier.FinalityProofData({
                sourceChainId: witness.sourceChainId,
                sourceBlockNumber: SOURCE_BLOCK_NUMBER,
                sourceBlockHash: sourceBlockHash
            })
        );

        bytes memory inclusionProof = abi.encode(
            MockAcrossDepositEventVerifier.InclusionProofData({
                sourceChainId: witness.sourceChainId,
                sourceBlockHash: sourceBlockHash,
                receiptsRoot: receiptsRoot,
                sourceTxHash: witness.sourceTxHash,
                sourceLogIndex: witness.sourceLogIndex,
                sourceSpokePool: address(spokePool),
                inputToken: witness.spokeToken,
                outputToken: witness.hubAsset,
                outputAmount: witness.amount,
                destinationChainId: block.chainid,
                recipient: address(receiver),
                messageHash: witness.messageHash
            })
        );

        IAcrossDepositProofBackend.CanonicalSourceProof memory canonical = IAcrossDepositProofBackend.CanonicalSourceProof({
            sourceBlockNumber: SOURCE_BLOCK_NUMBER,
            sourceBlockHash: sourceBlockHash,
            receiptsRoot: receiptsRoot,
            sourceSpokePool: address(spokePool),
            finalityProof: finalityProof,
            inclusionProof: inclusionProof
        });

        return abi.encode(CANONICAL_PROOF_SCHEMA_VERSION, abi.encode(canonical));
    }

    function _encodeMessage(uint256 depositId, uint8 intentType, address user, uint256 amount)
        internal
        view
        returns (bytes memory)
    {
        HubAcrossReceiver.AcrossDepositMessage memory message = HubAcrossReceiver.AcrossDepositMessage({
            depositId: depositId,
            intentType: intentType,
            user: user,
            spokeToken: address(hubUsdc),
            hubAsset: address(hubUsdc),
            amount: amount,
            sourceChainId: SOURCE_CHAIN_ID,
            destinationChainId: block.chainid
        });
        return abi.encode(message);
    }
}
