import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

type IndexerDb = {
  intents: Record<string, IntentLifecycle>;
  deposits: Record<string, DepositState>;
};

const DEFAULT_DB: IndexerDb = {
  intents: {},
  deposits: {}
};

export interface IndexerStore {
  upsertIntent(intent: IntentLifecycle): IntentLifecycle;
  updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null;
  getIntent(intentId: string): IntentLifecycle | null;
  listIntents(user?: string): IntentLifecycle[];
  upsertDeposit(dep: DepositInput): DepositState;
  getDeposit(depositId: number): DepositState | null;
}

export class JsonIndexerStore implements IndexerStore {
  private readonly filePath: string;
  private state: IndexerDb;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.load();
  }

  upsertIntent(intent: IntentLifecycle): IntentLifecycle {
    const current = this.state.intents[intent.intentId];
    const merged: IntentLifecycle = {
      ...current,
      ...intent,
      metadata: {
        ...(current?.metadata ?? {}),
        ...(intent.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };
    this.state.intents[intent.intentId] = merged;
    this.save();
    return merged;
  }

  updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null {
    const current = this.state.intents[intentId];
    if (!current) return null;

    const updated: IntentLifecycle = {
      ...current,
      ...patch,
      status,
      metadata: {
        ...(current.metadata ?? {}),
        ...(patch?.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };

    this.state.intents[intentId] = updated;
    this.save();
    return updated;
  }

  getIntent(intentId: string): IntentLifecycle | null {
    return this.state.intents[intentId] ?? null;
  }

  listIntents(user?: string): IntentLifecycle[] {
    return Object.values(this.state.intents)
      .filter((intent) => (user ? intent.user.toLowerCase() === user.toLowerCase() : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertDeposit(dep: DepositInput): DepositState {
    const current = this.state.deposits[String(dep.depositId)];
    const merged: DepositState = {
      ...current,
      ...dep,
      metadata: {
        ...(current?.metadata ?? {}),
        ...(dep.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };
    this.state.deposits[String(dep.depositId)] = merged;
    this.save();
    return merged;
  }

  getDeposit(depositId: number): DepositState | null {
    return this.state.deposits[String(depositId)] ?? null;
  }

  private load(): IndexerDb {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(DEFAULT_DB, null, 2));
      return structuredClone(DEFAULT_DB);
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return { ...DEFAULT_DB, ...JSON.parse(raw) } as IndexerDb;
    } catch {
      return structuredClone(DEFAULT_DB);
    }
  }

  private save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}

type SqliteIntentRow = {
  payload_json: string;
};

type SqliteDepositRow = {
  payload_json: string;
};

export class SqliteIndexerStore implements IndexerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intents_updated_at ON intents(updated_at DESC);

      CREATE TABLE IF NOT EXISTS deposits (
        deposit_id INTEGER PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deposits_updated_at ON deposits(updated_at DESC);
    `);
  }

  upsertIntent(intent: IntentLifecycle): IntentLifecycle {
    const current = this.getIntent(intent.intentId);
    const merged: IntentLifecycle = {
      ...current,
      ...intent,
      metadata: {
        ...(current?.metadata ?? {}),
        ...(intent.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(
      `
      INSERT INTO intents (intent_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      `
    ).run(merged.intentId, JSON.stringify(merged), merged.updatedAt);
    return merged;
  }

  updateIntentStatus(intentId: `0x${string}`, status: IntentStatus, patch?: Partial<IntentLifecycle>): IntentLifecycle | null {
    const current = this.getIntent(intentId);
    if (!current) return null;

    const updated: IntentLifecycle = {
      ...current,
      ...patch,
      status,
      metadata: {
        ...(current.metadata ?? {}),
        ...(patch?.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(
      `
      UPDATE intents
      SET payload_json = ?, updated_at = ?
      WHERE intent_id = ?
      `
    ).run(JSON.stringify(updated), updated.updatedAt, intentId);
    return updated;
  }

  getIntent(intentId: string): IntentLifecycle | null {
    const row = this.db.prepare(
      "SELECT payload_json FROM intents WHERE intent_id = ?"
    ).get(intentId) as SqliteIntentRow | undefined;
    if (!row) return null;
    return safeJsonParse<IntentLifecycle>(row.payload_json);
  }

  listIntents(user?: string): IntentLifecycle[] {
    const rows = this.db.prepare(
      "SELECT payload_json FROM intents ORDER BY updated_at DESC"
    ).all() as SqliteIntentRow[];
    const intents: IntentLifecycle[] = [];
    for (const row of rows) {
      const parsed = safeJsonParse<IntentLifecycle>(row.payload_json);
      if (!parsed) continue;
      if (user && parsed.user.toLowerCase() !== user.toLowerCase()) continue;
      intents.push(parsed);
    }
    return intents;
  }

  upsertDeposit(dep: DepositInput): DepositState {
    const current = this.getDeposit(dep.depositId);
    const merged: DepositState = {
      ...current,
      ...dep,
      metadata: {
        ...(current?.metadata ?? {}),
        ...(dep.metadata ?? {})
      },
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(
      `
      INSERT INTO deposits (deposit_id, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(deposit_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      `
    ).run(merged.depositId, JSON.stringify(merged), merged.updatedAt);
    return merged;
  }

  getDeposit(depositId: number): DepositState | null {
    const row = this.db.prepare(
      "SELECT payload_json FROM deposits WHERE deposit_id = ?"
    ).get(depositId) as SqliteDepositRow | undefined;
    if (!row) return null;
    return safeJsonParse<DepositState>(row.payload_json);
  }
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
