import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir, readJsonFile, writeJsonFile } from "../persistence.js";
import { AGENT_BACKENDS } from "./providers.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  DEFAULT_PAGE_EVENTS_CAP,
  DEFAULT_PAGE_TURNS,
  EVENT_LOG_FULL_READ_MAX_BYTES,
  LARGE_LOG_SNAPSHOT_EVENTS,
  LARGE_LOG_SNAPSHOT_TURNS,
  readConversationEventHistoryPage,
  readConversationEventsSinceEfficient,
  readConversationEventTailPage,
} from "./event-log-read.js";
import type {
  AgentBackendId,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentEventInput,
  AgentManagerEvent,
  AgentStoredEvent,
} from "./types.js";

const appendQueues = new Map<string, Promise<void>>();
/** One in-flight paginated history read per conversation — avoids parallel full-log scans from fast scroll. */
const historyReadQueues = new Map<string, Promise<unknown>>();
const listeners = new Set<(event: AgentManagerEvent) => void>();
const FALLBACK_BACKEND_ID: AgentBackendId = "cursor-acp";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pathFromFileChange(rawRecord: Record<string, unknown>): string | undefined {
  const changes = Array.isArray(rawRecord.changes) ? rawRecord.changes : undefined;
  if (!changes) {
    return undefined;
  }
  for (const change of changes) {
    const record = asRecord(change);
    if (!record) {
      continue;
    }
    const value = record.path;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function fileChangeKinds(rawRecord: Record<string, unknown>): string[] {
  const changes = Array.isArray(rawRecord.changes) ? rawRecord.changes : undefined;
  if (!changes) {
    return [];
  }
  return changes
    .map((change) => {
      const record = asRecord(change);
      return typeof record?.kind === "string" ? record.kind.toLowerCase() : "";
    })
    .filter(Boolean);
}

async function enrichEventsWithDerivedEditPreview(
  events: AgentStoredEvent[]
): Promise<AgentStoredEvent[]> {
  const cache = new Map<string, string | null>();
  const readText = async (filePath: string): Promise<string | null> => {
    if (cache.has(filePath)) {
      return cache.get(filePath) ?? null;
    }
    try {
      const text = await fs.readFile(filePath, "utf8");
      cache.set(filePath, text);
      return text;
    } catch {
      cache.set(filePath, null);
      return null;
    }
  };

  return Promise.all(
    events.map(async (event) => {
      if (
        (event.kind !== "tool_call" && event.kind !== "tool_call_update") ||
        event.toolKind !== "edit" ||
        event.editPreview
      ) {
        return event;
      }
      const rawTop = asRecord(event.raw);
      const rawRecord = asRecord(rawTop?.update) ?? rawTop;
      if (rawRecord?.type !== "file_change") {
        return event;
      }
      const path = pathFromFileChange(rawRecord) ?? event.locations?.[0]?.path;
      if (!path) {
        return event;
      }
      const current = await readText(path);
      if (current == null) {
        return event;
      }
      const kinds = fileChangeKinds(rawRecord);
      if (!kinds.every((kind) => kind === "add" || kind === "create")) {
        return event;
      }
      const syntheticResult = {
        path,
        changes: rawRecord.changes,
        status: rawRecord.status,
        beforeFullFileContent: "",
        afterFullFileContent: current,
      };
      const preview = extractToolEditPreview(
        { path, changes: rawRecord.changes },
        syntheticResult,
        path
      );
      if (!preview) {
        return event;
      }
      return {
        ...event,
        editPreview: preview,
        locations:
          event.locations && event.locations.length > 0 ? event.locations : [{ path }],
      };
    })
  );
}

const DEFAULT_AGENT_HANDOFF_MESSAGE_LIMIT = 25;
function getAgentHandoffMessageLimit(): number {
  const envVal = process.env.OPENCURSOR_AGENT_HANDOFF_MESSAGE_LIMIT?.trim();
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_AGENT_HANDOFF_MESSAGE_LIMIT;
}

function enqueueHistoryRead<T>(workspaceId: string, conversationId: string, run: () => Promise<T>): Promise<T> {
  const key = `${workspaceId}:${conversationId}`;
  const prev = historyReadQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => run());
  historyReadQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

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
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentStoredEvent)
      .sort((a, b) => a.seq - b.seq);
    return enrichEventsWithDerivedEditPreview(events);
  } catch {
    return [];
  }
}

export async function readConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since = 0
): Promise<AgentStoredEvent[]> {
  const filePath = getConversationEventsFile(workspaceId, conversationId);
  const events = await readConversationEventsSinceEfficient(filePath, since);
  return enrichEventsWithDerivedEditPreview(events);
}

export async function readRecentConversationEvents(
  workspaceId: string,
  conversationId: string,
  limitMessages?: number
): Promise<AgentStoredEvent[]> {
  const messageLimit = limitMessages ?? getAgentHandoffMessageLimit();
  const events = await readConversationEvents(workspaceId, conversationId);
  if (events.length === 0) {
    return [];
  }
  const { takeLastTurnWindow } = await import("./event-log-read.js");
  const turns = messageLimit * 2 + 10;
  const eventsLimit = messageLimit * 50 + 100;
    return enrichEventsWithDerivedEditPreview(takeLastTurnWindow(events, turns, eventsLimit));
  }

export async function readConversationSnapshot(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationSnapshot | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const filePath = getConversationEventsFile(workspaceId, conversationId);
  let size = 0;
  try {
    const st = await fs.stat(filePath);
    size = st.size;
  } catch {
    return { conversation, events: [] };
  }
  if (size === 0) {
    return { conversation, events: [] };
  }
  if (size <= EVENT_LOG_FULL_READ_MAX_BYTES) {
    const events = await readConversationEvents(workspaceId, conversationId);
    return { conversation, events };
  }
  const head = await readConversationSnapshotHead(workspaceId, conversationId, {
    limitTurns: LARGE_LOG_SNAPSHOT_TURNS,
    limitEvents: LARGE_LOG_SNAPSHOT_EVENTS,
  });
  if (!head) {
    return { conversation, events: [] };
  }
  return {
    conversation: head.conversation,
    events: await enrichEventsWithDerivedEditPreview(head.events),
  };
}

export async function readConversationSnapshotHead(
  workspaceId: string,
  conversationId: string,
  options?: { limitTurns?: number; limitEvents?: number }
): Promise<AgentConversationSnapshotHead | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const filePath = getConversationEventsFile(workspaceId, conversationId);
  const limitTurns = options?.limitTurns ?? DEFAULT_PAGE_TURNS;
  const limitEvents = options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP;
  const page = await readConversationEventTailPage(filePath, {
    limitTurns,
    limitEvents,
  });
  const events = await enrichEventsWithDerivedEditPreview(page.events);
  return {
    conversation,
    events,
    window: {
      oldestSeq: events[0]?.seq ?? page.oldestSeq,
      newestSeq: events[events.length - 1]?.seq ?? page.newestSeq,
      hasOlder: page.hasOlder,
    },
  };
}

export async function readConversationHistoryPage(
  workspaceId: string,
  conversationId: string,
  beforeSeq: number,
  options?: { limitTurns?: number; limitEvents?: number }
): Promise<{ events: AgentStoredEvent[]; window: AgentConversationSnapshotHead["window"] } | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const filePath = getConversationEventsFile(workspaceId, conversationId);
  const limitTurns = options?.limitTurns ?? DEFAULT_PAGE_TURNS;
  const limitEvents = options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP;
  return enqueueHistoryRead(workspaceId, conversationId, async () => {
    const page = await readConversationEventHistoryPage(filePath, beforeSeq, {
      limitTurns,
      limitEvents,
    });
    const events = await enrichEventsWithDerivedEditPreview(page.events);
    return {
      events,
      window: {
        oldestSeq: events[0]?.seq ?? page.oldestSeq,
        newestSeq: events[events.length - 1]?.seq ?? page.newestSeq,
        hasOlder: page.hasOlder,
      },
    };
  });
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

/** Best-effort delete of persisted conversation files; notifies listeners like the in-app delete path. */
export async function deleteConversationFromStore(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  await previous.catch(() => undefined);
  appendQueues.delete(key);
  const dir = getConversationDir(workspaceId, conversationId);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  notify({ type: "conversation_deleted", workspaceId, conversationId });
}
