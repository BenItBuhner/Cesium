import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir, readJsonFile, writeJsonFile } from "../persistence.js";
import { AGENT_BACKENDS } from "./providers.js";
import type {
  AgentBackendId,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentEventInput,
  AgentManagerEvent,
  AgentStoredEvent,
} from "./types.js";

const appendQueues = new Map<string, Promise<void>>();
const listeners = new Set<(event: AgentManagerEvent) => void>();
const FALLBACK_BACKEND_ID: AgentBackendId = "cursor-acp";

function getConversationRoot(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "conversations");
}

function getConversationDir(workspaceId: string, conversationId: string): string {
  return path.join(getConversationRoot(workspaceId), conversationId);
}

function getConversationMetaFile(workspaceId: string, conversationId: string): string {
  return path.join(getConversationDir(workspaceId, conversationId), "meta.json");
}

function getConversationEventsFile(workspaceId: string, conversationId: string): string {
  return path.join(getConversationDir(workspaceId, conversationId), "events.jsonl");
}

function queueKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}

function notify(event: AgentManagerEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function normalizeConversationRecord(
  record: AgentConversationRecord
): AgentConversationRecord {
  const normalizedMetadata = {
    archivedAt:
      typeof record.archivedAt === "number" && Number.isFinite(record.archivedAt)
        ? record.archivedAt
        : null,
    lastReadSeq:
      typeof record.lastReadSeq === "number" && Number.isFinite(record.lastReadSeq)
        ? Math.max(0, Math.min(record.lastEventSeq, Math.floor(record.lastReadSeq)))
        : Math.max(0, record.lastEventSeq),
  };
  const rawBackendId = record.config.backendId;
  if (typeof rawBackendId === "string" && rawBackendId in AGENT_BACKENDS) {
    return {
      ...record,
      ...normalizedMetadata,
    };
  }
  const fallbackBackend = AGENT_BACKENDS[FALLBACK_BACKEND_ID];
  return {
    ...record,
    ...normalizedMetadata,
    status:
      record.status === "running" || record.status === "awaiting_permission"
        ? "idle"
        : record.status,
    providerSessionId: null,
    configOptions: [],
    pendingPermission: null,
    capabilities: fallbackBackend.capabilities,
    experimental: Boolean(fallbackBackend.experimental),
    config: {
      ...record.config,
      backendId: fallbackBackend.id,
      mode: fallbackBackend.defaultMode,
      modelId: fallbackBackend.defaultModelId,
      modelName: fallbackBackend.defaultModelName,
    },
  };
}

async function withConversationQueue<T>(
  workspaceId: string,
  conversationId: string,
  run: () => Promise<T>
): Promise<T> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  appendQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    if (release) {
      release();
    }
    if (appendQueues.get(key) === tail) {
      appendQueues.delete(key);
    }
  }
}

export function subscribeAgentStoreEvents(
  listener: (event: AgentManagerEvent) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function saveConversationRecord(
  record: AgentConversationRecord
): Promise<AgentConversationRecord> {
  await writeJsonFile(
    getConversationMetaFile(record.workspaceId, record.id),
    record
  );
  notify({ type: "conversation", conversation: record });
  return record;
}

export async function readConversationRecord(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationRecord | null> {
  const fallback = null as AgentConversationRecord | null;
  const record = await readJsonFile(
    getConversationMetaFile(workspaceId, conversationId),
    fallback
  );
  if (!record || record.schemaVersion !== 1) {
    return null;
  }
  return normalizeConversationRecord(record);
}

export async function listWorkspaceConversationRecords(
  workspaceId: string
): Promise<AgentConversationRecord[]> {
  const root = getConversationRoot(workspaceId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const conversations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readConversationRecord(workspaceId, entry.name))
  );

  return conversations
    .filter((value): value is AgentConversationRecord => value !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
}

export async function appendConversationEvents(
  workspaceId: string,
  conversationId: string,
  events: AgentEventInput[]
): Promise<AgentStoredEvent[]> {
  if (events.length === 0) {
    return [];
  }

  return withConversationQueue(workspaceId, conversationId, async () => {
    const record = await readConversationRecord(workspaceId, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }

    await ensureDataDir();
    await fs.mkdir(getConversationDir(workspaceId, conversationId), {
      recursive: true,
    });

    let nextSeq = record.lastEventSeq + 1;
    const now = Date.now();
    const appended: AgentStoredEvent[] = events.map((event) => ({
      ...event,
      seq: nextSeq++,
      createdAt: event.createdAt ?? now,
    })) as AgentStoredEvent[];

    const lines = appended.map((event) => JSON.stringify(event)).join("\n");
    if (lines) {
      await fs.appendFile(
        getConversationEventsFile(workspaceId, conversationId),
        `${lines}\n`,
        "utf8"
      );
    }

    // Re-read meta after the append so concurrent queue work (e.g. runtime
    // startSession updating providerSessionId) cannot be overwritten by a
    // stale snapshot captured at the start of this operation.
    const latest = await readConversationRecord(workspaceId, conversationId);
    const base = latest ?? record;
    const updatedRecord: AgentConversationRecord = {
      ...base,
      updatedAt: appended[appended.length - 1]?.createdAt ?? now,
      lastEventSeq: appended[appended.length - 1]?.seq ?? record.lastEventSeq,
    };
    await writeJsonFile(
      getConversationMetaFile(workspaceId, conversationId),
      updatedRecord
    );

    notify({ type: "conversation", conversation: updatedRecord });
    for (const event of appended) {
      notify({
        type: "event",
        workspaceId,
        conversationId,
        event,
      });
    }
    return appended;
  });
}

export async function readConversationEvents(
  workspaceId: string,
  conversationId: string
): Promise<AgentStoredEvent[]> {
  try {
    const raw = await fs.readFile(
      getConversationEventsFile(workspaceId, conversationId),
      "utf8"
    );
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentStoredEvent)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

export async function readConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since = 0
): Promise<AgentStoredEvent[]> {
  const events = await readConversationEvents(workspaceId, conversationId);
  return since > 0 ? events.filter((event) => event.seq > since) : events;
}

export async function readConversationSnapshot(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationSnapshot | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const events = await readConversationEvents(workspaceId, conversationId);
  return { conversation, events };
}

export async function updateConversationRecord(
  workspaceId: string,
  conversationId: string,
  updater:
    | Partial<AgentConversationRecord>
    | ((current: AgentConversationRecord) => AgentConversationRecord)
): Promise<AgentConversationRecord> {
  return withConversationQueue(workspaceId, conversationId, async () => {
    const current = await readConversationRecord(workspaceId, conversationId);
    if (!current) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const next =
      typeof updater === "function"
        ? updater(current)
        : ({
            ...current,
            ...updater,
          } satisfies AgentConversationRecord);
    const normalized: AgentConversationRecord = {
      ...next,
      updatedAt: Date.now(),
    };
    await writeJsonFile(
      getConversationMetaFile(workspaceId, conversationId),
      normalized
    );
    notify({ type: "conversation", conversation: normalized });
    return normalized;
  });
}

export function createConversationId(): string {
  return randomUUID();
}
