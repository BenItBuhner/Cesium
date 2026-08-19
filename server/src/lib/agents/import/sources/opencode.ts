import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEventInput } from "../../types.js";
import type {
  HarnessImportAvailability,
  HarnessImportSource,
  HarnessSessionSummary,
  HarnessSessionTranscript,
} from "../types.js";
import {
  asRecord,
  asString,
  listFilesRecursive,
  pathExists,
  toEpochMs,
  truncateTitle,
} from "../reader-utils.js";
import { importedToolCallEvent, importedToolResultEvent } from "../tool-events.js";

/**
 * OpenCode persists sessions in one of two layouts:
 *   v1.x:  ~/.local/share/opencode/opencode.db (SQLite; session/message/part
 *          tables whose `data` column carries the info JSON)
 *   0.x:   ~/.local/share/opencode/storage/{session,message,part}/**\/*.json
 * Both readers return the same normalized shapes.
 */

type SqliteRow = Record<string, unknown>;

type ReadonlyDb = {
  query: (sql: string, params?: unknown[]) => SqliteRow[];
  close: () => void;
};

async function openReadonlyDb(dbPath: string): Promise<ReadonlyDb | null> {
  try {
    // Non-literal specifier: this module only resolves under the Bun runtime.
    const bunSqliteSpecifier = "bun:sqlite";
    const { Database } = (await import(bunSqliteSpecifier)) as {
      Database: new (p: string, opts: { readonly: boolean }) => {
        query: (sql: string) => { all: (...params: unknown[]) => SqliteRow[] };
        close: () => void;
      };
    };
    const db = new Database(dbPath, { readonly: true });
    return {
      query: (sql, params = []) => db.query(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    // Not running under Bun — fall through to node:sqlite.
  }
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (p: string, opts: { readOnly: boolean }) => {
        prepare: (sql: string) => { all: (...params: unknown[]) => SqliteRow[] };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      query: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "opencode");
}

function opencodeDbPath(): string {
  return path.join(opencodeDataDir(), "opencode.db");
}

function opencodeLegacyStorageRoot(): string {
  return path.join(opencodeDataDir(), "storage");
}

export type OpenCodeSessionRow = {
  id: string;
  title?: string;
  directory?: string;
  parentId?: string | null;
  timeCreated?: number | null;
  timeUpdated?: number | null;
  sourcePath: string;
};

export type OpenCodeMessageInfo = {
  id: string;
  sessionId: string;
  role?: string;
  timeCreated: number;
  timeCompleted?: number;
  model?: { providerID?: string; modelID?: string };
};

export type OpenCodePartInfo = {
  id: string;
  messageId: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  ignored?: boolean;
  synthetic?: boolean;
  state?: {
    status?: string;
    title?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number };
  };
  timeCreated: number;
};

/* ------------------------------ SQLite (v1) ------------------------------ */

function parseDataJson(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return asRecord(data);
  }
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

function sessionRowFromDb(row: SqliteRow): OpenCodeSessionRow | null {
  const id = asString(row.id);
  if (!id) {
    return null;
  }
  return {
    id,
    ...(asString(row.title) ? { title: asString(row.title) } : {}),
    ...(asString(row.directory) ? { directory: asString(row.directory) } : {}),
    parentId: asString(row.parent_id) ?? null,
    timeCreated: toEpochMs(row.time_created),
    timeUpdated: toEpochMs(row.time_updated),
    sourcePath: opencodeDbPath(),
  };
}

async function listSessionsFromDb(db: ReadonlyDb): Promise<OpenCodeSessionRow[]> {
  const rows = db.query(
    "SELECT id, title, directory, parent_id, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC"
  );
  return rows.map(sessionRowFromDb).filter((row): row is OpenCodeSessionRow => row !== null);
}

async function readSessionFromDb(
  db: ReadonlyDb,
  sessionId: string
): Promise<{ session: OpenCodeSessionRow; messages: OpenCodeMessageInfo[]; parts: OpenCodePartInfo[] } | null> {
  const sessionRows = db.query(
    "SELECT id, title, directory, parent_id, time_created, time_updated FROM session WHERE id = ?",
    [sessionId]
  );
  const session = sessionRows.length > 0 ? sessionRowFromDb(sessionRows[0]!) : null;
  if (!session) {
    return null;
  }
  const messageRows = db.query(
    "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
    [sessionId]
  );
  const messages: OpenCodeMessageInfo[] = [];
  for (const row of messageRows) {
    const info = parseDataJson(row.data);
    const id = asString(row.id) ?? asString(info?.id);
    if (!id) {
      continue;
    }
    const time = asRecord(info?.time);
    messages.push({
      id,
      sessionId,
      ...(asString(info?.role) ? { role: asString(info?.role) } : {}),
      timeCreated: toEpochMs(time?.created) ?? toEpochMs(row.time_created) ?? 0,
      ...(toEpochMs(time?.completed) ? { timeCompleted: toEpochMs(time?.completed)! } : {}),
      ...(asRecord(info?.model)
        ? {
            model: {
              ...(asString(asRecord(info?.model)?.providerID)
                ? { providerID: asString(asRecord(info?.model)?.providerID) }
                : {}),
              ...(asString(asRecord(info?.model)?.modelID)
                ? { modelID: asString(asRecord(info?.model)?.modelID) }
                : {}),
            },
          }
        : {}),
    });
  }
  const partRows = db.query(
    "SELECT id, message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC",
    [sessionId]
  );
  const parts: OpenCodePartInfo[] = [];
  for (const row of partRows) {
    const info = parseDataJson(row.data);
    const id = asString(row.id) ?? asString(info?.id);
    const messageId = asString(row.message_id) ?? asString(info?.messageID);
    if (!id || !messageId) {
      continue;
    }
    parts.push({
      id,
      messageId,
      ...(asString(info?.type) ? { type: asString(info?.type) } : {}),
      ...(asString(info?.text) !== undefined ? { text: asString(info?.text)! } : {}),
      ...(asString(info?.tool) ? { tool: asString(info?.tool) } : {}),
      ...(asString(info?.callID) ? { callID: asString(info?.callID) } : {}),
      ...(info?.ignored === true ? { ignored: true } : {}),
      ...(info?.synthetic === true ? { synthetic: true } : {}),
      ...(asRecord(info?.state)
        ? {
            state: {
              ...(asString(asRecord(info?.state)?.status)
                ? { status: asString(asRecord(info?.state)?.status) }
                : {}),
              ...(asString(asRecord(info?.state)?.title)
                ? { title: asString(asRecord(info?.state)?.title) }
                : {}),
              ...(asRecord(info?.state)?.input !== undefined
                ? { input: asRecord(info?.state)?.input }
                : {}),
              ...(asRecord(info?.state)?.output !== undefined
                ? { output: asRecord(info?.state)?.output }
                : {}),
              ...(asRecord(info?.state)?.error !== undefined
                ? { error: asRecord(info?.state)?.error }
                : {}),
            },
          }
        : {}),
      timeCreated: toEpochMs(asRecord(info?.time)?.start) ?? toEpochMs(row.time_created) ?? 0,
    });
  }
  return { session, messages, parts };
}

/* ----------------------------- Legacy JSON (0.x) ----------------------------- */

async function listSessionsFromLegacy(root: string): Promise<OpenCodeSessionRow[]> {
  const sessionRoot = path.join(root, "session");
  const files = (await listFilesRecursive(sessionRoot)).filter((file) => file.endsWith(".json"));
  const out: OpenCodeSessionRow[] = [];
  for (const file of files) {
    try {
      const info = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
      const id = asString(info?.id) ?? path.basename(file, ".json");
      if (asString(info?.parentID)) {
        continue;
      }
      const time = asRecord(info?.time);
      out.push({
        id,
        ...(asString(info?.title) ? { title: asString(info?.title) } : {}),
        ...(asString(info?.directory) ? { directory: asString(info?.directory) } : {}),
        timeCreated: toEpochMs(time?.created),
        timeUpdated: toEpochMs(time?.updated),
        sourcePath: file,
      });
    } catch {
      // skip unreadable session files
    }
  }
  return out;
}

async function readSessionFromLegacy(
  root: string,
  sessionId: string
): Promise<{ session: OpenCodeSessionRow; messages: OpenCodeMessageInfo[]; parts: OpenCodePartInfo[] } | null> {
  const sessions = await listSessionsFromLegacy(root);
  const session = sessions.find((row) => row.id === sessionId);
  if (!session) {
    return null;
  }
  const messageRoot = path.join(root, "message", sessionId);
  const messageFiles = (await listFilesRecursive(messageRoot)).filter((file) =>
    file.endsWith(".json")
  );
  const messages: OpenCodeMessageInfo[] = [];
  for (const file of messageFiles) {
    try {
      const info = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
      const id = asString(info?.id) ?? path.basename(file, ".json");
      const time = asRecord(info?.time);
      messages.push({
        id,
        sessionId,
        ...(asString(info?.role) ? { role: asString(info?.role) } : {}),
        timeCreated: toEpochMs(time?.created) ?? 0,
        ...(toEpochMs(time?.completed) ? { timeCompleted: toEpochMs(time?.completed)! } : {}),
        ...(asRecord(info?.model)
          ? {
              model: {
                ...(asString(asRecord(info?.model)?.providerID)
                  ? { providerID: asString(asRecord(info?.model)?.providerID) }
                  : {}),
                ...(asString(asRecord(info?.model)?.modelID)
                  ? { modelID: asString(asRecord(info?.model)?.modelID) }
                  : {}),
              },
            }
          : {}),
      });
    } catch {
      // skip
    }
  }
  messages.sort((a, b) => a.timeCreated - b.timeCreated);

  const parts: OpenCodePartInfo[] = [];
  for (const message of messages) {
    const partRoot = path.join(root, "part", message.id);
    const partFiles = (await listFilesRecursive(partRoot)).filter((file) =>
      file.endsWith(".json")
    );
    for (const file of partFiles) {
      try {
        const info = asRecord(JSON.parse(await fs.readFile(file, "utf8")));
        const id = asString(info?.id) ?? path.basename(file, ".json");
        parts.push({
          id,
          messageId: message.id,
          ...(asString(info?.type) ? { type: asString(info?.type) } : {}),
          ...(asString(info?.text) !== undefined ? { text: asString(info?.text)! } : {}),
          ...(asString(info?.tool) ? { tool: asString(info?.tool) } : {}),
          ...(asString(info?.callID) ? { callID: asString(info?.callID) } : {}),
          ...(info?.ignored === true ? { ignored: true } : {}),
          ...(info?.synthetic === true ? { synthetic: true } : {}),
          ...(asRecord(info?.state)
            ? {
                state: {
                  ...(asString(asRecord(info?.state)?.status)
                    ? { status: asString(asRecord(info?.state)?.status) }
                    : {}),
                  ...(asString(asRecord(info?.state)?.title)
                    ? { title: asString(asRecord(info?.state)?.title) }
                    : {}),
                  ...(asRecord(info?.state)?.input !== undefined
                    ? { input: asRecord(info?.state)?.input }
                    : {}),
                  ...(asRecord(info?.state)?.output !== undefined
                    ? { output: asRecord(info?.state)?.output }
                    : {}),
                  ...(asRecord(info?.state)?.error !== undefined
                    ? { error: asRecord(info?.state)?.error }
                    : {}),
                },
              }
            : {}),
          timeCreated: toEpochMs(asRecord(info?.time)?.start) ?? 0,
        });
      } catch {
        // skip
      }
    }
  }
  parts.sort((a, b) => a.timeCreated - b.timeCreated);
  return { session, messages, parts };
}

/* ------------------------------ Normalization ------------------------------ */

function summarizeOpenCodeSession(
  session: OpenCodeSessionRow,
  messages: OpenCodeMessageInfo[],
  parts: OpenCodePartInfo[]
): HarnessSessionSummary {
  const partsByMessage = new Map<string, OpenCodePartInfo[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.messageId) ?? [];
    list.push(part);
    partsByMessage.set(part.messageId, list);
  }
  let messageCount = 0;
  let preview: string | undefined;
  let model: { providerID?: string; modelID?: string } | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && message.model?.modelID) {
      model = message.model;
    }
    const messageParts = (partsByMessage.get(message.id) ?? []).filter((part) => !part.ignored);
    if (message.role === "user") {
      const text = messageParts
        .filter((part) => part.type === "text" && part.text?.trim() && !part.synthetic)
        .map((part) => part.text!)
        .join("\n");
      if (!text.trim()) {
        continue;
      }
      messageCount += 1;
      if (!preview) {
        preview = truncateTitle(text, 120);
      }
    } else if (message.role === "assistant") {
      const hasVisible = messageParts.some(
        (part) =>
          (part.type === "text" && part.text?.trim()) ||
          part.type === "tool" ||
          (part.type === "reasoning" && part.text?.trim())
      );
      if (hasVisible) {
        messageCount += 1;
      }
    }
  }
  return {
    id: session.id,
    title:
      session.title?.trim() && !/^new session/i.test(session.title)
        ? truncateTitle(session.title)
        : (preview ?? `OpenCode session ${session.id.slice(-8)}`),
    ...(session.directory ? { cwd: session.directory } : {}),
    createdAt: session.timeCreated ?? null,
    updatedAt: session.timeUpdated ?? null,
    messageCount,
    sourcePath: session.sourcePath,
    ...(preview ? { preview } : {}),
    // OpenCode addresses models as "providerID/modelID" — continuation keeps
    // the exact model of the last assistant turn.
    ...(model?.modelID
      ? {
          modelId: model.providerID ? `${model.providerID}/${model.modelID}` : model.modelID,
          modelName: model.modelID,
        }
      : {}),
  };
}

function mapToolStatus(status: string | undefined): "completed" | "failed" | "in_progress" {
  if (status === "error") {
    return "failed";
  }
  if (status === "running" || status === "pending") {
    return "in_progress";
  }
  return "completed";
}

export function mapOpenCodeMessagesToEvents(
  messages: OpenCodeMessageInfo[],
  parts: OpenCodePartInfo[],
  conversationId: string
): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  const partsByMessage = new Map<string, OpenCodePartInfo[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.messageId) ?? [];
    list.push(part);
    partsByMessage.set(part.messageId, list);
  }

  let lastTs: number | null = null;
  const nextTime = (candidate: number | null | undefined): number => {
    if (candidate && Number.isFinite(candidate)) {
      lastTs = lastTs === null ? candidate : Math.max(candidate, lastTs + 1);
      return lastTs;
    }
    lastTs = (lastTs ?? Date.now()) + 1;
    return lastTs;
  };

  for (const message of messages) {
    const messageParts = (partsByMessage.get(message.id) ?? [])
      .filter((part) => !part.ignored)
      .sort((a, b) => a.timeCreated - b.timeCreated);

    if (message.role === "user") {
      const text = messageParts
        .filter((part) => part.type === "text" && part.text?.trim() && !part.synthetic)
        .map((part) => part.text!)
        .join("\n");
      if (!text.trim()) {
        continue;
      }
      events.push({
        eventId: message.id,
        conversationId,
        kind: "user_message",
        messageId: message.id,
        content: text,
        createdAt: nextTime(message.timeCreated),
      });
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    let sawText = false;
    let lastCreatedAt = message.timeCreated;
    for (const part of messageParts) {
      const createdAt = nextTime(part.timeCreated || message.timeCreated);
      lastCreatedAt = createdAt;
      if (part.type === "reasoning" && part.text?.trim()) {
        events.push({
          eventId: part.id,
          conversationId,
          kind: "reasoning",
          messageId: message.id,
          text: part.text,
          createdAt,
        });
        continue;
      }
      if (part.type === "text" && part.text?.trim()) {
        sawText = true;
        events.push({
          eventId: part.id,
          conversationId,
          kind: "assistant_message_chunk",
          messageId: message.id,
          text: part.text,
          createdAt,
        });
        continue;
      }
      if (part.type === "tool" && part.tool) {
        const toolCallId = part.callID ?? part.id;
        const status = mapToolStatus(part.state?.status);
        events.push(
          importedToolCallEvent({
            conversationId,
            toolCallId,
            name: part.tool,
            toolInput: part.state?.input,
            createdAt,
          })
        );
        if (part.state?.output !== undefined || part.state?.error !== undefined) {
          events.push(
            importedToolResultEvent({
              conversationId,
              toolCallId,
              name: part.tool,
              toolInput: part.state?.input,
              result: part.state?.error ?? part.state?.output,
              isError: status === "failed",
              createdAt: createdAt + 1,
            })
          );
        }
        continue;
      }
    }
    if (sawText) {
      events.push({
        eventId: `${message.id}:end`,
        conversationId,
        kind: "assistant_message_end",
        messageId: message.id,
        stopReason: "end_turn",
        createdAt: nextTime(message.timeCompleted ?? lastCreatedAt + 1),
      });
    }
  }
  return events;
}

export function createOpenCodeImportSource(): HarnessImportSource {
  const readViaBestStore = async () => {
    const dbPath = opencodeDbPath();
    if (await pathExists(dbPath)) {
      const db = await openReadonlyDb(dbPath);
      if (db) {
        return { kind: "db" as const, db };
      }
    }
    const legacyRoot = opencodeLegacyStorageRoot();
    if (await pathExists(path.join(legacyRoot, "session"))) {
      return { kind: "legacy" as const, root: legacyRoot };
    }
    return null;
  };

  return {
    harnessKey: "opencode",
    backendIds: ["opencode-server"],
    displayName: "OpenCode",

    async detect(): Promise<HarnessImportAvailability> {
      const dbPath = opencodeDbPath();
      if (await pathExists(dbPath)) {
        return { available: true, storageRoot: dbPath };
      }
      const legacyRoot = opencodeLegacyStorageRoot();
      if (await pathExists(path.join(legacyRoot, "session"))) {
        return { available: true, storageRoot: legacyRoot };
      }
      return {
        available: false,
        reason: "No OpenCode storage found (~/.local/share/opencode).",
        storageRoot: dbPath,
      };
    },

    async listSessions(): Promise<HarnessSessionSummary[]> {
      const store = await readViaBestStore();
      if (!store) {
        return [];
      }
      if (store.kind === "legacy") {
        const sessions = await listSessionsFromLegacy(store.root);
        const summaries: HarnessSessionSummary[] = [];
        for (const session of sessions) {
          const data = await readSessionFromLegacy(store.root, session.id);
          summaries.push(
            summarizeOpenCodeSession(session, data?.messages ?? [], data?.parts ?? [])
          );
        }
        return summaries.sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id)
        );
      }
      try {
        const sessions = await listSessionsFromDb(store.db);
        const summaries: HarnessSessionSummary[] = [];
        for (const session of sessions) {
          const data = await readSessionFromDb(store.db, session.id);
          summaries.push(
            summarizeOpenCodeSession(session, data?.messages ?? [], data?.parts ?? [])
          );
        }
        return summaries;
      } finally {
        store.db.close();
      }
    },

    async readSession(sessionId: string): Promise<HarnessSessionTranscript> {
      const store = await readViaBestStore();
      if (!store) {
        throw new Error("OpenCode storage is not available on this machine.");
      }
      const data =
        store.kind === "legacy"
          ? await readSessionFromLegacy(store.root, sessionId)
          : await (async () => {
              try {
                return await readSessionFromDb(store.db, sessionId);
              } finally {
                store.db.close();
              }
            })();
      if (!data) {
        throw new Error(`OpenCode session not found: ${sessionId}`);
      }
      const summary = summarizeOpenCodeSession(data.session, data.messages, data.parts);
      const events = mapOpenCodeMessagesToEvents(data.messages, data.parts, "");
      const firstTs = summary.createdAt;
      return {
        summary,
        events,
        ...(firstTs ? { startedAt: new Date(firstTs).toISOString() } : {}),
      };
    },

    // OpenCode resolves sessions by id from its global store (`GET /session/:id`),
    // independent of the server's project — no re-homing required.
  };
}
