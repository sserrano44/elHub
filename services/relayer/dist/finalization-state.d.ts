export type FinalizationTaskKind = "deposit_finalization" | "borrow_fill_finalization" | "lock_unwind";
export type FinalizationTask = {
    id: string;
    kind: FinalizationTaskKind;
    payload: Record<string, unknown>;
    attempts: number;
    nextAttemptAt: number;
    createdAt: number;
    updatedAt: number;
    terminal?: boolean;
    terminalReason?: string;
    lastError?: string;
};
export type RelayerPersistentState = {
    version: 2;
    lastSpokeBlock: bigint;
    lastHubBlock: bigint;
    tasks: Record<string, FinalizationTask>;
};
export declare function createInitialRelayerState(): RelayerPersistentState;
export declare function loadRelayerState(filePath: string): RelayerPersistentState;
export declare function saveRelayerState(filePath: string, state: RelayerPersistentState): void;
