// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {IDepositProofVerifier} from "../src/interfaces/IDepositProofVerifier.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {DepositProofVerifier} from "../src/zk/DepositProofVerifier.sol";

contract MockGenericVerifier is IVerifier {
    bytes32 public expectedProofHash;
    bytes32 public expectedInputsHash;
    bool public result;

    function configure(bytes calldata proof, uint256[] calldata publicInputs, bool result_) external {
        expectedProofHash = keccak256(proof);
        expectedInputsHash = keccak256(abi.encode(publicInputs));
        result = result_;
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicInputs) external view returns (bool) {
        if (!result) return false;
        return keccak256(proof) == expectedProofHash && keccak256(abi.encode(publicInputs)) == expectedInputsHash;
    }
}

contract DepositProofVerifierTest is TestBase {
    MockGenericVerifier internal backend;
    DepositProofVerifier internal verifier;

    function setUp() external {
        backend = new MockGenericVerifier();
        verifier = new DepositProofVerifier(backend);
    }

    function test_revertsOnZeroVerifierAddress() external {
        vm.expectRevert(abi.encodeWithSelector(DepositProofVerifier.InvalidVerifier.selector, address(0)));
        new DepositProofVerifier(IVerifier(address(0)));
    }

    function test_verifyDepositProofDelegatesWithDeterministicPublicInputs() external {
        bytes memory proof = bytes("ZKHUB_DEV_PROOF");
        IDepositProofVerifier.DepositWitness memory witness = IDepositProofVerifier.DepositWitness({
            sourceChainId: 8453,
            depositId: 11,
            intentType: 1,
            user: vm.addr(0xBEEF),
            hubAsset: vm.addr(0xCAFE),
            amount: 55e6,
            sourceTxHash: keccak256("src-tx"),
            sourceLogIndex: 19,
            messageHash: keccak256("message")
        });

        uint256[4] memory inputsFixed = verifier.publicInputsForWitness(witness);
        uint256[] memory inputs = new uint256[](4);
        for (uint256 i = 0; i < 4; i++) {
            inputs[i] = inputsFixed[i];
        }
        backend.configure(proof, inputs, true);

        bool ok = verifier.verifyDepositProof(proof, witness);
        assertTrue(ok, "expected proof verification to pass with matching witness/public inputs");

        witness.messageHash = keccak256("tampered");
        ok = verifier.verifyDepositProof(proof, witness);
        assertTrue(!ok, "expected proof verification to fail for tampered witness");
    }
}

