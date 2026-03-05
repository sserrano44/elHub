import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createInitialRelayerState, loadRelayerState, saveRelayerState } from "./finalization-state";
function createStatePath(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `elhub-relayer-${name}-`));
    return path.join(dir, `${name}.json`);
}
test("loadRelayerState initializes missing file with defaults", () => {
    const filePath = createStatePath("missing");
    const state = loadRelayerState(filePath);
    assert.equal(state.version, 2);
    assert.equal(state.lastSpokeBlock, 0n);
    assert.equal(state.lastHubBlock, 0n);
    assert.deepEqual(state.tasks, {});
    assert.equal(fs.existsSync(filePath), true);
});
test("saveRelayerState round-trips task queue and cursors", () => {
    const filePath = createStatePath("roundtrip");
    const initial = createInitialRelayerState();
    const now = Date.now();
    const state = {
        ...initial,
        lastSpokeBlock: 123n,
        lastHubBlock: 456n,
        tasks: {
            "deposit:0xabc": {
                id: "deposit:0xabc",
                kind: "deposit_finalization",
                payload: { pendingId: "0xabc" },
                attempts: 2,
                nextAttemptAt: now + 1_000,
                createdAt: now,
                updatedAt: now,
                lastError: "rpc timeout"
            },
            "lock-unwind:0xdef": {
                id: "lock-unwind:0xdef",
                kind: "lock_unwind",
                payload: { intentId: "0xdef", lockExpiry: "123" },
                attempts: 1,
                nextAttemptAt: now + 2_000,
                createdAt: now,
                updatedAt: now
            }
        }
    };
    saveRelayerState(filePath, state);
    const loaded = loadRelayerState(filePath);
    assert.equal(loaded.lastSpokeBlock, 123n);
    assert.equal(loaded.lastHubBlock, 456n);
    assert.equal(Object.keys(loaded.tasks).length, 2);
    assert.equal(loaded.tasks["deposit:0xabc"]?.kind, "deposit_finalization");
    assert.equal(loaded.tasks["deposit:0xabc"]?.attempts, 2);
    assert.equal(loaded.tasks["lock-unwind:0xdef"]?.kind, "lock_unwind");
});
test("loadRelayerState migrates legacy cursor-only tracking format", () => {
    const filePath = createStatePath("legacy");
    fs.writeFileSync(filePath, JSON.stringify({
        lastSpokeBlock: "77",
        lastHubBlock: "88"
    }));
    const state = loadRelayerState(filePath);
    assert.equal(state.version, 2);
    assert.equal(state.lastSpokeBlock, 77n);
    assert.equal(state.lastHubBlock, 88n);
    assert.deepEqual(state.tasks, {});
});
test("loadRelayerState ignores malformed files", () => {
    const filePath = createStatePath("malformed");
    fs.writeFileSync(filePath, "{not-json");
    const state = loadRelayerState(filePath);
    assert.equal(state.version, 2);
    assert.equal(state.lastSpokeBlock, 0n);
    assert.equal(state.lastHubBlock, 0n);
    assert.deepEqual(state.tasks, {});
});
test("loadRelayerState sanitizes invalid tasks", () => {
    const filePath = createStatePath("sanitize");
    fs.writeFileSync(filePath, JSON.stringify({
        version: 2,
        lastSpokeBlock: "10",
        lastHubBlock: "20",
        tasks: {
            valid: {
                id: "valid",
                kind: "deposit_finalization",
                payload: { pendingId: "0x1" },
                attempts: 1,
                nextAttemptAt: 100,
                createdAt: 50,
                updatedAt: 60
            },
            invalid_missing_payload: {
                id: "invalid_missing_payload",
                kind: "deposit_finalization",
                attempts: 1,
                nextAttemptAt: 100,
                createdAt: 50,
                updatedAt: 60
            }
        }
    }));
    const state = loadRelayerState(filePath);
    assert.equal(Object.keys(state.tasks).length, 1);
    assert.equal(state.tasks.valid?.id, "valid");
});
//# sourceMappingURL=finalization-state.test.js.map