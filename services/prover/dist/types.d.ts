export type SupplyCreditAction = {
    kind: "supply";
    sourceChainId: bigint;
    depositId: bigint;
    user: `0x${string}`;
    hubAsset: `0x${string}`;
    amount: bigint;
};
export type RepayCreditAction = {
    kind: "repay";
    sourceChainId: bigint;
    depositId: bigint;
    user: `0x${string}`;
    hubAsset: `0x${string}`;
    amount: bigint;
};
export type BorrowFinalizeAction = {
    kind: "borrow";
    intentId: `0x${string}`;
    user: `0x${string}`;
    hubAsset: `0x${string}`;
    amount: bigint;
    fee: bigint;
    relayer: `0x${string}`;
};
export type WithdrawFinalizeAction = {
    kind: "withdraw";
    intentId: `0x${string}`;
    user: `0x${string}`;
    hubAsset: `0x${string}`;
    amount: bigint;
    fee: bigint;
    relayer: `0x${string}`;
};
export type QueuedAction = SupplyCreditAction | RepayCreditAction | BorrowFinalizeAction | WithdrawFinalizeAction;
export type SettlementBatchPayload = {
    batchId: bigint;
    hubChainId: bigint;
    spokeChainId: bigint;
    actionsRoot: `0x${string}`;
    supplyCredits: Array<{
        depositId: bigint;
        user: `0x${string}`;
        hubAsset: `0x${string}`;
        amount: bigint;
    }>;
    repayCredits: Array<{
        depositId: bigint;
        user: `0x${string}`;
        hubAsset: `0x${string}`;
        amount: bigint;
    }>;
    borrowFinalizations: Array<{
        intentId: `0x${string}`;
        user: `0x${string}`;
        hubAsset: `0x${string}`;
        amount: bigint;
        fee: bigint;
        relayer: `0x${string}`;
    }>;
    withdrawFinalizations: Array<{
        intentId: `0x${string}`;
        user: `0x${string}`;
        hubAsset: `0x${string}`;
        amount: bigint;
        fee: bigint;
        relayer: `0x${string}`;
    }>;
};
