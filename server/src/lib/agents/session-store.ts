import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { del as cacheDel, getJSON as cacheGetJSON, setJSON as cacheSetJSON } from "../../cache/kv.js";
import { publish, subscribeSync } from "../../cache/pubsub.js";
import { getStorage } from "../../storage/runtime.js";
import { normalizeConversationRecord } from "./conversation-normalize.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  DEFAULT_PAGE_EVENTS_CAP,
  DEFAULT_PAGE_TURNS,
  EVENT_LOG_FULL_READ_MAX_BYTES,
  LARGE_LOG_SNAPSHOT_EVENTS,
  LARGE_LOG_SNAPSHOT_TURNS,
  readConversationEventHistoryPage,
  readConversationEventTailPage,
  takeLastTurnWindow,
} from "./event-log-read.js";
import { getConversationEventsFile } from "./session-store-legacy-fs.js";
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
const historyReadQueues = new Map<string, Promise<unknown>>();
const AGENT_STORE_EVENTS_CHANNEL = "opencursor:agent:store-events";

const CONV_LIST_CACHE_PREFIX = "agent:conv-list:";
const CONV_LIST_CACHE_TTL_SEC = 60;
const CONV_SNAPSHOT_HEAD_CACHE_PREFIX = "agent:snap-head:";
const CONV_SNAPSHOT_HEAD_CACHE_TTL_SEC = 30;

function conversationListCacheKey(workspaceId: string): string {
  return `${CONV_LIST_CACHE_PREFIX}${workspaceId}`;
}

function snapshotHeadCacheKey(workspaceId: string, conversationId: string): string {
  return `${CONV_SNAPSHOT_HEAD_CACHE_PREFIX}${workspaceId}:${conversationId}`;
}

async function invalidateConversationCaches(
  workspaceId: string,
  conversationId?: string
): Promise<void> {
  await cacheDel(conversationListCacheKey(workspaceId));
  if (conversationId) {
    await cacheDel(snapshotHeadCacheKey(workspaceId, conversationId));
  }
}

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
      const p = pathFromFileChange(rawRecord) ?? event.locations?.[0]?.path;
      if (!p) {
        return event;
      }
      const current = await readText(p);
      if (current == null) {
        return event;
      }
      const kinds = fileChangeKinds(rawRecord);
      if (!kinds.every((kind) => kind === "add" || kind === "create")) {
        return event;
      }
      const syntheticResult = {
        path: p,
        changes: rawRecord.changes,
        status: rawRecord.status,
        beforeFullFileContent: "",
        afterFullFileContent: current,
      };
      const preview = extractToolEditPreview(
        { path: p, changes: rawRecord.changes },
        syntheticResult,
        p
      );
      if (!preview) {
        return event;
      }
      return {
        ...event,
        editPreview: preview,
        locations:
          event.locations && event.locations.length > 0 ? event.locations : [{ path: p }],
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

function queueKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}

function notify(event: AgentManagerEvent): void {
  void publish(AGENT_STORE_EVENTS_CHANNEL, event);
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
  return subscribeSync<AgentManagerEvent>(AGENT_STORE_EVENTS_CHANNEL, listener);
}

export async function saveConversationRecord(
  record: AgentConversationRecord
): Promise<AgentConversationRecord> {
  await (await getStorage()).upsertAgentConversation(record);
  await invalidateConversationCaches(record.workspaceId, record.id);
  notify({ type: "conversation", conversation: record });
  return record;
}

export async function readConversationRecord(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationRecord | null> {
  const storage = await getStorage();
  const record = await storage.getAgentConversation(conversationId);
  if (!record || record.workspaceId !== workspaceId) {
    return null;
  }
  return normalizeConversationRecord(record);
}

export async function listWorkspaceConversationRecords(
  workspaceId: string
): Promise<AgentConversationRecord[]> {
  const cacheKey = conversationListCacheKey(workspaceId);
  const cached = await cacheGetJSON<AgentConversationRecord[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const { records } = await (await getStorage()).listAgentConversations({
    workspaceId,
    limit: 500,
    includeArchived: true,
  });
  const sorted = records
    .map((r) => normalizeConversationRecord(r))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  await cacheSetJSON(cacheKey, sorted, CONV_LIST_CACHE_TTL_SEC);
  return sorted;
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
    const storage = await getStorage();
    const appended = await storage.appendAgentEvents({ conversationId, events });
    const updated = await storage.getAgentConversation(conversationId);
    if (!updated) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    await invalidateConversationCaches(workspaceId, conversationId);
    notify({ type: "conversation", conversation: updated });
    for (const event of appended.events) {
      notify({
        type: "event",
        workspaceId,
        conversationId,
        event,
      });
    }
    return appended.events;
  });
}

export async function readConversationEvents(
  workspaceId: string,
  conversationId: string
): Promise<AgentStoredEvent[]> {
  const storage = await getStorage();
  const rec = await storage.getAgentConversation(conversationId);
  if (!rec || rec.workspaceId !== workspaceId) {
    return [];
  }
  const events = await storage.readAgentEvents({
    conversationId,
    afterSeq: 0,
    limit: 100_000,
  });
  return enrichEventsWithDerivedEditPreview(events);
}

export async function readConversationEventsSince(
  workspaceId: string,
  conversationId: string,
  since = 0
): Promise<AgentStoredEvent[]> {
  const storage = await getStorage();
  const rec = await storage.getAgentConversation(conversationId);
  if (!rec || rec.workspaceId !== workspaceId) {
    return [];
  }
  const events = await storage.readAgentEvents({
    conversationId,
    afterSeq: since,
    limit: 100_000,
  });
  return enrichEventsWithDerivedEditPreview(events);
}

export async function readRecentConversationEvents(
  workspaceId: string,
  conversationId: string,
  limitMessages?: number
): Promise<AgentStoredEvent[]> {
  const messageLimit = limitMessages ?? getAgentHandoffMessageLimit();
  const storage = await getStorage();
  const rec = await storage.getAgentConversation(conversationId);
  if (!rec || rec.workspaceId !== workspaceId) {
    return [];
  }
  const events = await storage.readRecentAgentEvents(
    conversationId,
    messageLimit * 50 + 100
  );
  if (events.length === 0) {
    return [];
  }
  const turns = messageLimit * 2 + 10;
  const eventsLimit = messageLimit * 50 + 100;
  return enrichEventsWithDerivedEditPreview(
    takeLastTurnWindow(events, turns, eventsLimit)
  );
}

export async function readConversationSnapshot(
  workspaceId: string,
  conversationId: string
): Promise<AgentConversationSnapshot | null> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const storage = await getStorage();
  const filePath = getConversationEventsFile(workspaceId, conversationId);

  if (storage.kind === "legacy-json") {
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

  const events = await storage.readAgentEvents({
    conversationId,
    afterSeq: 0,
    limit: 100_000,
  });
  return {
    conversation,
    events: await enrichEventsWithDerivedEditPreview(events),
  };
}

export async function readConversationSnapshotHead(
  workspaceId: string,
  conversationId: string,
  options?: { limitTurns?: number; limitEvents?: number }
): Promise<AgentConversationSnapshotHead | null> {
  const usingDefaults =
    options?.limitTurns === undefined && options?.limitEvents === undefined;
  if (usingDefaults) {
    const cached = await cacheGetJSON<AgentConversationSnapshotHead>(
      snapshotHeadCacheKey(workspaceId, conversationId)
    );
    if (cached) {
      return cached;
    }
  }

  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return null;
  }
  const limitTurns = options?.limitTurns ?? DEFAULT_PAGE_TURNS;
  const limitEvents = options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP;
  const storage = await getStorage();

  if (storage.kind === "legacy-json") {
    const filePath = getConversationEventsFile(workspaceId, conversationId);
    const page = await readConversationEventTailPage(filePath, {
      limitTurns,
      limitEvents,
    });
    const events = await enrichEventsWithDerivedEditPreview(page.events);
    const result: AgentConversationSnapshotHead = {
      conversation,
      events,
      window: {
        oldestSeq: events[0]?.seq ?? page.oldestSeq,
        newestSeq: events[events.length - 1]?.seq ?? page.newestSeq,
        hasOlder: page.hasOlder,
      },
    };
    if (usingDefaults) {
      await cacheSetJSON(
        snapshotHeadCacheKey(workspaceId, conversationId),
        result,
        CONV_SNAPSHOT_HEAD_CACHE_TTL_SEC
      );
    }
    return result;
  }

  const raw = await storage.readRecentAgentEvents(
    conversationId,
    Math.min(50_000, conversation.lastEventSeq + 200)
  );
  const slice = takeLastTurnWindow(raw, limitTurns, limitEvents);
  const events = await enrichEventsWithDerivedEditPreview(slice);
  const result: AgentConversationSnapshotHead = {
    conversation,
    events,
    window: {
      oldestSeq: events[0]?.seq ?? raw[0]?.seq ?? 0,
      newestSeq: events[events.length - 1]?.seq ?? raw[raw.length - 1]?.seq ?? 0,
      hasOlder: raw.length >= Math.min(50_000, conversation.lastEventSeq + 200),
    },
  };
  if (usingDefaults) {
    await cacheSetJSON(
      snapshotHeadCacheKey(workspaceId, conversationId),
      result,
      CONV_SNAPSHOT_HEAD_CACHE_TTL_SEC
    );
  }
  return result;
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
  const storage = await getStorage();
  const limitTurns = options?.limitTurns ?? DEFAULT_PAGE_TURNS;
  const limitEvents = options?.limitEvents ?? DEFAULT_PAGE_EVENTS_CAP;

  return enqueueHistoryRead(workspaceId, conversationId, async () => {
    if (storage.kind === "legacy-json") {
      const filePath = getConversationEventsFile(workspaceId, conversationId);
      const rollingCap =
        Math.min(
          96_000,
          Math.max(limitEvents * 40, limitTurns * 1600, 12_000)
        );
      const page = await readConversationEventHistoryPage(filePath, beforeSeq, {
        limitTurns,
        limitEvents,
        rollingCap,
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
    }

    const rollingCap = Math.min(
      96_000,
      Math.max(limitEvents * 40, limitTurns * 1600, 12_000)
    );
    const prefix = await storage.readAgentEventsOlderThan({
      conversationId,
      beforeSeq,
      limit: rollingCap,
    });
    const slice = takeLastTurnWindow(prefix, limitTurns, limitEvents);
    const oldestSeq = slice[0]?.seq ?? 0;
    const newestSeq = slice[slice.length - 1]?.seq ?? 0;
    const minSeq = prefix[0]?.seq ?? 0;
    const hasOlder =
      slice.length > 0 && (oldestSeq > minSeq || prefix.length === rollingCap);
    const events = await enrichEventsWithDerivedEditPreview(slice);
    return {
      events,
      window: {
        oldestSeq: events[0]?.seq ?? oldestSeq,
        newestSeq: events[events.length - 1]?.seq ?? newestSeq,
        hasOlder,
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
    await (await getStorage()).upsertAgentConversation(normalized);
    await invalidateConversationCaches(workspaceId, conversationId);
    notify({ type: "conversation", conversation: normalized });
    return normalized;
  });
}

export function createConversationId(): string {
  return randomUUID();
}

export async function deleteConversationFromStore(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const key = queueKey(workspaceId, conversationId);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  await previous.catch(() => undefined);
  appendQueues.delete(key);

  const storage = await getStorage();
  const existing = await storage.getAgentConversation(conversationId);
  if (existing && existing.workspaceId !== workspaceId) {
    return;
  }
  await storage.deleteAgentConversation(conversationId);
  await invalidateConversationCaches(workspaceId, conversationId);
  notify({ type: "conversation_deleted", workspaceId, conversationId });
}
