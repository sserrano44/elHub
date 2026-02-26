// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Constants} from "../src/libraries/Constants.sol";
import {IBorrowFillProofVerifier} from "../src/interfaces/IBorrowFillProofVerifier.sol";
import {IAcrossBorrowFillProofBackend} from "../src/interfaces/IAcrossBorrowFillProofBackend.sol";
import {BorrowFillProofVerifier} from "../src/zk/BorrowFillProofVerifier.sol";
import {AcrossBorrowFillProofBackend} from "../src/zk/AcrossBorrowFillProofBackend.sol";
import {MockLightClientVerifier} from "../src/mocks/MockLightClientVerifier.sol";
import {MockAcrossBorrowFillEventVerifier} from "../src/mocks/MockAcrossBorrowFillEventVerifier.sol";

contract BorrowFillProofVerifierTest is TestBase {
    uint8 internal constant CANONICAL_PROOF_SCHEMA_VERSION = 1;
    uint256 internal constant SOURCE_CHAIN_ID = 8453;
    uint256 internal constant SOURCE_BLOCK_NUMBER = 20_001;

    MockLightClientVerifier internal lightClientVerifier;
    MockAcrossBorrowFillEventVerifier internal eventVerifier;
    AcrossBorrowFillProofBackend internal backend;
    BorrowFillProofVerifier internal verifier;

    address internal sourceReceiver;
    address internal destinationFinalizer;

    function setUp() external {
        sourceReceiver = vm.addr(0xAA11);
        destinationFinalizer = vm.addr(0xBB22);

        lightClientVerifier = new MockLightClientVerifier();
        eventVerifier = new MockAcrossBorrowFillEventVerifier();
        backend = new AcrossBorrowFillProofBackend(address(this), lightClientVerifier, eventVerifier);
        backend.setSourceReceiver(SOURCE_CHAIN_ID, sourceReceiver);
        verifier = new BorrowFillProofVerifier(backend);
    }

    function test_revertsOnZeroBackendAddress() external {
        vm.expectRevert(abi.encodeWithSelector(BorrowFillProofVerifier.InvalidBackend.selector, address(0)));
        new BorrowFillProofVerifier(IAcrossBorrowFillProofBackend(address(0)));
    }

    function test_verifyBorrowAndWithdrawProofBindsWitnessToCanonicalSourceProof() external {
        bytes32 sourceBlockHash = keccak256("source-block");
        bytes32 receiptsRoot = keccak256("receipts-root");

        IBorrowFillProofVerifier.BorrowFillWitness memory borrowWitness =
            _witness(Constants.INTENT_BORROW, keccak256("borrow"));
        bytes memory borrowProof =
            _canonicalProof(borrowWitness, sourceReceiver, destinationFinalizer, block.chainid, sourceBlockHash, receiptsRoot);

        vm.prank(destinationFinalizer);
        bool ok = verifier.verifyBorrowFillProof(borrowProof, borrowWitness);
        assertTrue(ok, "expected borrow proof verification to pass");

        IBorrowFillProofVerifier.BorrowFillWitness memory withdrawWitness =
            _witness(Constants.INTENT_WITHDRAW, keccak256("withdraw"));
        bytes memory withdrawProof =
            _canonicalProof(withdrawWitness, sourceReceiver, destinationFinalizer, block.chainid, sourceBlockHash, receiptsRoot);

        vm.prank(destinationFinalizer);
        ok = verifier.verifyBorrowFillProof(withdrawProof, withdrawWitness);
        assertTrue(ok, "expected withdraw proof verification to pass");

        withdrawWitness.messageHash = keccak256("tampered");
        vm.prank(destinationFinalizer);
        ok = verifier.verifyBorrowFillProof(withdrawProof, withdrawWitness);
        assertTrue(!ok, "expected witness tamper to fail verification");
    }

    function test_verifyBorrowFillProofRejectsUnsupportedIntentType() external {
        IBorrowFillProofVerifier.BorrowFillWitness memory witness =
            _witness(Constants.INTENT_SUPPLY, keccak256("unsupported"));

        bytes memory proof = _canonicalProof(
            witness, sourceReceiver, destinationFinalizer, block.chainid, keccak256("block"), keccak256("receipts")
        );

        vm.prank(destinationFinalizer);
        bool ok = verifier.verifyBorrowFillProof(proof, witness);
        assertTrue(!ok, "unsupported intent type should fail");
    }

    function _witness(uint8 intentType, bytes32 intentTag)
        internal
        returns (IBorrowFillProofVerifier.BorrowFillWitness memory witness)
    {
        witness = IBorrowFillProofVerifier.BorrowFillWitness({
            sourceChainId: SOURCE_CHAIN_ID,
            intentId: keccak256(abi.encodePacked("intent", intentTag)),
            intentType: intentType,
            user: vm.addr(0xC001),
            recipient: vm.addr(0xC002),
            spokeToken: vm.addr(0xC003),
            hubAsset: vm.addr(0xC004),
            amount: 125e6,
            fee: 5e6,
            relayer: vm.addr(0xC005),
            sourceTxHash: keccak256(abi.encodePacked("tx", intentTag)),
            sourceLogIndex: 42,
            messageHash: keccak256(abi.encodePacked("msg", intentTag))
        });
    }

    function _canonicalProof(
        IBorrowFillProofVerifier.BorrowFillWitness memory witness,
        address sourceReceiver_,
        address hubFinalizer,
        uint256 destinationChainId,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot
    ) internal pure returns (bytes memory) {
        bytes memory finalityProof = abi.encode(
            MockLightClientVerifier.FinalityProofData({
                sourceChainId: witness.sourceChainId,
                sourceBlockNumber: SOURCE_BLOCK_NUMBER,
                sourceBlockHash: sourceBlockHash
            })
        );

        bytes memory inclusionProof = abi.encode(
            MockAcrossBorrowFillEventVerifier.BorrowFillInclusionPayload({
                sourceChainId: witness.sourceChainId,
                sourceBlockHash: sourceBlockHash,
                receiptsRoot: receiptsRoot,
                sourceTxHash: witness.sourceTxHash,
                sourceLogIndex: witness.sourceLogIndex,
                sourceReceiver: sourceReceiver_,
                intentId: witness.intentId,
                intentType: witness.intentType,
                user: witness.user,
                recipient: witness.recipient,
                spokeToken: witness.spokeToken,
                hubAsset: witness.hubAsset,
                amount: witness.amount,
                fee: witness.fee,
                relayer: witness.relayer,
                messageHash: witness.messageHash,
                destinationChainId: destinationChainId,
                hubFinalizer: hubFinalizer
            })
        );

        IAcrossBorrowFillProofBackend.CanonicalSourceProof memory canonical = IAcrossBorrowFillProofBackend
            .CanonicalSourceProof({
            sourceBlockNumber: SOURCE_BLOCK_NUMBER,
            sourceBlockHash: sourceBlockHash,
            receiptsRoot: receiptsRoot,
            sourceReceiver: sourceReceiver_,
            finalityProof: finalityProof,
            inclusionProof: inclusionProof
        });

        return abi.encode(CANONICAL_PROOF_SCHEMA_VERSION, abi.encode(canonical));
    }
}
