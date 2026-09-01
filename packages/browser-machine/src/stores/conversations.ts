/**
 * Conversation records + append-only event log, mirroring the engine's
 * session-store contracts (seq assignment, snapshot heads, history pages,
 * live store-event fan-out used by the agent WebSocket).
 */
import type {
  AgentConversationEventWindow,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentStoredEvent,
} from "@cesium/core";
import { EVENTS_STORE, idbBulk, idbDeleteRange, idbGetRange } from "../idb";
import { readDoc, writeDoc, deleteDoc } from "./kv-docs";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AgentEventInput = DistributiveOmit<AgentStoredEvent, "seq" | "createdAt"> & {
  createdAt?: number;
};

export type AgentStoreEvent =
  | { type: "conversation"; conversation: AgentConversationRecord }
  | { type: "conversation_deleted"; workspaceId: string; conversationId: string }
  | {
      type: "event";
      workspaceId: string;
      conversationId: string;
      event: AgentStoredEvent;
    };

type StoredEventRow = {
  key: string;
  conversationId: string;
  seq: number;
  event: AgentStoredEvent;
};

// Mirrors the engine's session-store defaults (DEFAULT_PAGE_TURNS/EVENTS_CAP).
const DEFAULT_HEAD_TURNS = 96;
const DEFAULT_HEAD_EVENTS = 2000;

function padSeq(seq: number): string {
  return String(seq).padStart(12, "0");
}

function eventKey(conversationId: string, seq: number): string {
  return `${conversationId}\u0000${padSeq(seq)}`;
}

function conversationRange(conversationId: string): IDBKeyRange {
  return IDBKeyRange.bound(
    `${conversationId}\u0000`,
    `${conversationId}\u0000\uffff`,
    false,
    false
  );
}

function indexKey(workspaceId: string): string {
  return `conversations-index:${workspaceId}`;
}

function recordKey(workspaceId: string, conversationId: string): string {
  return `conversation:${workspaceId}:${conversationId}`;
}

export function newEventId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Count "turns" (user_message boundaries) from the tail, like the engine's head reads. */
function sliceTailByTurns(
  events: AgentStoredEvent[],
  limitTurns: number,
  limitEvents: number
): AgentStoredEvent[] {
  if (events.length === 0) return [];
  let turns = 0;
  let startIndex = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.kind === "user_message" && !event.hidden) {
      turns += 1;
      if (turns >= limitTurns) {
        startIndex = i;
        break;
      }
    }
  }
  const byTurns = events.slice(startIndex);
  return byTurns.length > limitEvents ? byTurns.slice(byTurns.length - limitEvents) : byTurns;
}

export class ConversationStore {
  private readonly records = new Map<string, AgentConversationRecord>();
  private readonly eventsCache = new Map<string, AgentStoredEvent[]>();
  private readonly hydratedWorkspaces = new Set<string>();
  private readonly listeners = new Set<(event: AgentStoreEvent) => void>();

  subscribe(listener: (event: AgentStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentStoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("[browser-machine] conversation store listener failed:", error);
      }
    }
  }

  private async hydrateWorkspace(workspaceId: string): Promise<void> {
    if (this.hydratedWorkspaces.has(workspaceId)) return;
    const ids = (await readDoc<string[]>(indexKey(workspaceId))) ?? [];
    for (const conversationId of ids) {
      if (this.records.has(conversationId)) continue;
      const record = await readDoc<AgentConversationRecord>(
        recordKey(workspaceId, conversationId)
      );
      if (record) {
        this.records.set(conversationId, record);
      }
    }
    this.hydratedWorkspaces.add(workspaceId);
  }

  async listForWorkspace(workspaceId: string): Promise<AgentConversationRecord[]> {
    await this.hydrateWorkspace(workspaceId);
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(
    workspaceId: string,
    conversationId: string
  ): Promise<AgentConversationRecord | null> {
    await this.hydrateWorkspace(workspaceId);
    const record = this.records.get(conversationId);
    return record && record.workspaceId === workspaceId ? record : null;
  }

  async put(record: AgentConversationRecord, options?: { silent?: boolean }): Promise<void> {
    this.records.set(record.id, record);
    await writeDoc(recordKey(record.workspaceId, record.id), record);
    const ids = (await readDoc<string[]>(indexKey(record.workspaceId))) ?? [];
    if (!ids.includes(record.id)) {
      await writeDoc(indexKey(record.workspaceId), [record.id, ...ids]);
    }
    if (!options?.silent) {
      this.emit({ type: "conversation", conversation: record });
    }
  }

  async update(
    workspaceId: string,
    conversationId: string,
    patch:
      | Partial<AgentConversationRecord>
      | ((current: AgentConversationRecord) => AgentConversationRecord)
  ): Promise<AgentConversationRecord> {
    const current = await this.get(workspaceId, conversationId);
    if (!current) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const next =
      typeof patch === "function"
        ? patch(current)
        : { ...current, ...patch, updatedAt: Date.now() };
    await this.put(next);
    return next;
  }

  async delete(workspaceId: string, conversationId: string): Promise<void> {
    this.records.delete(conversationId);
    this.eventsCache.delete(conversationId);
    await deleteDoc(recordKey(workspaceId, conversationId));
    const ids = (await readDoc<string[]>(indexKey(workspaceId))) ?? [];
    await writeDoc(
      indexKey(workspaceId),
      ids.filter((id) => id !== conversationId)
    );
    await idbDeleteRange(EVENTS_STORE, conversationRange(conversationId));
    this.emit({ type: "conversation_deleted", workspaceId, conversationId });
  }

  async readEvents(conversationId: string): Promise<AgentStoredEvent[]> {
    const cached = this.eventsCache.get(conversationId);
    if (cached) return cached;
    const rows = await idbGetRange<StoredEventRow>(
      EVENTS_STORE,
      conversationRange(conversationId)
    );
    const events = rows
      .sort((a, b) => a.seq - b.seq)
      .map((row) => row.event);
    this.eventsCache.set(conversationId, events);
    return events;
  }

  /** Append events, assigning sequential `seq` values, and fan out live frames. */
  async appendEvents(
    workspaceId: string,
    conversationId: string,
    inputs: AgentEventInput[]
  ): Promise<AgentStoredEvent[]> {
    const record = await this.get(workspaceId, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const events = await this.readEvents(conversationId);
    let seq = record.lastEventSeq;
    const appended: AgentStoredEvent[] = [];
    const rows: StoredEventRow[] = [];
    for (const input of inputs) {
      seq += 1;
      const event = {
        ...input,
        seq,
        createdAt: input.createdAt ?? Date.now(),
      } as AgentStoredEvent;
      appended.push(event);
      events.push(event);
      rows.push({
        key: eventKey(conversationId, seq),
        conversationId,
        seq,
        event,
      });
    }
    await idbBulk(EVENTS_STORE, rows, []);
    const updated = await this.update(workspaceId, conversationId, (current) => ({
      ...current,
      lastEventSeq: seq,
      updatedAt: Date.now(),
    }));
    void updated;
    for (const event of appended) {
      this.emit({ type: "event", workspaceId, conversationId, event });
    }
    return appended;
  }

  async readSnapshot(
    workspaceId: string,
    conversationId: string
  ): Promise<AgentConversationSnapshot | null> {
    const record = await this.get(workspaceId, conversationId);
    if (!record) return null;
    const events = await this.readEvents(conversationId);
    return { conversation: record, events: [...events] };
  }

  async readSnapshotHead(
    workspaceId: string,
    conversationId: string,
    options?: { limitTurns?: number; limitEvents?: number }
  ): Promise<AgentConversationSnapshotHead | null> {
    const record = await this.get(workspaceId, conversationId);
    if (!record) return null;
    const events = await this.readEvents(conversationId);
    const tail = sliceTailByTurns(
      events,
      options?.limitTurns ?? DEFAULT_HEAD_TURNS,
      options?.limitEvents ?? DEFAULT_HEAD_EVENTS
    );
    const window: AgentConversationEventWindow = {
      oldestSeq: tail[0]?.seq ?? 0,
      newestSeq: tail[tail.length - 1]?.seq ?? record.lastEventSeq,
      hasOlder: tail.length > 0 ? (tail[0]?.seq ?? 1) > (events[0]?.seq ?? 1) : false,
    };
    return { conversation: record, events: tail, window };
  }

  async readHistoryPage(
    conversationId: string,
    beforeSeq: number,
    options?: { limitTurns?: number; limitEvents?: number }
  ): Promise<{ events: AgentStoredEvent[]; window: AgentConversationEventWindow } | null> {
    const events = await this.readEvents(conversationId);
    const older = events.filter((event) => event.seq < beforeSeq);
    const page = sliceTailByTurns(
      older,
      options?.limitTurns ?? DEFAULT_HEAD_TURNS,
      options?.limitEvents ?? DEFAULT_HEAD_EVENTS
    );
    const window: AgentConversationEventWindow = {
      oldestSeq: page[0]?.seq ?? 0,
      newestSeq: page[page.length - 1]?.seq ?? 0,
      hasOlder: page.length > 0 ? (page[0]?.seq ?? 1) > (older[0]?.seq ?? 1) : false,
    };
    return { events: page, window };
  }

  async readEventsSince(
    conversationId: string,
    sinceSeq: number
  ): Promise<AgentStoredEvent[]> {
    const events = await this.readEvents(conversationId);
    return events.filter((event) => event.seq > sinceSeq);
  }
}
