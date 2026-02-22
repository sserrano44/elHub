import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { IntentType } from "@elhub/sdk";
import { JsonIndexerStore, SqliteIndexerStore } from "./store";
function makeIntent(partial) {
    return {
        intentId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        status: "initiated",
        user: "0x1111111111111111111111111111111111111111",
        intentType: IntentType.BORROW,
        amount: "1000",
        token: "0x2222222222222222222222222222222222222222",
        updatedAt: new Date().toISOString(),
        ...partial
    };
}
function makeDeposit(partial) {
    return {
        depositId: 42,
        user: "0x1111111111111111111111111111111111111111",
        intentType: IntentType.SUPPLY,
        token: "0x2222222222222222222222222222222222222222",
        amount: "500",
        status: "initiated",
        ...partial
    };
}
function createTmpPath(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `elhub-${name}-`));
    return path.join(dir, name);
}
function runSharedStoreContract(name, createStore) {
    test(`${name}: upserts and merges metadata`, () => {
        const store = createStore();
        const first = makeIntent({ metadata: { source: "relayer" } });
        const inserted = store.upsertIntent(first);
        assert.equal(inserted.status, "initiated");
        assert.deepEqual(inserted.metadata, { source: "relayer" });
        const updated = store.upsertIntent(makeIntent({
            intentId: first.intentId,
            status: "locked",
            metadata: { lockTx: "0xabc" }
        }));
        assert.equal(updated.status, "locked");
        assert.deepEqual(updated.metadata, { source: "relayer", lockTx: "0xabc" });
        const fromGet = store.getIntent(first.intentId);
        assert.ok(fromGet);
        assert.equal(fromGet.status, "locked");
        assert.deepEqual(fromGet.metadata, { source: "relayer", lockTx: "0xabc" });
    });
    test(`${name}: updates status patch and user filter`, () => {
        const store = createStore();
        const baseIntent = makeIntent({
            intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            user: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            metadata: { phase: "init" }
        });
        store.upsertIntent(baseIntent);
        const patched = store.updateIntentStatus(baseIntent.intentId, "settled", {
            metadata: { batchId: "7" },
            txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        });
        assert.ok(patched);
        assert.equal(patched.status, "settled");
        assert.deepEqual(patched.metadata, { phase: "init", batchId: "7" });
        const filtered = store.listIntents("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD");
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0]?.intentId, baseIntent.intentId);
    });
    test(`${name}: deposit upsert merges metadata`, () => {
        const store = createStore();
        const inserted = store.upsertDeposit(makeDeposit({ metadata: { step: "initiated" } }));
        assert.equal(inserted.status, "initiated");
        assert.deepEqual(inserted.metadata, { step: "initiated" });
        const pendingFill = store.upsertDeposit(makeDeposit({
            status: "pending_fill",
            metadata: { relayTx: "0x1234" }
        }));
        assert.equal(pendingFill.status, "pending_fill");
        assert.deepEqual(pendingFill.metadata, { step: "initiated", relayTx: "0x1234" });
        const bridged = store.upsertDeposit(makeDeposit({
            status: "bridged",
            metadata: { bridgeTx: "0x5678" }
        }));
        assert.equal(bridged.status, "bridged");
        assert.deepEqual(bridged.metadata, {
            step: "initiated",
            relayTx: "0x1234",
            bridgeTx: "0x5678"
        });
        const fromGet = store.getDeposit(42);
        assert.ok(fromGet);
        assert.equal(fromGet.status, "bridged");
    });
}
runSharedStoreContract("json-store", () => new JsonIndexerStore(createTmpPath("indexer.json")));
runSharedStoreContract("sqlite-store", () => new SqliteIndexerStore(createTmpPath("indexer.db")));
//# sourceMappingURL=store.test.js.map