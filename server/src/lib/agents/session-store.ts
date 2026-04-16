import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../persistence.js";
import {
  appendStoredConversationEvents,
  deleteStoredConversation,
  getStoredConversation,
  hasStoredConversationEventsBefore,
  insertStoredConversationEvents,
  listStoredConversations,
  readStoredConversationEventPrefixTail,
  readStoredConversationEventTail,
  readStoredConversationEvents,
  readStoredConversationEventsSince,
  type StoredConversationEventRow,
  type StoredConversationRow,
  updateStoredConversation,
  upsertStoredConversation,
} from "../storage.js";
import {
  publishDistributedMessage,
  subscribeDistributedChannel,
} from "../redis-coordination.js";
import { AGENT_BACKENDS } from "./providers.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  DEFAULT_PAGE_EVENTS_CAP,
  DEFAULT_PAGE_TURNS,
  LARGE_LOG_SNAPSHOT_EVENTS,
  LARGE_LOG_SNAPSHOT_TURNS,
  parseEventLine,
  takeLastTurnWindow,
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
/** One in-flight paginated history read per conversation — avoids duplicate pagination scans. */
const historyReadQueues = new Map<string, Promise<unknown>>();
const listeners = new Set<(event: AgentManagerEvent) => void>();
const FALLBACK_BACKEND_ID: AgentBackendId = "cursor-acp";
const DEFAULT_AGENT_HANDOFF_MESSAGE_LIMIT = 25;
const AGENT_STORE_CHANNEL = "opencursor:agent-store-events:v1";
const AGENT_STORE_SOURCE_ID = randomUUID();
const MAX_WINDOW_SCAN_EVENTS = 96_000;
let distributedEventSubscriptionPromise: Promise<void> | null = null;

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
      const changedPath = pathFromFileChange(rawRecord) ?? event.locations?.[0]?.path;
      if (!changedPath) {
        return event;
      }
      const current = await readText(changedPath);
      if (current == null) {
        return event;
      }
      const kinds = fileChangeKinds(rawRecord);
      if (!kinds.every((kind) => kind === "add" || kind === "create")) {
        return event;
      }
      const syntheticResult = {
        path: changedPath,
        changes: rawRecord.changes,
        status: rawRecord.status,
        beforeFullFileContent: "",
        afterFullFileContent: current,
      };
      const preview = extractToolEditPreview(
        { path: changedPath, changes: rawRecord.changes },
        syntheticResult,
        changedPath
      );
      if (!preview) {
        return event;
      }
      return {
        ...event,
        editPreview: preview,
        locations:
          event.locations && event.locations.length > 0
            ? event.locations
            : [{ path: changedPath }],
      };
    })
  );
}

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

function enqueueHistoryRead<T>(
  workspaceId: string,
  conversationId: string,
  run: () => Promise<T>
): Promise<T> {
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

function notifyLocal(event: AgentManagerEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function ensureDistributedEventSubscription(): void {
  if (distributedEventSubscriptionPromise) {
    return;
  }
  distributedEventSubscriptionPromise = subscribeDistributedChannel(
    AGENT_STORE_CHANNEL,
    (message) => {
      try {
        const parsed = JSON.parse(message) as {
          sourceId?: string;
          event?: AgentManagerEvent;
        };
        if (parsed.sourceId === AGENT_STORE_SOURCE_ID || !parsed.event) {
          return;
        }
        notifyLocal(parsed.event);
      } catch {
        // Ignore malformed distributed notifications.
      }
    }
  )
    .then(() => undefined)
    .catch(() => {
      distributedEventSubscriptionPromise = null;
    });
}

function notify(event: AgentManagerEvent): void {
  notifyLocal(event);
  void publishDistributedMessage(
    AGENT_STORE_CHANNEL,
    JSON.stringify({
      sourceId: AGENT_STORE_SOURCE_ID,
      event,
    })
  ).catch(() => undefined);
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

function serializeConversationRow(record: AgentConversationRecord): StoredConversationRow {
  return {
    workspaceId: record.workspaceId,
    conversationId: record.id,
    title: record.title,
    status: record.status,
    lastEventSeq: record.lastEventSeq,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    payload: JSON.stringify(record),
  };
}

function deserializeConversationPayload(payload: string): AgentConversationRecord | null {
  try {
    const parsed = JSON.parse(payload) as AgentConversationRecord;
    if (!parsed || parsed.schemaVersion !== 1) {
      return null;
    }
    return normalizeConversationRecord(parsed);
  } catch {
    return null;
  }
}

function deserializeConversationRow(row: StoredConversationRow): AgentConversationRecord | null {
  return deserializeConversationPayload(row.payload);
}

function deserializeEventRows(rows: StoredConversationEventRow[]): AgentStoredEvent[] {
  return rows
    .map((row) => {
      const parsed = parseEventLine(row.payload);
      return parsed && typeof parsed.seq === "number" ? parsed : null;
    })
    .filter((value): value is AgentStoredEvent => value !== null)
    .sort((left, right) => left.seq - right.seq);
}

function countUserTurns(events: AgentStoredEvent[]): number {
  return events.filter((event) => event.kind === "user_message").length;
}

async function migrateLegacyConversation(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationRecord | null> {
  const existing = await getStoredConversation(workspaceId, conversationId);
  if (existing) {
    return deserializeConversationRow(existing);
  }

  let rawRecord: string;
  try {
    rawRecord = await fs.readFile(getConversationMetaFile(workspaceId, conversationId), "utf8");
  } catch {
    return null;
  }

  let parsedRecord: AgentConversationRecord | null = null;
  try {
    const parsed = JSON.parse(rawRecord) as AgentConversationRecord;
    if (parsed && parsed.schemaVersion === 1) {
      parsedRecord = normalizeConversationRecord(parsed);
    }
  } catch {
    parsedRecord = null;
  }
  if (!parsedRecord) {
    return null;
  }

  await upsertStoredConversation(serializeConversationRow(parsedRecord));

  let eventRows: StoredConversationEventRow[] = [];
  try {
    const rawEvents = await fs.readFile(getConversationEventsFile(workspaceId, conversationId), "utf8");
    eventRows = rawEvents
      .split(/\r?\n/)
      .map((line) => parseEventLine(line))
      .filter((value): value is AgentStoredEvent => value !== null)
      .sort((left, right) => left.seq - right.seq)
      .map((event) => ({
        workspaceId,
        conversationId,
        seq: event.seq,
        createdAt: event.createdAt,
        payload: JSON.stringify(event),
      }));
  } catch {
    eventRows = [];
  }
  if (eventRows.length > 0) {
    await insertStoredConversationEvents(eventRows);
  }

  return parsedRecord;
}

async function migrateLegacyWorkspaceConversations(workspaceId: string): Promise<void> {
  const root = getConversationRoot(workspaceId);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => migrateLegacyConversation(workspaceId, entry.name))
  );
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
    release?.();
    if (appendQueues.get(key) === tail) {
      appendQueues.delete(key);
    }
  }
}

async function readTurnWindow(
  workspaceId: string,
  conversationId: string,
  input: {
    beforeSeq?: number;
    limitTurns: number;
    limitEvents: number;
  }
): Promise<{
  events: AgentStoredEvent[];
  oldestSeq: number;
  newestSeq: number;
  hasOlder: boolean;
}> {
  const limitTurns = Math.max(1, input.limitTurns);
  const limitEvents = Math.max(1, input.limitEvents);
  let fetchLimit = Math.min(
    MAX_WINDOW_SCAN_EVENTS,
    Math.max(limitEvents * 2, limitTurns * 32, 512)
  );

  while (true) {
    const rows =
      typeof input.beforeSeq === "number"
        ? await readStoredConversationEventPrefixTail(
            workspaceId,
            conversationId,
            input.beforeSeq,
            fetchLimit
          )
        : await readStoredConversationEventTail(workspaceId, conversationId, fetchLimit);
    const ordered = deserializeEventRows(rows);
    const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
    const exhausted = rows.length < fetchLimit || fetchLimit >= MAX_WINDOW_SCAN_EVENTS;
    if (exhausted || slice.length === 0 || countUserTurns(slice) >= limitTurns) {
      const oldestSeq = slice[0]?.seq ?? 0;
      const newestSeq = slice[slice.length - 1]?.seq ?? 0;
      const hasOlder =
        oldestSeq > 0
          ? await hasStoredConversationEventsBefore(
              workspaceId,
              conversationId,
              oldestSeq
            )
          : false;
      return {
        events: slice,
        oldestSeq,
        newestSeq,
        hasOlder,
      };
    }
    fetchLimit = Math.min(MAX_WINDOW_SCAN_EVENTS, fetchLimit * 2);
  }
}

export function subscribeAgentStoreEvents(
  listener: (event: AgentManagerEvent) => void
): () => void {
  ensureDistributedEventSubscription();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function saveConversationRecord(
  record: AgentConversationRecord
): Promise<AgentConversationRecord> {
  await upsertStoredConversation(serializeConversationRow(record));
  notify({ type: "conversation", conversation: record });
  return record;
}

export async function readConversationRecord(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationRecord | null> {
  const stored = await getStoredConversation(workspaceId, conversationId);
  const parsed = stored ? deserializeConversationRow(stored) : null;
  if (parsed) {
    return parsed;
  }
  return migrateLegacyConversation(workspaceId, conversationId);
}

export async function listWorkspaceConversationRecords(
  workspaceId: string
): Promise<AgentConversationRecord[]> {
  await migrateLegacyWorkspaceConversations(workspaceId);
  const rows = await listStoredConversations(workspaceId);
  return rows
    .map((row) => deserializeConversationRow(row))
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
    const now = Date.now();
    const result = await appendStoredConversationEvents(
      workspaceId,
      conversationId,
      events.map((event) => ({
        createdAt: event.createdAt ?? now,
        buildPayload: (assigned) =>
          JSON.stringify({
            ...event,
            seq: assigned.seq,
            createdAt: assigned.createdAt,
          }),
      })),
      (currentRow, assignedRows) => {
        const current = deserializeConversationRow(currentRow) ?? record;
        const updatedRecord: AgentConversationRecord = {
          ...current,
          updatedAt: assignedRows[assignedRows.length - 1]?.createdAt ?? now,
          lastEventSeq: assignedRows[assignedRows.length - 1]?.seq ?? current.lastEventSeq,
        };
        return serializeConversationRow(updatedRecord);
      }
    );

    const appended = deserializeEventRows(result.events);
    const updatedRecord = deserializeConversationRow(result.conversation);
    if (!updatedRecord) {
      throw new Error(`Conversation payload became invalid: ${conversationId}`);
    }

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
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return [];
  }
  const rows = await readStoredConversationEvents(workspaceId, conversationId);
  return enrichEventsWithDerivedEditPreview(deserializeEventRows(rows));
}

export async function readConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since = 0
): Promise<AgentStoredEvent[]> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return [];
  }
  const rows = await readStoredConversationEventsSince(workspaceId, conversationId, since);
  return enrichEventsWithDerivedEditPreview(deserializeEventRows(rows));
}

export async function readRecentConversationEvents(
  workspaceId: string,
  conversationId: string,
  limitMessages?: number
): Promise<AgentStoredEvent[]> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation || conversation.lastEventSeq === 0) {
    return [];
  }
  const messageLimit = limitMessages ?? getAgentHandoffMessageLimit();
  const page = await readTurnWindow(workspaceId, conversationId, {
    limitTurns: messageLimit * 2 + 10,
    limitEvents: messageLimit * 50 + 100,
  });
  return enrichEventsWithDerivedEditPreview(page.events);
}

export async function readConversationSnapshot(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationSnapshot | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  if (conversation.lastEventSeq === 0) {
    return { conversation, events: [] };
  }
  if (conversation.lastEventSeq <= LARGE_LOG_SNAPSHOT_EVENTS) {
    return {
      conversation,
      events: await readConversationEvents(workspaceId, conversationId),
    };
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
    events: head.events,
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
  const page = await readTurnWindow(workspaceId, conversationId, {
    limitTurns: options?.limitTurns ?? DEFAULT_PAGE_TURNS,
    limitEvents: options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP,
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
  return enqueueHistoryRead(workspaceId, conversationId, async () => {
    const page = await readTurnWindow(workspaceId, conversationId, {
      beforeSeq,
      limitTurns: options?.limitTurns ?? DEFAULT_PAGE_TURNS,
      limitEvents: options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP,
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
    const updated = await updateStoredConversation(
      workspaceId,
      conversationId,
      (currentRow) => {
        const currentRecord = deserializeConversationRow(currentRow) ?? current;
        const next =
          typeof updater === "function"
            ? updater(currentRecord)
            : ({
                ...currentRecord,
                ...updater,
              } satisfies AgentConversationRecord);
        return serializeConversationRow({
          ...next,
          updatedAt: Date.now(),
        });
      }
    );
    const normalized = updated ? deserializeConversationRow(updated) : null;
    if (!normalized) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    notify({ type: "conversation", conversation: normalized });
    return normalized;
  });
}

export function createConversationId(): string {
  return randomUUID();
}

/** Best-effort delete of persisted conversation data; notifies listeners like the in-app delete path. */
export async function deleteConversationFromStore(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  await previous.catch(() => undefined);
  appendQueues.delete(key);
  await deleteStoredConversation(workspaceId, conversationId).catch(() => undefined);
  notify({ type: "conversation_deleted", workspaceId, conversationId });
}
