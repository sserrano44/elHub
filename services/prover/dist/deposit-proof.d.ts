import { type Address, type Hex } from "viem";
export type DepositWitnessProofInput = {
    sourceChainId: bigint;
    depositId: bigint;
    intentType: number;
    user: Address;
    spokeToken: Address;
    hubAsset: Address;
    amount: bigint;
    sourceTxHash: Hex;
    sourceLogIndex: bigint;
    messageHash: Hex;
};
export type SourceDepositProofInput = {
    sourceBlockNumber: bigint;
    sourceBlockHash: Hex;
    sourceReceiptsRoot: Hex;
    sourceSpokePool: Address;
    destinationReceiver: Address;
    destinationChainId: bigint;
};
export type BorrowFillWitnessProofInput = {
    sourceChainId: bigint;
    intentId: Hex;
    intentType: number;
    user: Address;
    recipient: Address;
    spokeToken: Address;
    hubAsset: Address;
    amount: bigint;
    fee: bigint;
    relayer: Address;
    sourceTxHash: Hex;
    sourceLogIndex: bigint;
    messageHash: Hex;
};
export type SourceBorrowFillProofInput = {
    sourceBlockNumber: bigint;
    sourceBlockHash: Hex;
    sourceReceiptsRoot: Hex;
    sourceReceiver: Address;
    destinationDispatcher: Address;
    destinationFinalizer: Address;
    destinationChainId: bigint;
};
export declare function buildCanonicalDepositProof(witness: DepositWitnessProofInput, source: SourceDepositProofInput): Hex;
export declare function buildCanonicalBorrowFillProof(witness: BorrowFillWitnessProofInput, source: SourceBorrowFillProofInput): Hex;
