import type { IntentLifecycle, IntentStatus } from "@elhub/sdk";
export type DepositState = {
    depositId: number;
    user: `0x${string}`;
    intentType: number;
    token: `0x${string}`;
    amount: string;
    status: "initiated" | "pending_fill" | "bridged" | "settled";
    metadata?: Record<string, unknown>;
    updatedAt: string;
};
export type DepositInput = Omit<DepositState, "updatedAt"> & {
    updatedAt?: string;
};
export interface IndexerStore {
    upsertIntent(intent: IntentLifecycle): IntentLifecycle;
    updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null;
    getIntent(intentId: string): IntentLifecycle | null;
    listIntents(user?: string): IntentLifecycle[];
    upsertDeposit(dep: DepositInput): DepositState;
    getDeposit(depositId: number): DepositState | null;
}
export declare class JsonIndexerStore implements IndexerStore {
    private readonly filePath;
    private state;
    constructor(filePath: string);
    upsertIntent(intent: IntentLifecycle): IntentLifecycle;
    updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null;
    getIntent(intentId: string): IntentLifecycle | null;
    listIntents(user?: string): IntentLifecycle[];
    upsertDeposit(dep: DepositInput): DepositState;
    getDeposit(depositId: number): DepositState | null;
    private load;
    private save;
}
export declare class SqliteIndexerStore implements IndexerStore {
    private readonly db;
    constructor(filePath: string);
    upsertIntent(intent: IntentLifecycle): IntentLifecycle;
    updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null;
    getIntent(intentId: string): IntentLifecycle | null;
    listIntents(user?: string): IntentLifecycle[];
    upsertDeposit(dep: DepositInput): DepositState;
    getDeposit(depositId: number): DepositState | null;
}
