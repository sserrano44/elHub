// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {IVerifier} from "../interfaces/IVerifier.sol";

interface IGroth16Verifier {
    function verifyProof(bytes calldata proof, uint256[] calldata publicInputs) external view returns (bool);
}

contract Verifier is Ownable, Initializable, UUPSUpgradeable, IVerifier {
    bool public immutable DEV_MODE;
    bytes32 public immutable DEV_PROOF_HASH;
    uint256 public immutable PUBLIC_INPUT_COUNT;

    IGroth16Verifier public groth16Verifier;

    event Groth16VerifierSet(address indexed verifier);

    error InvalidDevProofHash();
    error InvalidPublicInputCount(uint256 got, uint256 expected);
    error EmptyProof();
    error InvalidVerifierContract(address verifier);
    error RealVerifierRequired();

    constructor(
        address owner_,
        bool devMode,
        bytes32 devProofHash,
        address initialGroth16Verifier,
        uint256 publicInputCount
    ) Ownable(owner_) {
        if (publicInputCount == 0) revert InvalidPublicInputCount(0, 1);
        DEV_MODE = devMode;
        DEV_PROOF_HASH = devProofHash;
        PUBLIC_INPUT_COUNT = publicInputCount;

        if (DEV_MODE && devProofHash == bytes32(0)) {
            revert InvalidDevProofHash();
        }
        if (!DEV_MODE && initialGroth16Verifier == address(0)) {
            revert RealVerifierRequired();
        }
        if (initialGroth16Verifier != address(0) && initialGroth16Verifier.code.length == 0) {
            revert InvalidVerifierContract(initialGroth16Verifier);
        }

        groth16Verifier = IGroth16Verifier(initialGroth16Verifier);
        _disableInitializers();
    }

    function initializeProxy(address owner_, address initialGroth16Verifier) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);

        if (!DEV_MODE && initialGroth16Verifier == address(0)) {
            revert RealVerifierRequired();
        }
        if (initialGroth16Verifier != address(0) && initialGroth16Verifier.code.length == 0) {
            revert InvalidVerifierContract(initialGroth16Verifier);
        }

        groth16Verifier = IGroth16Verifier(initialGroth16Verifier);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setGroth16Verifier(address verifier) external onlyOwner {
        if (verifier == address(0) || verifier.code.length == 0) {
            revert InvalidVerifierContract(verifier);
        }
        groth16Verifier = IGroth16Verifier(verifier);
        emit Groth16VerifierSet(verifier);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicInputs) external view returns (bool) {
        if (proof.length == 0) revert EmptyProof();
        if (publicInputs.length != PUBLIC_INPUT_COUNT) {
            revert InvalidPublicInputCount(publicInputs.length, PUBLIC_INPUT_COUNT);
        }

        if (DEV_MODE) {
            return keccak256(proof) == DEV_PROOF_HASH;
        }
        if (address(groth16Verifier) == address(0)) revert RealVerifierRequired();
        return groth16Verifier.verifyProof(proof, publicInputs);
    }
}
