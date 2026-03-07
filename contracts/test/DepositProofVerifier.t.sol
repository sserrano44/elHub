// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {IDepositProofVerifier} from "../src/interfaces/IDepositProofVerifier.sol";
import {IAcrossDepositProofBackend} from "../src/interfaces/IAcrossDepositProofBackend.sol";
import {IAcrossDepositEventVerifier} from "../src/interfaces/IAcrossDepositEventVerifier.sol";
import {ILightClientVerifier} from "../src/interfaces/ILightClientVerifier.sol";
import {DepositProofVerifier} from "../src/zk/DepositProofVerifier.sol";
import {AcrossDepositProofBackend} from "../src/zk/AcrossDepositProofBackend.sol";
import {MockLightClientVerifier} from "../src/mocks/MockLightClientVerifier.sol";
import {MockAcrossDepositEventVerifier} from "../src/mocks/MockAcrossDepositEventVerifier.sol";

contract RevertingDepositLightClientVerifier is ILightClientVerifier {
    function verifyFinalizedBlock(uint256, uint256, bytes32, bytes calldata) external pure returns (bool) {
        revert("light-client-revert");
    }
}

contract RevertingAcrossDepositEventVerifier is IAcrossDepositEventVerifier {
    function verifyV3FundsDeposited(
        uint256,
        bytes32,
        bytes32,
        bytes32,
        uint256,
        address,
        address,
        bytes32,
        address,
        uint256,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bool) {
        revert("event-verifier-revert");
    }
}

contract DepositProofVerifierTest is TestBase {
    uint8 internal constant CANONICAL_PROOF_SCHEMA_VERSION = 1;
    uint256 internal constant SOURCE_CHAIN_ID = 8453;

    MockLightClientVerifier internal lightClientVerifier;
    MockAcrossDepositEventVerifier internal eventVerifier;
    AcrossDepositProofBackend internal backend;
    DepositProofVerifier internal verifier;

    address internal sourceSpokePool;
    address internal destinationReceiver;

    function setUp() external {
        sourceSpokePool = vm.addr(0xAA11);
        destinationReceiver = vm.addr(0xBB22);

        lightClientVerifier = new MockLightClientVerifier();
        eventVerifier = new MockAcrossDepositEventVerifier();
        backend = new AcrossDepositProofBackend(address(this), lightClientVerifier, eventVerifier);
        backend.setSourceSpokePool(SOURCE_CHAIN_ID, sourceSpokePool);
        verifier = new DepositProofVerifier(backend);
    }

    function test_revertsOnZeroBackendAddress() external {
        vm.expectRevert(abi.encodeWithSelector(DepositProofVerifier.InvalidBackend.selector, address(0)));
        new DepositProofVerifier(IAcrossDepositProofBackend(address(0)));
    }

    function test_verifyDepositProofBindsWitnessToCanonicalSourceProof() external {
        IDepositProofVerifier.DepositWitness memory witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: SOURCE_CHAIN_ID,
            depositId: 11,
            intentType: 1,
            user: vm.addr(0xBEEF),
            spokeToken: vm.addr(0x1111),
            hubAsset: vm.addr(0x2222),
            amount: 55e6,
            sourceTxHash: keccak256("src-tx"),
            sourceLogIndex: 19,
            messageHash: keccak256("message")
        });

        bytes memory proof = _canonicalProof(
            witness, sourceSpokePool, destinationReceiver, block.chainid, 1_001, keccak256("block"), keccak256("receipts")
        );

        vm.prank(destinationReceiver);
        bool ok = verifier.verifyDepositProof(proof, witness);
        assertTrue(ok, "expected canonical proof verification to pass");

        witness.messageHash = keccak256("tampered");
        vm.prank(destinationReceiver);
        ok = verifier.verifyDepositProof(proof, witness);
        assertTrue(!ok, "expected canonical proof verification to fail for tampered witness");
    }

    function test_verifyDepositProofRejectsUnsupportedSourceChain() external {
        IDepositProofVerifier.DepositWitness memory witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: 56,
            depositId: 77,
            intentType: 1,
            user: vm.addr(0xCAFE),
            spokeToken: vm.addr(0x1234),
            hubAsset: vm.addr(0x5678),
            amount: 99e6,
            sourceTxHash: keccak256("src-tx"),
            sourceLogIndex: 7,
            messageHash: keccak256("msg")
        });

        bytes memory proof = _canonicalProof(
            witness, vm.addr(0xBEEF), destinationReceiver, block.chainid, 200, keccak256("block"), keccak256("receipts")
        );

        vm.prank(destinationReceiver);
        bool ok = verifier.verifyDepositProof(proof, witness);
        assertTrue(!ok, "expected unsupported source chain to fail");
    }

    function test_verifyDepositProofReturnsFalseWhenLightClientVerifierReverts() external {
        RevertingDepositLightClientVerifier revertingLight = new RevertingDepositLightClientVerifier();
        AcrossDepositProofBackend revertingBackend =
            new AcrossDepositProofBackend(address(this), revertingLight, eventVerifier);
        revertingBackend.setSourceSpokePool(SOURCE_CHAIN_ID, sourceSpokePool);
        DepositProofVerifier revertingVerifier = new DepositProofVerifier(revertingBackend);

        IDepositProofVerifier.DepositWitness memory witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: SOURCE_CHAIN_ID,
            depositId: 42,
            intentType: 1,
            user: vm.addr(0xDEAD),
            spokeToken: vm.addr(0x1111),
            hubAsset: vm.addr(0x2222),
            amount: 1e6,
            sourceTxHash: keccak256("src"),
            sourceLogIndex: 3,
            messageHash: keccak256("msg")
        });

        bytes memory proof = _canonicalProof(
            witness, sourceSpokePool, destinationReceiver, block.chainid, 301, keccak256("b"), keccak256("r")
        );

        vm.prank(destinationReceiver);
        bool ok = revertingVerifier.verifyDepositProof(proof, witness);
        assertTrue(!ok, "reverting light client verifier should fail safely");
    }

    function test_verifyDepositProofReturnsFalseWhenEventVerifierReverts() external {
        RevertingAcrossDepositEventVerifier revertingEvent = new RevertingAcrossDepositEventVerifier();
        AcrossDepositProofBackend revertingBackend =
            new AcrossDepositProofBackend(address(this), lightClientVerifier, revertingEvent);
        revertingBackend.setSourceSpokePool(SOURCE_CHAIN_ID, sourceSpokePool);
        DepositProofVerifier revertingVerifier = new DepositProofVerifier(revertingBackend);

        IDepositProofVerifier.DepositWitness memory witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: SOURCE_CHAIN_ID,
            depositId: 43,
            intentType: 1,
            user: vm.addr(0xBEEF),
            spokeToken: vm.addr(0x3333),
            hubAsset: vm.addr(0x4444),
            amount: 2e6,
            sourceTxHash: keccak256("src2"),
            sourceLogIndex: 4,
            messageHash: keccak256("msg2")
        });

        bytes memory proof = _canonicalProof(
            witness, sourceSpokePool, destinationReceiver, block.chainid, 302, keccak256("b2"), keccak256("r2")
        );

        vm.prank(destinationReceiver);
        bool ok = revertingVerifier.verifyDepositProof(proof, witness);
        assertTrue(!ok, "reverting event verifier should fail safely");
    }

    function _canonicalProof(
        IDepositProofVerifier.DepositWitness memory witness,
        address sourceSpokePool_,
        address recipient,
        uint256 destinationChainId,
        uint256 sourceBlockNumber,
        bytes32 sourceBlockHash,
        bytes32 receiptsRoot
    ) internal pure returns (bytes memory) {
        bytes memory finalityProof = abi.encode(
            MockLightClientVerifier.FinalityProofData({
                sourceChainId: witness.sourceChainId,
                sourceBlockNumber: sourceBlockNumber,
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
                sourceSpokePool: sourceSpokePool_,
                inputToken: witness.spokeToken,
                outputToken: witness.hubAsset,
                outputAmount: witness.amount,
                destinationChainId: destinationChainId,
                recipient: recipient,
                messageHash: witness.messageHash
            })
        );

        IAcrossDepositProofBackend.CanonicalSourceProof memory canonical = IAcrossDepositProofBackend.CanonicalSourceProof({
            sourceBlockNumber: sourceBlockNumber,
            sourceBlockHash: sourceBlockHash,
            receiptsRoot: receiptsRoot,
            sourceSpokePool: sourceSpokePool_,
            finalityProof: finalityProof,
            inclusionProof: inclusionProof
        });

        return abi.encode(CANONICAL_PROOF_SCHEMA_VERSION, abi.encode(canonical));
    }
}
