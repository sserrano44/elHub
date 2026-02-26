// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {EIP712} from "@openzeppelin/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/utils/cryptography/ECDSA.sol";
import {DataTypes} from "../libraries/DataTypes.sol";
import {IntentHasher} from "../libraries/IntentHasher.sol";

contract HubIntentInbox is Ownable, Initializable, UUPSUpgradeable, EIP712 {
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(address => bool) public isConsumer;

    event ConsumerSet(address indexed consumer, bool allowed);
    event IntentReceived(
        bytes32 indexed intentId,
        uint8 indexed intentType,
        address indexed user,
        uint256 nonce,
        uint256 deadline,
        uint256 inputChainId,
        uint256 outputChainId,
        address inputToken,
        address outputToken,
        uint256 amount,
        address recipient,
        uint256 maxRelayerFee
    );

    error IntentExpired(uint256 deadline, uint256 currentTimestamp);
    error InvalidIntentSigner(address recoveredSigner, address expectedSigner);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error NotConsumer(address caller);

    modifier onlyConsumer() {
        if (!isConsumer[msg.sender]) revert NotConsumer(msg.sender);
        _;
    }

    constructor(address owner_) Ownable(owner_) EIP712("ElHubIntentInbox", "1") {
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setConsumer(address consumer, bool allowed) external onlyOwner {
        isConsumer[consumer] = allowed;
        emit ConsumerSet(consumer, allowed);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getIntentId(DataTypes.Intent calldata intent) external pure returns (bytes32) {
        return IntentHasher.rawIntentId(intent);
    }

    function verifyIntent(DataTypes.Intent calldata intent, bytes calldata signature)
        public
        view
        returns (bytes32 digest, bytes32 intentId)
    {
        if (block.timestamp > intent.deadline) {
            revert IntentExpired(intent.deadline, block.timestamp);
        }

        bytes32 structHash = IntentHasher.hashIntentStruct(intent);
        digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != intent.user) {
            revert InvalidIntentSigner(signer, intent.user);
        }

        intentId = IntentHasher.rawIntentId(intent);
    }

    function consumeIntent(DataTypes.Intent calldata intent, bytes calldata signature)
        external
        onlyConsumer
        returns (bytes32 intentId)
    {
        (, intentId) = verifyIntent(intent, signature);

        if (nonceUsed[intent.user][intent.nonce]) {
            revert NonceAlreadyUsed(intent.user, intent.nonce);
        }

        nonceUsed[intent.user][intent.nonce] = true;

        emit IntentReceived(
            intentId,
            intent.intentType,
            intent.user,
            intent.nonce,
            intent.deadline,
            intent.inputChainId,
            intent.outputChainId,
            intent.inputToken,
            intent.outputToken,
            intent.amount,
            intent.recipient,
            intent.maxRelayerFee
        );
    }
}
