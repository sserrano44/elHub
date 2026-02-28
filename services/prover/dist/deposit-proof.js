import { encodeAbiParameters } from "viem";
const CANONICAL_PROOF_SCHEMA_VERSION = 1;
export function buildCanonicalDepositProof(witness, source) {
    const finalityProof = encodeAbiParameters([
        { name: "sourceChainId", type: "uint256" },
        { name: "sourceBlockNumber", type: "uint256" },
        { name: "sourceBlockHash", type: "bytes32" }
    ], [witness.sourceChainId, source.sourceBlockNumber, source.sourceBlockHash]);
    const inclusionProof = encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "sourceChainId", type: "uint256" },
                { name: "sourceBlockHash", type: "bytes32" },
                { name: "receiptsRoot", type: "bytes32" },
                { name: "sourceTxHash", type: "bytes32" },
                { name: "sourceLogIndex", type: "uint256" },
                { name: "sourceSpokePool", type: "address" },
                { name: "inputToken", type: "address" },
                { name: "outputToken", type: "address" },
                { name: "outputAmount", type: "uint256" },
                { name: "destinationChainId", type: "uint256" },
                { name: "recipient", type: "address" },
                { name: "messageHash", type: "bytes32" }
            ]
        }
    ], [
        {
            sourceChainId: witness.sourceChainId,
            sourceBlockHash: source.sourceBlockHash,
            receiptsRoot: source.sourceReceiptsRoot,
            sourceTxHash: witness.sourceTxHash,
            sourceLogIndex: witness.sourceLogIndex,
            sourceSpokePool: source.sourceSpokePool,
            inputToken: witness.spokeToken,
            outputToken: witness.hubAsset,
            outputAmount: witness.amount,
            destinationChainId: source.destinationChainId,
            recipient: source.destinationReceiver,
            messageHash: witness.messageHash
        }
    ]);
    const payload = encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "sourceBlockNumber", type: "uint256" },
                { name: "sourceBlockHash", type: "bytes32" },
                { name: "receiptsRoot", type: "bytes32" },
                { name: "sourceSpokePool", type: "address" },
                { name: "finalityProof", type: "bytes" },
                { name: "inclusionProof", type: "bytes" }
            ]
        }
    ], [
        {
            sourceBlockNumber: source.sourceBlockNumber,
            sourceBlockHash: source.sourceBlockHash,
            receiptsRoot: source.sourceReceiptsRoot,
            sourceSpokePool: source.sourceSpokePool,
            finalityProof,
            inclusionProof
        }
    ]);
    return encodeAbiParameters([
        { name: "version", type: "uint8" },
        { name: "payload", type: "bytes" }
    ], [CANONICAL_PROOF_SCHEMA_VERSION, payload]);
}
export function buildCanonicalBorrowFillProof(witness, source) {
    const finalityProof = encodeAbiParameters([
        { name: "sourceChainId", type: "uint256" },
        { name: "sourceBlockNumber", type: "uint256" },
        { name: "sourceBlockHash", type: "bytes32" }
    ], [witness.sourceChainId, source.sourceBlockNumber, source.sourceBlockHash]);
    const inclusionProof = encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "sourceChainId", type: "uint256" },
                { name: "sourceBlockHash", type: "bytes32" },
                { name: "receiptsRoot", type: "bytes32" },
                { name: "sourceTxHash", type: "bytes32" },
                { name: "sourceLogIndex", type: "uint256" },
                { name: "sourceReceiver", type: "address" },
                { name: "intentId", type: "bytes32" },
                { name: "intentType", type: "uint8" },
                { name: "user", type: "address" },
                { name: "recipient", type: "address" },
                { name: "spokeToken", type: "address" },
                { name: "hubAsset", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "fee", type: "uint256" },
                { name: "relayer", type: "address" },
                { name: "messageHash", type: "bytes32" },
                { name: "destinationChainId", type: "uint256" },
                { name: "hubDispatcher", type: "address" },
                { name: "hubFinalizer", type: "address" }
            ]
        }
    ], [
        {
            sourceChainId: witness.sourceChainId,
            sourceBlockHash: source.sourceBlockHash,
            receiptsRoot: source.sourceReceiptsRoot,
            sourceTxHash: witness.sourceTxHash,
            sourceLogIndex: witness.sourceLogIndex,
            sourceReceiver: source.sourceReceiver,
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
            destinationChainId: source.destinationChainId,
            hubDispatcher: source.destinationDispatcher,
            hubFinalizer: source.destinationFinalizer
        }
    ]);
    const payload = encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "sourceBlockNumber", type: "uint256" },
                { name: "sourceBlockHash", type: "bytes32" },
                { name: "receiptsRoot", type: "bytes32" },
                { name: "sourceReceiver", type: "address" },
                { name: "finalityProof", type: "bytes" },
                { name: "inclusionProof", type: "bytes" }
            ]
        }
    ], [
        {
            sourceBlockNumber: source.sourceBlockNumber,
            sourceBlockHash: source.sourceBlockHash,
            receiptsRoot: source.sourceReceiptsRoot,
            sourceReceiver: source.sourceReceiver,
            finalityProof,
            inclusionProof
        }
    ]);
    return encodeAbiParameters([
        { name: "version", type: "uint8" },
        { name: "payload", type: "bytes" }
    ], [CANONICAL_PROOF_SCHEMA_VERSION, payload]);
}
//# sourceMappingURL=deposit-proof.js.map