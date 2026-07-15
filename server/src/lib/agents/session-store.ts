import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { del as cacheDel, getJSON as cacheGetJSON, setJSON as cacheSetJSON } from "../../cache/kv.js";
import { publish, subscribeSync } from "../../cache/pubsub.js";
import { measureServerPerf } from "../perf.js";
import { getStorage } from "../../storage/runtime.js";
import { normalizeConversationRecord } from "./conversation-normalize.js";
import { isAgentConversationRankNeutralDelta } from "./conversation-rank.js";
import { asRecord } from "./json-coerce.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  countUserMessageEvents,
  DEFAULT_PAGE_EVENTS_CAP,
  DEFAULT_PAGE_TURNS,
  EVENT_LOG_FULL_READ_MAX_BYTES,
  expandSliceToMinUserTurns,
  LARGE_LOG_SNAPSHOT_EVENTS,
  LARGE_LOG_SNAPSHOT_TURNS,
  MIN_USER_TURNS_IN_INITIAL_HEAD,
  PAGINATION_MIN_USER_TURNS,
  readConversationEventHistoryPage,
  readConversationEventTailPage,
  takeLastTurnWindow,
  trimToTurnStart,
} from "./event-log-read.js";
import { getConversationEventsFile } from "./session-store-legacy-fs.js";
import {
  CONV_LIST_CACHE_TTL_SEC,
  CONV_SNAPSHOT_HEAD_CACHE_TTL_SEC,
  RAIL_ALL_FIRST_PAGE_CACHE_KEY,
  conversationListCacheKey,
  snapshotHeadCacheKey,
} from "./cache-keys.js";
import type {
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

/** `readAgentEvents` caps at 10k rows; if `lastEventSeq` exceeds this, the "prefix" read cannot be the full log. */
const PG_READ_HEAD_PREFIX_CAP = 10_000;

/**
 * After a debounced write, repopulate snapshot-head + per-workspace list Redis + the first-page
 * cross-workspace rail so cold GETs and HTTP revalidation do not repackage huge graphs from raw DB.
 */
let agentCacheRefillTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAgentCacheRefill:
  | {
      workspaceId: string;
      conversationId: string;
    }
  | null = null;

const AGENT_CACHE_REFILL_DEBOUNCE_MS = 650;

function scheduleAgentCacheRefill(
  workspaceId: string,
  conversationId: string
): void {
  pendingAgentCacheRefill = { workspaceId, conversationId };
  if (agentCacheRefillTimer) {
    clearTimeout(agentCacheRefillTimer);
  }
  agentCacheRefillTimer = setTimeout(() => {
    agentCacheRefillTimer = null;
    const next = pendingAgentCacheRefill;
    pendingAgentCacheRefill = null;
    if (!next) {
      return;
    }
    void runAgentCacheRefill(next.workspaceId, next.conversationId).catch((err) => {
      console.error("[agent-store] post-write cache refill failed:", err);
    });
  }, AGENT_CACHE_REFILL_DEBOUNCE_MS);
  agentCacheRefillTimer.unref?.();
}

async function runAgentCacheRefill(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  const conversation = await readConversationRecord(workspaceId, conversationId);
  if (!conversation) {
    return;
  }
  await readConversationSnapshotHead(workspaceId, conversationId, {
    conversation,
  });
  const { repopulateAgentRailFirstPageCache } = await import("./rail-payload.js");
  await repopulateAgentRailFirstPageCache();
}

async function invalidateConversationCaches(
  workspaceId: string,
  conversationId?: string
): Promise<void> {
  await cacheDel(RAIL_ALL_FIRST_PAGE_CACHE_KEY);
  await cacheDel(conversationListCacheKey(workspaceId));
  if (conversationId) {
    await cacheDel(snapshotHeadCacheKey(workspaceId, conversationId));
  }
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

/** Skip read when the on-disk file is huge (prevents OOM; stat is one syscall vs loading MB). */
const EDIT_PREVIEW_MAX_FILE_BYTES = 400_000;
/** Unbounded `Promise.all` on thousands of paths destroys NFS/SSHFS; cap concurrent fs ops. */
const EDIT_PREVIEW_ENRICH_CONCURRENCY = 32;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapFn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const n = items.length;
  const out: R[] = new Array(n);
  let next = 0;
  const cap = Math.max(1, Math.min(Math.floor(concurrency), n));
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) {
        return;
      }
      out[i] = await mapFn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return out;
}

async function enrichEventsWithDerivedEditPreview(
  events: AgentStoredEvent[]
): Promise<AgentStoredEvent[]> {
  const pathTextCache = new Map<string, string | null>();
  const readText = async (filePath: string): Promise<string | null> => {
    if (pathTextCache.has(filePath)) {
      return pathTextCache.get(filePath) ?? null;
    }
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > EDIT_PREVIEW_MAX_FILE_BYTES) {
        pathTextCache.set(filePath, null);
        return null;
      }
      const text = await fs.readFile(filePath, "utf8");
      pathTextCache.set(filePath, text);
      return text;
    } catch {
      pathTextCache.set(filePath, null);
      return null;
    }
  };

  return mapWithConcurrency(
    events,
    EDIT_PREVIEW_ENRICH_CONCURRENCY,
    async (event) => {
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
    }
  );
}

const DEFAULT_AGENT_HANDOFF_MESSAGE_LIMIT = 250;
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
  scheduleAgentCacheRefill(record.workspaceId, record.id);
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
  return measureServerPerf(
    "agent.listWorkspaceConversationRecords",
    async () => {
      const cacheKey = conversationListCacheKey(workspaceId);
      const cached = await cacheGetJSON<AgentConversationRecord[]>(cacheKey);
      if (cached) {
        return cached;
      }

      const all: AgentConversationRecord[] = [];
      let cursor: string | null | undefined = null;
      do {
        const page = await (await getStorage()).listAgentConversations({
          workspaceId,
          cursor,
          limit: 500,
          includeArchived: true,
        });
        all.push(...page.records);
        cursor = page.nextCursor;
      } while (cursor);

      const sorted = all
        .map((r) => normalizeConversationRecord(r))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
      await cacheSetJSON(cacheKey, sorted, CONV_LIST_CACHE_TTL_SEC);
      return sorted;
    },
    { workspaceId }
  );
}

export async function listWorkspaceConversationRecordPage(
  workspaceId: string,
  options?: { limit?: number; cursor?: string | null; includeArchived?: boolean }
): Promise<{ records: AgentConversationRecord[]; nextCursor: string | null }> {
  return measureServerPerf(
    "agent.listWorkspaceConversationRecordPage",
    async () => {
      const page = await (await getStorage()).listAgentConversations({
        workspaceId,
        cursor: options?.cursor,
        limit: options?.limit,
        includeArchived: options?.includeArchived,
      });
      return {
        records: page.records.map((r) => normalizeConversationRecord(r)),
        nextCursor: page.nextCursor,
      };
    },
    { workspaceId, limit: options?.limit ?? null, cursor: options?.cursor ?? null }
  );
}

export async function appendConversationEvents(
  workspaceId: string,
  conversationId: string,
  events: AgentEventInput[]
): Promise<AgentStoredEvent[]> {
  if (events.length === 0) {
    return [];
  }

  return measureServerPerf(
    "agent.appendConversationEvents",
    () =>
      withConversationQueue(workspaceId, conversationId, async () => {
        const storage = await getStorage();
        const appended = await storage.appendAgentEvents({ conversationId, events });
        const updated = await storage.getAgentConversation(conversationId);
        if (!updated) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }
        await invalidateConversationCaches(workspaceId, conversationId);
        scheduleAgentCacheRefill(workspaceId, conversationId);
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
      }),
    { workspaceId, conversationId, events: events.length }
  );
}

export async function appendConversationEventsAndPatchRecord(
  workspaceId: string,
  conversationId: string,
  events: AgentEventInput[],
  conversationPatch: Partial<
    Pick<AgentConversationRecord, "status" | "pendingPermission" | "lastError">
  >
): Promise<{ events: AgentStoredEvent[]; conversation: AgentConversationRecord }> {
  if (events.length === 0) {
    const conversation = await readConversationRecord(workspaceId, conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return { events: [], conversation };
  }

  return measureServerPerf(
    "agent.appendConversationEventsAndPatchRecord",
    () =>
      withConversationQueue(workspaceId, conversationId, async () => {
        const storage = await getStorage();
        const appended = await storage.appendAgentEvents({
          conversationId,
          events,
          conversationPatch,
        });
        const updated = await storage.getAgentConversation(conversationId);
        if (!updated) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }
        const normalized = normalizeConversationRecord(updated);
        await invalidateConversationCaches(workspaceId, conversationId);
        scheduleAgentCacheRefill(workspaceId, conversationId);
        notify({ type: "conversation", conversation: normalized });
        for (const event of appended.events) {
          notify({
            type: "event",
            workspaceId,
            conversationId,
            event,
          });
        }
        return { events: appended.events, conversation: normalized };
      }),
    { workspaceId, conversationId, events: events.length }
  );
}

export async function deleteConversationEvents(
  workspaceId: string,
  conversationId: string,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length === 0) {
    return;
  }

  return withConversationQueue(workspaceId, conversationId, async () => {
    const storage = await getStorage();
    await storage.deleteAgentEvents({ conversationId, eventIds });
    await invalidateConversationCaches(workspaceId, conversationId);
    scheduleAgentCacheRefill(workspaceId, conversationId);
    const updated = await storage.getAgentConversation(conversationId);
    if (updated) {
      notify({ type: "conversation", conversation: updated });
    }
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

function dropDuplicateEventIdsInOrder(events: AgentStoredEvent[]): AgentStoredEvent[] {
  if (events.length <= 1) {
    return events;
  }
  const seen = new Set<string>();
  const out: AgentStoredEvent[] = [];
  for (const e of events) {
    if (seen.has(e.eventId)) {
      continue;
    }
    seen.add(e.eventId);
    out.push(e);
  }
  return out;
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
  return enrichEventsWithDerivedEditPreview(dropDuplicateEventIdsInOrder(events));
}

export async function readConversationEventPrefix(
  workspaceId: string,
  conversationId: string,
  limit = 32
): Promise<AgentStoredEvent[]> {
  const storage = await getStorage();
  const rec = await storage.getAgentConversation(conversationId);
  if (!rec || rec.workspaceId !== workspaceId) {
    return [];
  }
  const events = await storage.readAgentEvents({
    conversationId,
    afterSeq: 0,
    limit,
  });
  return enrichEventsWithDerivedEditPreview(dropDuplicateEventIdsInOrder(events));
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

export async function readConversationEventsUpToMessage(
  workspaceId: string,
  conversationId: string,
  upToMessageId: string,
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
  const targetSeq = events.find(
    (e) => e.kind === "user_message" && e.messageId === upToMessageId
  )?.seq;
  if (targetSeq == null) {
    const turns = messageLimit * 2 + 10;
    const eventsLimit = messageLimit * 50 + 100;
    return enrichEventsWithDerivedEditPreview(
      takeLastTurnWindow(events, turns, eventsLimit)
    );
  }
  const sliced = events.filter((e) => e.seq <= targetSeq);
  const turns = messageLimit * 2 + 10;
  const eventsLimit = messageLimit * 50 + 100;
  return enrichEventsWithDerivedEditPreview(
    takeLastTurnWindow(sliced, turns, eventsLimit)
  );
}

export async function readConversationEventsBeforeMessage(
  workspaceId: string,
  conversationId: string,
  beforeMessageId: string,
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
  const targetSeq = events.find(
    (e) => e.kind === "user_message" && e.messageId === beforeMessageId
  )?.seq;
  if (targetSeq == null) {
    throw new Error("Could not find the selected user message to redo.");
  }
  const sliced = events.filter((e) => e.seq < targetSeq);
  const turns = messageLimit * 2 + 10;
  const eventsLimit = messageLimit * 50 + 100;
  return enrichEventsWithDerivedEditPreview(
    takeLastTurnWindow(sliced, turns, eventsLimit)
  );
}

export async function readConversationSnapshot(
  workspaceId: string,
  conversationId: string,
  preloadedConversation?: AgentConversationRecord | null
): Promise<AgentConversationSnapshot | null> {
  const conversation =
    preloadedConversation !== undefined && preloadedConversation !== null
      ? preloadedConversation.workspaceId === workspaceId
        ? preloadedConversation
        : null
      : await readConversationRecord(workspaceId, conversationId);
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
      conversation,
    });
    if (!head) {
      return { conversation, events: [] };
    }
    return {
      conversation: head.conversation,
      events: head.events,
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
  options?: {
    limitTurns?: number;
    limitEvents?: number;
    /** When already loaded (e.g. by `getConversationSnapshotHead`), avoids a second metadata fetch. */
    conversation?: AgentConversationRecord | null;
  }
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

  const conversation =
    options?.conversation !== undefined && options.conversation != null
      ? options.conversation.workspaceId === workspaceId
        ? options.conversation
        : null
      : await readConversationRecord(workspaceId, conversationId);
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

  const tailReadLimit = Math.min(
    PG_READ_HEAD_PREFIX_CAP,
    Math.max(limitEvents, Math.min(limitEvents * 4, 8_000))
  );
  const raw = await storage.readRecentAgentEvents(conversationId, tailReadLimit);
  let slice = takeLastTurnWindow(raw, limitTurns, limitEvents);
  slice = expandSliceToMinUserTurns(raw, slice, MIN_USER_TURNS_IN_INITIAL_HEAD);
  const events = await enrichEventsWithDerivedEditPreview(slice);
  const minSeq = raw[0]?.seq ?? 0;
  const sliceOldest = slice[0]?.seq ?? 0;
  const hasOlder = sliceOldest > minSeq || minSeq > 1;
  const result: AgentConversationSnapshotHead = {
    conversation,
    events,
    window: {
      oldestSeq: events[0]?.seq ?? raw[0]?.seq ?? 0,
      newestSeq: events[events.length - 1]?.seq ?? raw[raw.length - 1]?.seq ?? 0,
      hasOlder,
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
    if (countUserMessageEvents(prefix) < PAGINATION_MIN_USER_TURNS) {
      const full = trimToTurnStart(prefix);
      const ev = await enrichEventsWithDerivedEditPreview(full);
      return {
        events: ev,
        window: {
          oldestSeq: ev[0]?.seq ?? 0,
          newestSeq: ev[ev.length - 1]?.seq ?? 0,
          hasOlder: false,
        },
      };
    }
    let slice = takeLastTurnWindow(prefix, limitTurns, limitEvents);
    slice = expandSliceToMinUserTurns(prefix, slice, MIN_USER_TURNS_IN_INITIAL_HEAD);
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
    const touchListRank = !isAgentConversationRankNeutralDelta(current, next);
    const normalized: AgentConversationRecord = {
      ...next,
      updatedAt: touchListRank ? Math.max(current.updatedAt + 1, Date.now()) : current.updatedAt,
    };
    await (await getStorage()).upsertAgentConversation(normalized);
    await invalidateConversationCaches(workspaceId, conversationId);
    scheduleAgentCacheRefill(workspaceId, conversationId);
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
