import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { QueuedAction } from "./types";
import {
  JsonProverQueueStore,
  SqliteProverQueueStore,
  type ProverQueueStore
} from "./queue-store";

function createTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `elhub-${prefix}-`));
}

function makeSupplyAction(partial?: Partial<QueuedAction>): QueuedAction {
  return {
    kind: "supply",
    sourceChainId: 8453n,
    depositId: 1n,
    user: "0x1111111111111111111111111111111111111111",
    hubAsset: "0x2222222222222222222222222222222222222222",
    amount: 100n,
    ...partial
  } as QueuedAction;
}

function makeBorrowAction(partial?: Partial<QueuedAction>): QueuedAction {
  return {
    kind: "borrow",
    intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    user: "0x1111111111111111111111111111111111111111",
    hubAsset: "0x2222222222222222222222222222222222222222",
    amount: 50n,
    fee: 2n,
    relayer: "0x3333333333333333333333333333333333333333",
    ...partial
  } as QueuedAction;
}

function runQueueStoreContract(name: string, createStore: () => ProverQueueStore) {
  test(`${name}: enqueue dedupe and ordered peek`, () => {
    const store = createStore();
    assert.equal(store.getNextBatchId(9n), 9n);

    assert.equal(store.enqueue(makeSupplyAction()), "enqueued");
    assert.equal(store.enqueue(makeSupplyAction()), "duplicate");
    assert.equal(store.enqueue(makeSupplyAction({ sourceChainId: 56n })), "enqueued");
    assert.equal(
      store.enqueue(
        makeBorrowAction({
          intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        })
      ),
      "enqueued"
    );

    assert.equal(store.getQueuedCount(), 3);
    const records = store.peek(10);
    assert.equal(records.length, 3);
    assert.equal(records[0]?.action.kind, "supply");
    assert.equal(records[1]?.action.kind, "supply");
    assert.equal(records[2]?.action.kind, "borrow");
  });

  test(`${name}: markSettled removes actions and updates batch cursor`, () => {
    const store = createStore();
    assert.equal(store.getNextBatchId(3n), 9n);

    store.enqueue(
      makeBorrowAction({
        intentId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      })
    );
    store.enqueue(
      makeBorrowAction({
        intentId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      })
    );

    const before = store.peek(2);
    assert.equal(before.length, 2);

    store.markSettled([before[0]!], 4n);
    assert.equal(store.getNextBatchId(1n), 4n);
    assert.equal(store.getQueuedCount(), 1);

    const after = store.peek(10);
    assert.equal(after.length, 1);
    assert.equal(
      after[0]?.action.kind === "borrow" ? after[0].action.intentId : "",
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    );
  });
}

runQueueStoreContract("json-queue-store", () => {
  const dir = createTmpDir("prover-json");
  return new JsonProverQueueStore(
    path.join(dir, "queue.json"),
    path.join(dir, "state.json"),
    9n
  );
});

runQueueStoreContract("sqlite-queue-store", () => {
  const dir = createTmpDir("prover-sqlite");
  return new SqliteProverQueueStore(path.join(dir, "prover.db"), 9n);
});
