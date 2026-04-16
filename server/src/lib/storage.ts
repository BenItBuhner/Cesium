import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { DATA_DIR, ensureDataDir } from "./data-dir.js";

export type StoredDocumentRow = {
  key: string;
  payload: string;
  updatedAt: number;
};

export type StoredConversationRow = {
  workspaceId: string;
  conversationId: string;
  title: string;
  status: string;
  lastEventSeq: number;
  updatedAt: number;
  archivedAt: number | null;
  payload: string;
};

export type StoredConversationEventRow = {
  workspaceId: string;
  conversationId: string;
  seq: number;
  createdAt: number;
  payload: string;
};

export type StoredAuthSessionRow = {
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  lastRotatedAt: number;
  expiresAt: number;
  remember: boolean;
};

type StorageDriverKind = "postgres" | "sqlite";

type Queryable<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
};

export interface PgClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<Queryable<Row>>;
  release?: () => void;
}

export interface PgPoolLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<Queryable<Row>>;
  connect(): Promise<PgClientLike>;
  end?: () => Promise<void>;
}

type StorageTestOverrides = {
  driver?: StorageDriverKind;
  postgresPool?: PgPoolLike;
  sqlitePath?: string;
};

interface StorageBackend {
  init(): Promise<void>;
  close(): Promise<void>;
  readDocument(key: string): Promise<StoredDocumentRow | null>;
  writeDocument(row: StoredDocumentRow): Promise<void>;
  deleteDocument(key: string): Promise<void>;
  getConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationRow | null>;
  listConversations(workspaceId: string): Promise<StoredConversationRow[]>;
  upsertConversation(row: StoredConversationRow): Promise<void>;
  updateConversation(
    workspaceId: string,
    conversationId: string,
    updater: (current: StoredConversationRow) => StoredConversationRow
  ): Promise<StoredConversationRow | null>;
  appendConversationEvents(
    workspaceId: string,
    conversationId: string,
    events: Array<{
      createdAt: number;
      buildPayload: (assigned: { seq: number; createdAt: number }) => string;
    }>,
    updater: (
      current: StoredConversationRow,
      assignedRows: StoredConversationEventRow[]
    ) => StoredConversationRow
  ): Promise<{ conversation: StoredConversationRow; events: StoredConversationEventRow[] }>;
  insertConversationEvents(rows: StoredConversationEventRow[]): Promise<void>;
  readConversationEvents(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationEventRow[]>;
  readConversationEventsSince(
    workspaceId: string,
    conversationId: string,
    since: number
  ): Promise<StoredConversationEventRow[]>;
  readConversationEventTail(
    workspaceId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredConversationEventRow[]>;
  readConversationEventPrefixTail(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number,
    limit: number
  ): Promise<StoredConversationEventRow[]>;
  getConversationMinSeq(
    workspaceId: string,
    conversationId: string
  ): Promise<number | null>;
  hasConversationEventsBefore(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number
  ): Promise<boolean>;
  deleteConversation(workspaceId: string, conversationId: string): Promise<void>;
  getAuthSession(sessionId: string): Promise<StoredAuthSessionRow | null>;
  listAuthSessions(): Promise<StoredAuthSessionRow[]>;
  upsertAuthSession(session: StoredAuthSessionRow): Promise<void>;
  deleteAuthSession(sessionId: string): Promise<void>;
  deleteExpiredAuthSessions(now: number): Promise<void>;
}

let testOverrides: StorageTestOverrides | null = null;
let backendPromise: Promise<StorageBackend> | null = null;

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = asNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDocumentKey(key: string): string {
  return path.resolve(key);
}

function sqliteDatabasePath(): string {
  const override = testOverrides?.sqlitePath?.trim();
  if (override) {
    return path.resolve(override);
  }
  const configured = process.env.OPENCURSOR_SQLITE_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(DATA_DIR, "opencursor.db");
}

function resolveDriverKind(): StorageDriverKind {
  const override = testOverrides?.driver;
  if (override) {
    return override;
  }
  const explicit = process.env.OPENCURSOR_STORAGE_DRIVER?.trim().toLowerCase();
  if (explicit === "postgres" || explicit === "sqlite") {
    return explicit;
  }
  return process.env.OPENCURSOR_DATABASE_URL?.trim() ? "postgres" : "sqlite";
}

export async function configureStorageForTests(
  overrides: Partial<StorageTestOverrides>
): Promise<void> {
  testOverrides = { ...(testOverrides ?? {}), ...overrides };
  await resetStorageForTests();
}

export async function resetStorageForTests(): Promise<void> {
  if (!backendPromise) {
    return;
  }
  const backend = await backendPromise.catch(() => null);
  backendPromise = null;
  await backend?.close().catch(() => undefined);
}

async function getBackend(): Promise<StorageBackend> {
  if (!backendPromise) {
    backendPromise = (async () => {
      await ensureDataDir();
      const driverKind = resolveDriverKind();
      const backend =
        driverKind === "postgres"
          ? await createPostgresBackend()
          : await createSqliteBackend();
      await backend.init();
      return backend;
    })();
  }
  return backendPromise;
}

async function createSqliteBackend(): Promise<StorageBackend> {
  await ensureDataDir();
  const dbPath = sqliteDatabasePath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  return new SqliteStorageBackend(db);
}

async function createPostgresBackend(): Promise<StorageBackend> {
  const injectedPool = testOverrides?.postgresPool;
  if (injectedPool) {
    return new PostgresStorageBackend(injectedPool, false);
  }
  const connectionString = process.env.OPENCURSOR_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("OPENCURSOR_DATABASE_URL is required for the Postgres storage driver.");
  }
  return new PostgresStorageBackend(
    new Pool({
      connectionString,
    }),
    true
  );
}

class SqliteStorageBackend implements StorageBackend {
  constructor(private readonly db: DatabaseSync) {}

  async init(): Promise<void> {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = OFF;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_documents (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        workspace_id TEXT NOT NULL,
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        payload TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_workspace_updated
      ON agent_conversations (workspace_id, updated_at DESC, title ASC);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_events (
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_events_workspace_seq
      ON agent_events (workspace_id, conversation_id, seq);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_rotated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        remember INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions (expires_at);
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async readDocument(key: string): Promise<StoredDocumentRow | null> {
    const row = this.db
      .prepare(
        "SELECT key, payload, updated_at FROM storage_documents WHERE key = ?"
      )
      .get(normalizeDocumentKey(key)) as
      | { key: string; payload: string; updated_at: number }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      payload: row.payload,
      updatedAt: asNumber(row.updated_at),
    };
  }

  async writeDocument(row: StoredDocumentRow): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO storage_documents (key, payload, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `
      )
      .run(normalizeDocumentKey(row.key), row.payload, row.updatedAt);
  }

  async deleteDocument(key: string): Promise<void> {
    this.db
      .prepare("DELETE FROM storage_documents WHERE key = ?")
      .run(normalizeDocumentKey(key));
  }

  async getConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationRow | null> {
    const row = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
          FROM agent_conversations
          WHERE workspace_id = ? AND conversation_id = ?
        `
      )
      .get(workspaceId, conversationId) as
      | {
          workspace_id: string;
          conversation_id: string;
          title: string;
          status: string;
          last_event_seq: number;
          updated_at: number;
          archived_at: number | null;
          payload: string;
        }
      | undefined;
    return row ? sqliteConversationRow(row) : null;
  }

  async listConversations(workspaceId: string): Promise<StoredConversationRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
          FROM agent_conversations
          WHERE workspace_id = ?
          ORDER BY updated_at DESC, title ASC
        `
      )
      .all(workspaceId) as Array<{
      workspace_id: string;
      conversation_id: string;
      title: string;
      status: string;
      last_event_seq: number;
      updated_at: number;
      archived_at: number | null;
      payload: string;
    }>;
    return rows.map(sqliteConversationRow);
  }

  async upsertConversation(row: StoredConversationRow): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO agent_conversations (
            workspace_id,
            conversation_id,
            title,
            status,
            last_event_seq,
            updated_at,
            archived_at,
            payload
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            title = excluded.title,
            status = excluded.status,
            last_event_seq = excluded.last_event_seq,
            updated_at = excluded.updated_at,
            archived_at = excluded.archived_at,
            payload = excluded.payload
        `
      )
      .run(
        row.workspaceId,
        row.conversationId,
        row.title,
        row.status,
        row.lastEventSeq,
        row.updatedAt,
        row.archivedAt,
        row.payload
      );
  }

  async updateConversation(
    workspaceId: string,
    conversationId: string,
    updater: (current: StoredConversationRow) => StoredConversationRow
  ): Promise<StoredConversationRow | null> {
    return this.transaction(() => {
      const current = this.db
        .prepare(
          `
            SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
            FROM agent_conversations
            WHERE workspace_id = ? AND conversation_id = ?
          `
        )
        .get(workspaceId, conversationId) as
        | {
            workspace_id: string;
            conversation_id: string;
            title: string;
            status: string;
            last_event_seq: number;
            updated_at: number;
            archived_at: number | null;
            payload: string;
          }
        | undefined;
      if (!current) {
        return null;
      }
      const next = updater(sqliteConversationRow(current));
      this.db
        .prepare(
          `
            UPDATE agent_conversations
            SET title = ?, status = ?, last_event_seq = ?, updated_at = ?, archived_at = ?, payload = ?
            WHERE workspace_id = ? AND conversation_id = ?
          `
        )
        .run(
          next.title,
          next.status,
          next.lastEventSeq,
          next.updatedAt,
          next.archivedAt,
          next.payload,
          workspaceId,
          conversationId
        );
      return next;
    });
  }

  async appendConversationEvents(
    workspaceId: string,
    conversationId: string,
    events: Array<{
      createdAt: number;
      buildPayload: (assigned: { seq: number; createdAt: number }) => string;
    }>,
    updater: (
      current: StoredConversationRow,
      assignedRows: StoredConversationEventRow[]
    ) => StoredConversationRow
  ): Promise<{ conversation: StoredConversationRow; events: StoredConversationEventRow[] }> {
    return this.transaction(() => {
      const currentRaw = this.db
        .prepare(
          `
            SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
            FROM agent_conversations
            WHERE workspace_id = ? AND conversation_id = ?
          `
        )
        .get(workspaceId, conversationId) as
        | {
            workspace_id: string;
            conversation_id: string;
            title: string;
            status: string;
            last_event_seq: number;
            updated_at: number;
            archived_at: number | null;
            payload: string;
          }
        | undefined;
      if (!currentRaw) {
        throw new Error(`Unknown conversation: ${conversationId}`);
      }
      const current = sqliteConversationRow(currentRaw);
      let nextSeq = current.lastEventSeq + 1;
      const assignedRows = events.map((event) => ({
        workspaceId,
        conversationId,
        seq: nextSeq,
        createdAt: event.createdAt,
        payload: event.buildPayload({ seq: nextSeq++, createdAt: event.createdAt }),
      }));
      if (assignedRows.length > 0) {
        const insert = this.db.prepare(
          `
            INSERT INTO agent_events (workspace_id, conversation_id, seq, created_at, payload)
            VALUES (?, ?, ?, ?, ?)
          `
        );
        for (const row of assignedRows) {
          insert.run(
            row.workspaceId,
            row.conversationId,
            row.seq,
            row.createdAt,
            row.payload
          );
        }
      }
      const next = updater(current, assignedRows);
      this.db
        .prepare(
          `
            UPDATE agent_conversations
            SET title = ?, status = ?, last_event_seq = ?, updated_at = ?, archived_at = ?, payload = ?
            WHERE workspace_id = ? AND conversation_id = ?
          `
        )
        .run(
          next.title,
          next.status,
          next.lastEventSeq,
          next.updatedAt,
          next.archivedAt,
          next.payload,
          workspaceId,
          conversationId
        );
      return { conversation: next, events: assignedRows };
    });
  }

  async insertConversationEvents(rows: StoredConversationEventRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const insert = this.db.prepare(
        `
          INSERT OR IGNORE INTO agent_events (workspace_id, conversation_id, seq, created_at, payload)
          VALUES (?, ?, ?, ?, ?)
        `
      );
      for (const row of rows) {
        insert.run(
          row.workspaceId,
          row.conversationId,
          row.seq,
          row.createdAt,
          row.payload
        );
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  async readConversationEvents(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationEventRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, seq, created_at, payload
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ?
          ORDER BY seq ASC
        `
      )
      .all(workspaceId, conversationId) as Array<{
      workspace_id: string;
      conversation_id: string;
      seq: number;
      created_at: number;
      payload: string;
    }>;
    return rows.map(sqliteEventRow);
  }

  async readConversationEventsSince(
    workspaceId: string,
    conversationId: string,
    since: number
  ): Promise<StoredConversationEventRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, seq, created_at, payload
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ? AND seq > ?
          ORDER BY seq ASC
        `
      )
      .all(workspaceId, conversationId, since) as Array<{
      workspace_id: string;
      conversation_id: string;
      seq: number;
      created_at: number;
      payload: string;
    }>;
    return rows.map(sqliteEventRow);
  }

  async readConversationEventTail(
    workspaceId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredConversationEventRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, seq, created_at, payload
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `
      )
      .all(workspaceId, conversationId, Math.max(1, limit)) as Array<{
      workspace_id: string;
      conversation_id: string;
      seq: number;
      created_at: number;
      payload: string;
    }>;
    return rows.map(sqliteEventRow).sort((left, right) => left.seq - right.seq);
  }

  async readConversationEventPrefixTail(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number,
    limit: number
  ): Promise<StoredConversationEventRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT workspace_id, conversation_id, seq, created_at, payload
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ? AND seq < ?
          ORDER BY seq DESC
          LIMIT ?
        `
      )
      .all(workspaceId, conversationId, beforeSeq, Math.max(1, limit)) as Array<{
      workspace_id: string;
      conversation_id: string;
      seq: number;
      created_at: number;
      payload: string;
    }>;
    return rows.map(sqliteEventRow).sort((left, right) => left.seq - right.seq);
  }

  async getConversationMinSeq(
    workspaceId: string,
    conversationId: string
  ): Promise<number | null> {
    const row = this.db
      .prepare(
        `
          SELECT MIN(seq) AS min_seq
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ?
        `
      )
      .get(workspaceId, conversationId) as { min_seq: number | null } | undefined;
    return row ? asNullableNumber(row.min_seq) : null;
  }

  async hasConversationEventsBefore(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number
  ): Promise<boolean> {
    const row = this.db
      .prepare(
        `
          SELECT 1 AS present
          FROM agent_events
          WHERE workspace_id = ? AND conversation_id = ? AND seq < ?
          LIMIT 1
        `
      )
      .get(workspaceId, conversationId, beforeSeq) as
      | { present: number }
      | undefined;
    return Boolean(row?.present);
  }

  async deleteConversation(workspaceId: string, conversationId: string): Promise<void> {
    await this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM agent_events WHERE workspace_id = ? AND conversation_id = ?"
        )
        .run(workspaceId, conversationId);
      this.db
        .prepare(
          "DELETE FROM agent_conversations WHERE workspace_id = ? AND conversation_id = ?"
        )
        .run(workspaceId, conversationId);
    });
  }

  async getAuthSession(sessionId: string): Promise<StoredAuthSessionRow | null> {
    const row = this.db
      .prepare(
        `
          SELECT id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
          FROM auth_sessions
          WHERE id = ?
        `
      )
      .get(sessionId) as
      | {
          id: string;
          username: string;
          created_at: number;
          last_seen_at: number;
          last_rotated_at: number;
          expires_at: number;
          remember: number;
        }
      | undefined;
    return row ? sqliteAuthSessionRow(row) : null;
  }

  async listAuthSessions(): Promise<StoredAuthSessionRow[]> {
    const rows = this.db
      .prepare(
        `
          SELECT id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
          FROM auth_sessions
        `
      )
      .all() as Array<{
      id: string;
      username: string;
      created_at: number;
      last_seen_at: number;
      last_rotated_at: number;
      expires_at: number;
      remember: number;
    }>;
    return rows.map(sqliteAuthSessionRow);
  }

  async upsertAuthSession(session: StoredAuthSessionRow): Promise<void> {
    this.db
      .prepare(
        `
          INSERT INTO auth_sessions (
            id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            created_at = excluded.created_at,
            last_seen_at = excluded.last_seen_at,
            last_rotated_at = excluded.last_rotated_at,
            expires_at = excluded.expires_at,
            remember = excluded.remember
        `
      )
      .run(
        session.id,
        session.username,
        session.createdAt,
        session.lastSeenAt,
        session.lastRotatedAt,
        session.expiresAt,
        session.remember ? 1 : 0
      );
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionId);
  }

  async deleteExpiredAuthSessions(now: number): Promise<void> {
    this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
      .run(now);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}

class PostgresStorageBackend implements StorageBackend {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly ownsPool: boolean
  ) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS storage_documents (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        workspace_id TEXT NOT NULL,
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL,
        updated_at BIGINT NOT NULL,
        archived_at BIGINT,
        payload TEXT NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_workspace_updated
      ON agent_conversations (workspace_id, updated_at DESC, title ASC);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_events (
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at BIGINT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_events_workspace_seq
      ON agent_events (workspace_id, conversation_id, seq);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        last_rotated_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        remember BOOLEAN NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
      ON auth_sessions (expires_at);
    `);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end?.();
    }
  }

  async readDocument(key: string): Promise<StoredDocumentRow | null> {
    const result = await this.pool.query<{
      key: string;
      payload: string;
      updated_at: unknown;
    }>(
      `
        SELECT key, payload, updated_at
        FROM storage_documents
        WHERE key = $1
      `,
      [normalizeDocumentKey(key)]
    );
    return result.rows[0]
      ? {
          key: result.rows[0].key,
          payload: result.rows[0].payload,
          updatedAt: asNumber(result.rows[0].updated_at),
        }
      : null;
  }

  async writeDocument(row: StoredDocumentRow): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO storage_documents (key, payload, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(key) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at
      `,
      [normalizeDocumentKey(row.key), row.payload, row.updatedAt]
    );
  }

  async deleteDocument(key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM storage_documents WHERE key = $1",
      [normalizeDocumentKey(key)]
    );
  }

  async getConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationRow | null> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      title: string;
      status: string;
      last_event_seq: unknown;
      updated_at: unknown;
      archived_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
        FROM agent_conversations
        WHERE workspace_id = $1 AND conversation_id = $2
      `,
      [workspaceId, conversationId]
    );
    return result.rows[0] ? postgresConversationRow(result.rows[0]) : null;
  }

  async listConversations(workspaceId: string): Promise<StoredConversationRow[]> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      title: string;
      status: string;
      last_event_seq: unknown;
      updated_at: unknown;
      archived_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
        FROM agent_conversations
        WHERE workspace_id = $1
        ORDER BY updated_at DESC, title ASC
      `,
      [workspaceId]
    );
    return result.rows.map(postgresConversationRow);
  }

  async upsertConversation(row: StoredConversationRow): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_conversations (
          workspace_id,
          conversation_id,
          title,
          status,
          last_event_seq,
          updated_at,
          archived_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(conversation_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          last_event_seq = EXCLUDED.last_event_seq,
          updated_at = EXCLUDED.updated_at,
          archived_at = EXCLUDED.archived_at,
          payload = EXCLUDED.payload
      `,
      [
        row.workspaceId,
        row.conversationId,
        row.title,
        row.status,
        row.lastEventSeq,
        row.updatedAt,
        row.archivedAt,
        row.payload,
      ]
    );
  }

  async updateConversation(
    workspaceId: string,
    conversationId: string,
    updater: (current: StoredConversationRow) => StoredConversationRow
  ): Promise<StoredConversationRow | null> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const currentResult = await client.query<{
          workspace_id: string;
          conversation_id: string;
          title: string;
          status: string;
          last_event_seq: unknown;
          updated_at: unknown;
          archived_at: unknown;
          payload: string;
        }>(
          `
            SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
            FROM agent_conversations
            WHERE workspace_id = $1 AND conversation_id = $2
            FOR UPDATE
          `,
          [workspaceId, conversationId]
        );
        const current = currentResult.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          return null;
        }
        const next = updater(postgresConversationRow(current));
        await client.query(
          `
            UPDATE agent_conversations
            SET title = $1, status = $2, last_event_seq = $3, updated_at = $4, archived_at = $5, payload = $6
            WHERE workspace_id = $7 AND conversation_id = $8
          `,
          [
            next.title,
            next.status,
            next.lastEventSeq,
            next.updatedAt,
            next.archivedAt,
            next.payload,
            workspaceId,
            conversationId,
          ]
        );
        await client.query("COMMIT");
        return next;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async appendConversationEvents(
    workspaceId: string,
    conversationId: string,
    events: Array<{
      createdAt: number;
      buildPayload: (assigned: { seq: number; createdAt: number }) => string;
    }>,
    updater: (
      current: StoredConversationRow,
      assignedRows: StoredConversationEventRow[]
    ) => StoredConversationRow
  ): Promise<{ conversation: StoredConversationRow; events: StoredConversationEventRow[] }> {
    return this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const currentResult = await client.query<{
          workspace_id: string;
          conversation_id: string;
          title: string;
          status: string;
          last_event_seq: unknown;
          updated_at: unknown;
          archived_at: unknown;
          payload: string;
        }>(
          `
            SELECT workspace_id, conversation_id, title, status, last_event_seq, updated_at, archived_at, payload
            FROM agent_conversations
            WHERE workspace_id = $1 AND conversation_id = $2
            FOR UPDATE
          `,
          [workspaceId, conversationId]
        );
        const current = currentResult.rows[0];
        if (!current) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }
        let nextSeq = asNumber(current.last_event_seq) + 1;
        const assignedRows = events.map((event) => ({
          workspaceId,
          conversationId,
          seq: nextSeq,
          createdAt: event.createdAt,
          payload: event.buildPayload({ seq: nextSeq++, createdAt: event.createdAt }),
        }));
        if (assignedRows.length > 0) {
          const valueParts: string[] = [];
          const params: unknown[] = [];
          for (const row of assignedRows) {
            const offset = params.length;
            valueParts.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
            );
            params.push(
              row.workspaceId,
              row.conversationId,
              row.seq,
              row.createdAt,
              row.payload
            );
          }
          await client.query(
            `
              INSERT INTO agent_events (workspace_id, conversation_id, seq, created_at, payload)
              VALUES ${valueParts.join(", ")}
            `,
            params
          );
        }
        const next = updater(postgresConversationRow(current), assignedRows);
        await client.query(
          `
            UPDATE agent_conversations
            SET title = $1, status = $2, last_event_seq = $3, updated_at = $4, archived_at = $5, payload = $6
            WHERE workspace_id = $7 AND conversation_id = $8
          `,
          [
            next.title,
            next.status,
            next.lastEventSeq,
            next.updatedAt,
            next.archivedAt,
            next.payload,
            workspaceId,
            conversationId,
          ]
        );
        await client.query("COMMIT");
        return { conversation: next, events: assignedRows };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async insertConversationEvents(rows: StoredConversationEventRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const valueParts: string[] = [];
    const params: unknown[] = [];
    for (const row of rows) {
      const offset = params.length;
      valueParts.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
      );
      params.push(
        row.workspaceId,
        row.conversationId,
        row.seq,
        row.createdAt,
        row.payload
      );
    }
    await this.pool.query(
      `
        INSERT INTO agent_events (workspace_id, conversation_id, seq, created_at, payload)
        VALUES ${valueParts.join(", ")}
        ON CONFLICT (conversation_id, seq) DO NOTHING
      `,
      params
    );
  }

  async readConversationEvents(
    workspaceId: string,
    conversationId: string
  ): Promise<StoredConversationEventRow[]> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      seq: unknown;
      created_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, seq, created_at, payload
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2
        ORDER BY seq ASC
      `,
      [workspaceId, conversationId]
    );
    return result.rows.map(postgresEventRow);
  }

  async readConversationEventsSince(
    workspaceId: string,
    conversationId: string,
    since: number
  ): Promise<StoredConversationEventRow[]> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      seq: unknown;
      created_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, seq, created_at, payload
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2 AND seq > $3
        ORDER BY seq ASC
      `,
      [workspaceId, conversationId, since]
    );
    return result.rows.map(postgresEventRow);
  }

  async readConversationEventTail(
    workspaceId: string,
    conversationId: string,
    limit: number
  ): Promise<StoredConversationEventRow[]> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      seq: unknown;
      created_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, seq, created_at, payload
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2
        ORDER BY seq DESC
        LIMIT $3
      `,
      [workspaceId, conversationId, Math.max(1, limit)]
    );
    return result.rows.map(postgresEventRow).sort((left, right) => left.seq - right.seq);
  }

  async readConversationEventPrefixTail(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number,
    limit: number
  ): Promise<StoredConversationEventRow[]> {
    const result = await this.pool.query<{
      workspace_id: string;
      conversation_id: string;
      seq: unknown;
      created_at: unknown;
      payload: string;
    }>(
      `
        SELECT workspace_id, conversation_id, seq, created_at, payload
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2 AND seq < $3
        ORDER BY seq DESC
        LIMIT $4
      `,
      [workspaceId, conversationId, beforeSeq, Math.max(1, limit)]
    );
    return result.rows.map(postgresEventRow).sort((left, right) => left.seq - right.seq);
  }

  async getConversationMinSeq(
    workspaceId: string,
    conversationId: string
  ): Promise<number | null> {
    const result = await this.pool.query<{ min_seq: unknown }>(
      `
        SELECT MIN(seq) AS min_seq
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2
      `,
      [workspaceId, conversationId]
    );
    return result.rows[0] ? asNullableNumber(result.rows[0].min_seq) : null;
  }

  async hasConversationEventsBefore(
    workspaceId: string,
    conversationId: string,
    beforeSeq: number
  ): Promise<boolean> {
    const result = await this.pool.query<{ present: number }>(
      `
        SELECT 1 AS present
        FROM agent_events
        WHERE workspace_id = $1 AND conversation_id = $2 AND seq < $3
        LIMIT 1
      `,
      [workspaceId, conversationId, beforeSeq]
    );
    return result.rows.length > 0;
  }

  async deleteConversation(workspaceId: string, conversationId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          "DELETE FROM agent_events WHERE workspace_id = $1 AND conversation_id = $2",
          [workspaceId, conversationId]
        );
        await client.query(
          "DELETE FROM agent_conversations WHERE workspace_id = $1 AND conversation_id = $2",
          [workspaceId, conversationId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async getAuthSession(sessionId: string): Promise<StoredAuthSessionRow | null> {
    const result = await this.pool.query<{
      id: string;
      username: string;
      created_at: unknown;
      last_seen_at: unknown;
      last_rotated_at: unknown;
      expires_at: unknown;
      remember: boolean;
    }>(
      `
        SELECT id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
        FROM auth_sessions
        WHERE id = $1
      `,
      [sessionId]
    );
    return result.rows[0] ? postgresAuthSessionRow(result.rows[0]) : null;
  }

  async listAuthSessions(): Promise<StoredAuthSessionRow[]> {
    const result = await this.pool.query<{
      id: string;
      username: string;
      created_at: unknown;
      last_seen_at: unknown;
      last_rotated_at: unknown;
      expires_at: unknown;
      remember: boolean;
    }>(
      `
        SELECT id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
        FROM auth_sessions
      `
    );
    return result.rows.map(postgresAuthSessionRow);
  }

  async upsertAuthSession(session: StoredAuthSessionRow): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO auth_sessions (
          id, username, created_at, last_seen_at, last_rotated_at, expires_at, remember
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(id) DO UPDATE SET
          username = EXCLUDED.username,
          created_at = EXCLUDED.created_at,
          last_seen_at = EXCLUDED.last_seen_at,
          last_rotated_at = EXCLUDED.last_rotated_at,
          expires_at = EXCLUDED.expires_at,
          remember = EXCLUDED.remember
      `,
      [
        session.id,
        session.username,
        session.createdAt,
        session.lastSeenAt,
        session.lastRotatedAt,
        session.expiresAt,
        session.remember,
      ]
    );
  }

  async deleteAuthSession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
  }

  async deleteExpiredAuthSessions(now: number): Promise<void> {
    await this.pool.query("DELETE FROM auth_sessions WHERE expires_at <= $1", [now]);
  }

  private async withClient<T>(run: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await run(client);
    } finally {
      client.release?.();
    }
  }
}

function sqliteConversationRow(row: {
  workspace_id: string;
  conversation_id: string;
  title: string;
  status: string;
  last_event_seq: number;
  updated_at: number;
  archived_at: number | null;
  payload: string;
}): StoredConversationRow {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    title: row.title,
    status: row.status,
    lastEventSeq: asNumber(row.last_event_seq),
    updatedAt: asNumber(row.updated_at),
    archivedAt: asNullableNumber(row.archived_at),
    payload: row.payload,
  };
}

function postgresConversationRow(row: {
  workspace_id: string;
  conversation_id: string;
  title: string;
  status: string;
  last_event_seq: unknown;
  updated_at: unknown;
  archived_at: unknown;
  payload: string;
}): StoredConversationRow {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    title: row.title,
    status: row.status,
    lastEventSeq: asNumber(row.last_event_seq),
    updatedAt: asNumber(row.updated_at),
    archivedAt: asNullableNumber(row.archived_at),
    payload: row.payload,
  };
}

function sqliteEventRow(row: {
  workspace_id: string;
  conversation_id: string;
  seq: number;
  created_at: number;
  payload: string;
}): StoredConversationEventRow {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    seq: asNumber(row.seq),
    createdAt: asNumber(row.created_at),
    payload: row.payload,
  };
}

function postgresEventRow(row: {
  workspace_id: string;
  conversation_id: string;
  seq: unknown;
  created_at: unknown;
  payload: string;
}): StoredConversationEventRow {
  return {
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    seq: asNumber(row.seq),
    createdAt: asNumber(row.created_at),
    payload: row.payload,
  };
}

function sqliteAuthSessionRow(row: {
  id: string;
  username: string;
  created_at: number;
  last_seen_at: number;
  last_rotated_at: number;
  expires_at: number;
  remember: number;
}): StoredAuthSessionRow {
  return {
    id: row.id,
    username: row.username,
    createdAt: asNumber(row.created_at),
    lastSeenAt: asNumber(row.last_seen_at),
    lastRotatedAt: asNumber(row.last_rotated_at),
    expiresAt: asNumber(row.expires_at),
    remember: Boolean(row.remember),
  };
}

function postgresAuthSessionRow(row: {
  id: string;
  username: string;
  created_at: unknown;
  last_seen_at: unknown;
  last_rotated_at: unknown;
  expires_at: unknown;
  remember: boolean;
}): StoredAuthSessionRow {
  return {
    id: row.id,
    username: row.username,
    createdAt: asNumber(row.created_at),
    lastSeenAt: asNumber(row.last_seen_at),
    lastRotatedAt: asNumber(row.last_rotated_at),
    expiresAt: asNumber(row.expires_at),
    remember: Boolean(row.remember),
  };
}

export async function readStoredDocument(key: string): Promise<StoredDocumentRow | null> {
  return (await getBackend()).readDocument(key);
}

export async function writeStoredDocument(row: StoredDocumentRow): Promise<void> {
  await (await getBackend()).writeDocument(row);
}

export async function deleteStoredDocument(key: string): Promise<void> {
  await (await getBackend()).deleteDocument(key);
}

export async function getStoredConversation(
  workspaceId: string,
  conversationId: string
): Promise<StoredConversationRow | null> {
  return (await getBackend()).getConversation(workspaceId, conversationId);
}

export async function listStoredConversations(
  workspaceId: string
): Promise<StoredConversationRow[]> {
  return (await getBackend()).listConversations(workspaceId);
}

export async function upsertStoredConversation(row: StoredConversationRow): Promise<void> {
  await (await getBackend()).upsertConversation(row);
}

export async function updateStoredConversation(
  workspaceId: string,
  conversationId: string,
  updater: (current: StoredConversationRow) => StoredConversationRow
): Promise<StoredConversationRow | null> {
  return (await getBackend()).updateConversation(workspaceId, conversationId, updater);
}

export async function appendStoredConversationEvents(
  workspaceId: string,
  conversationId: string,
  events: Array<{
    createdAt: number;
    buildPayload: (assigned: { seq: number; createdAt: number }) => string;
  }>,
  updater: (
    current: StoredConversationRow,
    assignedRows: StoredConversationEventRow[]
  ) => StoredConversationRow
): Promise<{ conversation: StoredConversationRow; events: StoredConversationEventRow[] }> {
  return (await getBackend()).appendConversationEvents(
    workspaceId,
    conversationId,
    events,
    updater
  );
}

export async function insertStoredConversationEvents(
  rows: StoredConversationEventRow[]
): Promise<void> {
  await (await getBackend()).insertConversationEvents(rows);
}

export async function readStoredConversationEvents(
  workspaceId: string,
  conversationId: string
): Promise<StoredConversationEventRow[]> {
  return (await getBackend()).readConversationEvents(workspaceId, conversationId);
}

export async function readStoredConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since: number
): Promise<StoredConversationEventRow[]> {
  return (await getBackend()).readConversationEventsSince(workspaceId, conversationId, since);
}

export async function readStoredConversationEventTail(
  workspaceId: string,
  conversationId: string,
  limit: number
): Promise<StoredConversationEventRow[]> {
  return (await getBackend()).readConversationEventTail(workspaceId, conversationId, limit);
}

export async function readStoredConversationEventPrefixTail(
  workspaceId: string,
  conversationId: string,
  beforeSeq: number,
  limit: number
): Promise<StoredConversationEventRow[]> {
  return (await getBackend()).readConversationEventPrefixTail(
    workspaceId,
    conversationId,
    beforeSeq,
    limit
  );
}

export async function getStoredConversationMinSeq(
  workspaceId: string,
  conversationId: string
): Promise<number | null> {
  return (await getBackend()).getConversationMinSeq(workspaceId, conversationId);
}

export async function hasStoredConversationEventsBefore(
  workspaceId: string,
  conversationId: string,
  beforeSeq: number
): Promise<boolean> {
  return (await getBackend()).hasConversationEventsBefore(
    workspaceId,
    conversationId,
    beforeSeq
  );
}

export async function deleteStoredConversation(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  await (await getBackend()).deleteConversation(workspaceId, conversationId);
}

export async function getStoredAuthSession(
  sessionId: string
): Promise<StoredAuthSessionRow | null> {
  return (await getBackend()).getAuthSession(sessionId);
}

export async function listStoredAuthSessions(): Promise<StoredAuthSessionRow[]> {
  return (await getBackend()).listAuthSessions();
}

export async function upsertStoredAuthSession(
  session: StoredAuthSessionRow
): Promise<void> {
  await (await getBackend()).upsertAuthSession(session);
}

export async function deleteStoredAuthSession(sessionId: string): Promise<void> {
  await (await getBackend()).deleteAuthSession(sessionId);
}

export async function deleteExpiredStoredAuthSessions(now: number): Promise<void> {
  await (await getBackend()).deleteExpiredAuthSessions(now);
}

export async function getStorageStatus(): Promise<{
  driver: StorageDriverKind;
  databaseUrlConfigured: boolean;
  sqlitePath: string | null;
}> {
  const driver = resolveDriverKind();
  return {
    driver,
    databaseUrlConfigured: Boolean(process.env.OPENCURSOR_DATABASE_URL?.trim()),
    sqlitePath: driver === "sqlite" ? sqliteDatabasePath() : null,
  };
}
