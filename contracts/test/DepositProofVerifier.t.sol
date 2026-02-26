// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {IDepositProofVerifier} from "../src/interfaces/IDepositProofVerifier.sol";
import {IAcrossDepositProofBackend} from "../src/interfaces/IAcrossDepositProofBackend.sol";
import {DepositProofVerifier} from "../src/zk/DepositProofVerifier.sol";
import {AcrossDepositProofBackend} from "../src/zk/AcrossDepositProofBackend.sol";
import {MockLightClientVerifier} from "../src/mocks/MockLightClientVerifier.sol";
import {MockAcrossDepositEventVerifier} from "../src/mocks/MockAcrossDepositEventVerifier.sol";

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
