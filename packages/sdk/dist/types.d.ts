export declare enum IntentType {
    SUPPLY = 1,
    REPAY = 2,
    BORROW = 3,
    WITHDRAW = 4
}
export type Intent = {
    intentType: IntentType;
    user: `0x${string}`;
    inputChainId: bigint;
    outputChainId: bigint;
    inputToken: `0x${string}`;
    outputToken: `0x${string}`;
    amount: bigint;
    recipient: `0x${string}`;
    maxRelayerFee: bigint;
    nonce: bigint;
    deadline: bigint;
};
export type IntentStatus = "initiated" | "pending_lock" | "locked" | "filled" | "awaiting_settlement" | "expired_unwound" | "settled" | "failed";
export type IntentLifecycle = {
    intentId: `0x${string}`;
    status: IntentStatus;
    user: `0x${string}`;
    intentType: IntentType;
    amount: string;
    token: string;
    txHash?: `0x${string}`;
    metadata?: Record<string, unknown>;
    updatedAt: string;
};
export type ProtocolAddresses = {
    hub: {
        moneyMarket: `0x${string}`;
        riskManager: `0x${string}`;
        intentInbox: `0x${string}`;
        lockManager: `0x${string}`;
        settlement: `0x${string}`;
        custody: `0x${string}`;
        tokenRegistry: `0x${string}`;
    };
    spoke: {
        portal: `0x${string}`;
        bridgeAdapter: `0x${string}`;
    };
};
