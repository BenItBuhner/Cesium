import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  appendConversationEvents,
  createConversationId,
  deleteConversationEvents,
  listWorkspaceConversationRecords,
  readConversationEvents,
  readConversationRecord,
  saveConversationRecord,
  updateConversationRecord,
} from "./session-store.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentStoredEvent,
} from "./types.js";

/**
 * Portable conversation snapshots for Cesium Cloud Context.
 *
 * Export: sanitize a conversation into a `{ record, events }` pair that is
 * safe to store off-engine (no pending runtime state, no queued prompts) and
 * small enough for a cloud document.
 *
 * Materialize: re-create the conversation on any engine. The Cesium harness
 * rebuilds prompt context from the event log, so materialized conversations
 * continue seamlessly; external harnesses start a fresh provider session on
 * the next prompt (their native session storage does not travel).
 */

/** Keep transcripts under cloud document limits (Convex docs cap ~1MiB). */
const MAX_EVENTS_JSON_CHARS = 850_000;

export type ConversationSnapshotExport = {
  snapshotKey: string;
  title: string;
  backendId: string;
  modelId: string | null;
  modelName: string | null;
  messageCount: number;
  sourceUpdatedAt: number;
  recordJson: string;
  eventsJson: string;
  truncated: boolean;
};

function countMessages(events: AgentStoredEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.kind === "user_message" && !event.hidden) {
      count += 1;
    } else if (event.kind === "assistant_message_end") {
      count += 1;
    }
  }
  return count;
}

function sanitizeRecordForSnapshot(
  record: AgentConversationRecord
): Omit<
  AgentConversationRecord,
  "id" | "workspaceId" | "lastEventSeq" | "lastReadSeq"
> {
  const rest = { ...record } as Partial<AgentConversationRecord>;
  delete rest.id;
  delete rest.workspaceId;
  delete rest.lastEventSeq;
  delete rest.lastReadSeq;
  return {
    ...(rest as Omit<
      AgentConversationRecord,
      "id" | "workspaceId" | "lastEventSeq" | "lastReadSeq"
    >),
    status: "idle",
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    queuedPrompts: [],
    pendingRelocation: null,
    providerSessionId: null,
  };
}

export async function exportConversationSnapshot(
  workspace: WorkspaceRecord,
  conversationId: string
): Promise<ConversationSnapshotExport | null> {
  const record = await readConversationRecord(workspace.id, conversationId);
  if (!record) {
    return null;
  }
  const events = await readConversationEvents(workspace.id, conversationId);

  // Strip seq (reassigned on materialize) and oversized raw payloads.
  const portable: AgentEventInput[] = events.map((event) => {
    const rest = { ...event } as Partial<AgentStoredEvent> & { raw?: unknown };
    delete rest.seq;
    delete rest.raw;
    return rest as AgentEventInput;
  });

  // Drop oldest events until the transcript fits a cloud document.
  let kept = portable;
  let eventsJson = JSON.stringify(kept);
  let truncated = false;
  while (eventsJson.length > MAX_EVENTS_JSON_CHARS && kept.length > 1) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 10)));
    eventsJson = JSON.stringify(kept);
    truncated = true;
  }

  return {
    snapshotKey: record.id,
    title: record.title,
    backendId: record.config.backendId,
    modelId: record.config.modelId ?? null,
    modelName: record.config.modelName ?? null,
    messageCount: countMessages(events),
    sourceUpdatedAt: record.updatedAt,
    recordJson: JSON.stringify(sanitizeRecordForSnapshot(record)),
    eventsJson,
    truncated,
  };
}

export type MaterializeCloudSnapshotInput = {
  workspace: WorkspaceRecord;
  snapshotKey: string;
  recordJson: string;
  eventsJson: string;
  sourceServerName?: string | null;
  sourceWorkspaceName?: string | null;
  sourceUpdatedAt?: number | null;
};

export type MaterializeCloudSnapshotResult = {
  conversationId: string;
  created: boolean;
  eventCount: number;
  title: string;
};

async function findMaterializedConversation(
  workspaceId: string,
  snapshotKey: string
): Promise<AgentConversationRecord | null> {
  const records = await listWorkspaceConversationRecords(workspaceId);
  return (
    records.find(
      (record) =>
        record.origin?.kind === "cloud-snapshot" &&
        record.origin.snapshotKey === snapshotKey
    ) ?? null
  );
}

export async function materializeCloudSnapshot(
  input: MaterializeCloudSnapshotInput
): Promise<MaterializeCloudSnapshotResult> {
  const parsedRecord = JSON.parse(input.recordJson) as Omit<
    AgentConversationRecord,
    "id" | "workspaceId" | "lastEventSeq" | "lastReadSeq"
  >;
  const parsedEvents = JSON.parse(input.eventsJson) as AgentEventInput[];
  if (!parsedRecord || typeof parsedRecord !== "object" || !parsedRecord.config) {
    throw new Error("Snapshot record payload is malformed.");
  }
  if (!Array.isArray(parsedEvents)) {
    throw new Error("Snapshot events payload is malformed.");
  }

  const now = Date.now();
  const origin: AgentConversationRecord["origin"] = {
    kind: "cloud-snapshot",
    snapshotKey: input.snapshotKey,
    sourceServerName: input.sourceServerName ?? null,
    sourceWorkspaceName: input.sourceWorkspaceName ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    importedAt: now,
  };

  const existing = await findMaterializedConversation(
    input.workspace.id,
    input.snapshotKey
  );

  if (existing) {
    const staleEvents = await readConversationEvents(
      input.workspace.id,
      existing.id
    );
    if (staleEvents.length > 0) {
      await deleteConversationEvents(
        input.workspace.id,
        existing.id,
        staleEvents.map((event) => event.eventId)
      );
    }
    const events = parsedEvents.map((event) => ({
      ...event,
      conversationId: existing.id,
    }));
    await appendConversationEvents(input.workspace.id, existing.id, events);
    const updated = await updateConversationRecord(
      input.workspace.id,
      existing.id,
      (current) => ({
        ...current,
        title: parsedRecord.title ?? current.title,
        config: parsedRecord.config ?? current.config,
        status: "idle",
        pendingPermission: null,
        pendingQuestion: null,
        lastError: null,
        origin,
      })
    );
    return {
      conversationId: updated.id,
      created: false,
      eventCount: events.length,
      title: updated.title,
    };
  }

  const conversationId = createConversationId();
  const record: AgentConversationRecord = {
    ...parsedRecord,
    schemaVersion: 1,
    id: conversationId,
    workspaceId: input.workspace.id,
    lastEventSeq: 0,
    lastReadSeq: 0,
    createdAt: parsedRecord.createdAt ?? now,
    updatedAt: now,
    status: "idle",
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    providerSessionId: null,
    queuedPrompts: [],
    origin,
  };
  await saveConversationRecord(record);
  const events = parsedEvents.map((event) => ({
    ...event,
    conversationId,
  }));
  await appendConversationEvents(input.workspace.id, conversationId, events);
  return {
    conversationId,
    created: true,
    eventCount: events.length,
    title: record.title,
  };
}
