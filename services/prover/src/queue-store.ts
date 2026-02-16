import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QueuedAction } from "./types";

export type QueuedActionRecord = {
  id: number;
  key: string;
  action: QueuedAction;
};

export interface ProverQueueStore {
  getNextBatchId(fallback: bigint): bigint;
  getQueuedCount(): number;
  enqueue(action: QueuedAction): "enqueued" | "duplicate";
  peek(limit: number): QueuedActionRecord[];
  markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void;
}

type ProverState = {
  nextBatchId: bigint;
};

type SqliteQueueRow = {
  id: number;
  action_key: string;
  payload_json: string;
};

export class JsonProverQueueStore implements ProverQueueStore {
  private readonly queuePath: string;
  private readonly statePath: string;
  private queue: QueuedAction[];
  private state: ProverState;

  constructor(queuePath: string, statePath: string, initialBatchId: bigint) {
    this.queuePath = queuePath;
    this.statePath = statePath;
    this.queue = loadQueue(queuePath);
    this.state = loadState(statePath, initialBatchId);
  }

  getNextBatchId(fallback: bigint): bigint {
    const next = this.state.nextBatchId > 0n ? this.state.nextBatchId : fallback;
    if (next !== this.state.nextBatchId) {
      this.state.nextBatchId = next;
      saveState(this.statePath, this.state);
    }
    return next;
  }

  getQueuedCount(): number {
    return this.queue.length;
  }

  enqueue(action: QueuedAction): "enqueued" | "duplicate" {
    const key = actionKey(action);
    const exists = this.queue.some((item) => actionKey(item) === key);
    if (exists) return "duplicate";
    this.queue.push(action);
    saveQueue(this.queuePath, this.queue);
    return "enqueued";
  }

  peek(limit: number): QueuedActionRecord[] {
    return this.queue.slice(0, limit).map((action, index) => ({
      id: index + 1,
      key: actionKey(action),
      action
    }));
  }

  markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void {
    if (records.length > 0) {
      this.queue.splice(0, records.length);
      saveQueue(this.queuePath, this.queue);
    }
    this.state.nextBatchId = nextBatchId;
    saveState(this.statePath, this.state);
  }
}

export class SqliteProverQueueStore implements ProverQueueStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, initialBatchId: bigint) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prover_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        next_batch_id TEXT NOT NULL
      );
    `);
    this.db.prepare(
      `
      INSERT INTO prover_state (id, next_batch_id)
      VALUES (1, ?)
      ON CONFLICT(id) DO NOTHING
      `
    ).run(initialBatchId.toString());
  }

  getNextBatchId(fallback: bigint): bigint {
    const row = this.db.prepare(
      "SELECT next_batch_id FROM prover_state WHERE id = 1"
    ).get() as { next_batch_id: string } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO prover_state (id, next_batch_id) VALUES (1, ?)").run(fallback.toString());
      return fallback;
    }
    return BigInt(row.next_batch_id);
  }

  getQueuedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM queue_actions").get() as { total: number } | undefined;
    return row?.total ?? 0;
  }

  enqueue(action: QueuedAction): "enqueued" | "duplicate" {
    const key = actionKey(action);
    const result = this.db.prepare(
      `
      INSERT OR IGNORE INTO queue_actions (action_key, payload_json, created_at)
      VALUES (?, ?, ?)
      `
    ).run(key, serializeAction(action), new Date().toISOString());
    return result.changes > 0 ? "enqueued" : "duplicate";
  }

  peek(limit: number): QueuedActionRecord[] {
    const rows = this.db.prepare(
      `
      SELECT id, action_key, payload_json
      FROM queue_actions
      ORDER BY id ASC
      LIMIT ?
      `
    ).all(limit) as SqliteQueueRow[];

    return rows.map((row) => ({
      id: row.id,
      key: row.action_key,
      action: deserializeAction(row.payload_json)
    }));
  }

  markSettled(records: QueuedActionRecord[], nextBatchId: bigint): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (records.length > 0) {
        const deleteStmt = this.db.prepare("DELETE FROM queue_actions WHERE id = ?");
        for (const record of records) {
          deleteStmt.run(record.id);
        }
      }
      this.db.prepare(
        `
        INSERT INTO prover_state (id, next_batch_id)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET next_batch_id = excluded.next_batch_id
        `
      ).run(nextBatchId.toString());
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function loadQueue(filePath: string): QueuedAction[] {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]");
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<Record<string, unknown>>;
    return raw.map((entry) => normalizeQueuedAction(entry));
  } catch {
    return [];
  }
}

function saveQueue(filePath: string, actions: QueuedAction[]) {
  const json = actions.map((action) => JSON.parse(serializeAction(action)));
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
}

function loadState(filePath: string, fallback: bigint): ProverState {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    const initial = { nextBatchId: fallback };
    saveState(filePath, initial);
    return initial;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { nextBatchId?: string };
    return { nextBatchId: BigInt(raw.nextBatchId ?? fallback.toString()) };
  } catch {
    return { nextBatchId: fallback };
  }
}

function saveState(filePath: string, state: ProverState) {
  fs.writeFileSync(filePath, JSON.stringify({ nextBatchId: state.nextBatchId.toString() }, null, 2));
}

function serializeAction(action: QueuedAction): string {
  return JSON.stringify(action, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

function deserializeAction(payload: string): QueuedAction {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  return normalizeQueuedAction(parsed);
}

function normalizeQueuedAction(input: Record<string, unknown>): QueuedAction {
  const kind = asString(input.kind);
  switch (kind) {
    case "supply":
    case "repay":
      return {
        kind,
        depositId: BigInt(asString(input.depositId)),
        user: asHex(input.user),
        hubAsset: asHex(input.hubAsset),
        amount: BigInt(asString(input.amount))
      };
    case "borrow":
    case "withdraw":
      return {
        kind,
        intentId: asHex(input.intentId),
        user: asHex(input.user),
        hubAsset: asHex(input.hubAsset),
        amount: BigInt(asString(input.amount)),
        fee: BigInt(asString(input.fee)),
        relayer: asHex(input.relayer)
      };
    default:
      throw new Error(`Unknown queued action kind: ${String(input.kind)}`);
  }
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error(`Expected string value, got ${typeof value}`);
}

function asHex(value: unknown): `0x${string}` {
  const raw = asString(value);
  if (!raw.startsWith("0x")) {
    throw new Error(`Expected hex value, got ${raw}`);
  }
  return raw as `0x${string}`;
}

export function actionKey(action: QueuedAction): string {
  switch (action.kind) {
    case "supply":
    case "repay":
      return `${action.kind}:${action.depositId.toString()}:${action.user}:${action.hubAsset}:${action.amount.toString()}`;
    case "borrow":
    case "withdraw":
      return `${action.kind}:${action.intentId}:${action.user}:${action.hubAsset}:${action.amount.toString()}:${action.fee.toString()}:${action.relayer}`;
    default:
      return JSON.stringify(action);
  }
}
