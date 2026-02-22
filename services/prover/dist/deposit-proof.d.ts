import type { Address, Hex } from "viem";
import type { SettlementBatchPayload } from "./types";
export type DepositWitnessProofInput = {
    sourceChainId: bigint;
    depositId: bigint;
    intentType: number;
    user: Address;
    hubAsset: Address;
    amount: bigint;
    sourceTxHash: Hex;
    sourceLogIndex: bigint;
    messageHash: Hex;
};
export declare function buildDepositProofBatch(witness: DepositWitnessProofInput): SettlementBatchPayload;
