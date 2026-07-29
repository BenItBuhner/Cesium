import { randomUUID } from "node:crypto";
import type { WorkspaceRecord } from "../../workspace-registry.js";
import { AGENT_BACKENDS } from "../providers.js";
import {
  appendConversationEvents,
  createConversationId,
  deleteConversationEvents,
  listWorkspaceConversationRecords,
  readConversationEvents,
  saveConversationRecord,
  updateConversationRecord,
} from "../session-store.js";
import type {
  AgentBackendId,
  AgentConversationRecord,
  AgentEventInput,
} from "../types.js";
import { getImportSourceForBackend } from "./registry.js";
import type { HarnessImportSource, HarnessSessionTranscript } from "./types.js";

export type HarnessImportResult = {
  conversationId: string;
  /** True when a new conversation was created; false when an existing import was re-synced. */
  created: boolean;
  eventCount: number;
  /** Native provider session id now carried by the conversation. */
  providerSessionId: string | null;
  title: string;
  backendId: AgentBackendId;
};

/**
 * Imported transcripts contain no runtime `status` events, so without help
 * every turn would render a perpetual "Working" indicator in the thread. Close
 * each completed turn with a terminal idle status, exactly like a live
 * provider does at end-of-turn.
 */
function settleImportedTurns(
  events: AgentEventInput[],
  conversationId: string
): AgentEventInput[] {
  const out: AgentEventInput[] = [];
  let openTurn = false;
  let lastCreatedAt = 0;
  const idleEvent = (): AgentEventInput => ({
    eventId: randomUUID(),
    conversationId,
    kind: "status",
    status: "idle",
    createdAt: lastCreatedAt + 1,
  });
  for (const event of events) {
    if (event.kind === "user_message" && openTurn) {
      out.push(idleEvent());
    }
    out.push(event);
    if (event.kind === "user_message") {
      openTurn = true;
    } else if (
      event.kind === "status" &&
      (event.status === "idle" || event.status === "failed" || event.status === "cancelled")
    ) {
      openTurn = false;
    }
    if (typeof event.createdAt === "number") {
      lastCreatedAt = Math.max(lastCreatedAt, event.createdAt);
    }
  }
  if (openTurn) {
    out.push(idleEvent());
  }
  return out;
}

/** Find the Cesium conversation that already represents this harness session. */
export async function findImportedConversation(
  workspaceId: string,
  backendId: AgentBackendId,
  externalSessionId: string
): Promise<AgentConversationRecord | null> {
  const records = await listWorkspaceConversationRecords(workspaceId);
  return (
    records.find(
      (record) =>
        record.origin?.kind === "import" &&
        record.origin.backendId === backendId &&
        record.origin.externalSessionId === externalSessionId
    ) ?? null
  );
}

function buildImportedRecord(input: {
  workspace: WorkspaceRecord;
  backendId: AgentBackendId;
  transcript: HarnessSessionTranscript;
  providerSessionId: string | null;
  conversationId: string;
}): AgentConversationRecord {
  const backend = AGENT_BACKENDS[input.backendId];
  const now = Date.now();
  const createdAt = input.transcript.summary.createdAt ?? now;
  return {
    schemaVersion: 1,
    id: input.conversationId,
    workspaceId: input.workspace.id,
    title: input.transcript.summary.title,
    createdAt,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: input.backendId,
      mode: backend?.defaultMode ?? "agent",
      // Prefer the model the source session was actually running so native
      // continuation uses the exact same model, not the backend default.
      modelId: input.transcript.summary.modelId ?? backend?.defaultModelId ?? "auto",
      modelName:
        input.transcript.summary.modelName ??
        input.transcript.summary.modelId ??
        backend?.defaultModelName ??
        "Auto",
    },
    providerSessionId: input.providerSessionId,
    configOptions: [],
    capabilities:
      backend?.capabilities ??
      ({
        supportsLoadSession: true,
        supportsModeSelection: false,
        supportsModelSelection: false,
        supportsSlashCommands: false,
        supportsPermissions: false,
        supportsToolCalls: true,
        supportsStructuredPlans: false,
        supportsTodos: false,
        supportsSessionResume: true,
        supportsPromptImages: false,
        supportsInlineReasoning: true,
        supportsCompletionRetry: false,
      } satisfies AgentConversationRecord["capabilities"]),
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: Boolean(backend?.experimental),
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    origin: {
      kind: "import",
      backendId: input.backendId,
      externalSessionId: input.transcript.summary.id,
      sourcePath: input.transcript.summary.sourcePath,
      ...(input.transcript.summary.cwd ? { sourceCwd: input.transcript.summary.cwd } : {}),
      ...(input.transcript.startedAt ? { sourceStartedAt: input.transcript.startedAt } : {}),
      sourceUpdatedAt: input.transcript.summary.updatedAt ?? null,
      importedAt: now,
    },
  };
}

const lastAutoSyncCheck = new Map<string, number>();
const AUTO_SYNC_MIN_INTERVAL_MS = 5_000;

/**
 * Keep an imported conversation transparently up to date with its harness's
 * native storage. Called when a conversation is opened: if the user continued
 * the session directly in the source CLI since the last sync, the new turns
 * are pulled in automatically — no manual "re-sync" step exists or is needed.
 *
 * Never runs while the conversation is active in Cesium, after a handoff to a
 * different backend, or when the source has nothing newer than what Cesium
 * itself last wrote (so Cesium-side continuations are never clobbered).
 */
export async function maybeAutoSyncImportedConversation(
  workspace: WorkspaceRecord,
  record: AgentConversationRecord,
  options?: { ignoreThrottle?: boolean }
): Promise<boolean> {
  const origin = record.origin;
  if (origin?.kind !== "import") {
    return false;
  }
  if (record.config.backendId !== origin.backendId) {
    return false;
  }
  if (record.status !== "idle" && record.status !== "failed") {
    return false;
  }
  const now = Date.now();
  if (!options?.ignoreThrottle) {
    const lastCheck = lastAutoSyncCheck.get(record.id) ?? 0;
    if (now - lastCheck < AUTO_SYNC_MIN_INTERVAL_MS) {
      return false;
    }
  }
  lastAutoSyncCheck.set(record.id, now);
  const source = getImportSourceForBackend(origin.backendId);
  if (!source) {
    return false;
  }
  try {
    const transcript = await source.readSession(origin.externalSessionId);
    const sourceUpdatedAt = transcript.summary.updatedAt;
    if (sourceUpdatedAt == null) {
      return false;
    }
    if (origin.sourceUpdatedAt != null && sourceUpdatedAt <= origin.sourceUpdatedAt) {
      return false;
    }
    if (sourceUpdatedAt <= record.updatedAt) {
      // The newest source content is something Cesium itself streamed live —
      // the conversation already reflects it.
      return false;
    }
    await importHarnessSession({
      workspace,
      backendId: origin.backendId,
      externalSessionId: origin.externalSessionId,
    });
    return true;
  } catch (error) {
    console.warn(
      `[agent-import] auto-sync failed for conversation ${record.id}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Import (or re-sync) a harness-native session into a Cesium conversation.
 *
 * Identity: the harness session id is preserved verbatim — it becomes both the
 * conversation's `origin.externalSessionId` and its `providerSessionId`, so
 * the next prompt natively resumes the exact same session in the original
 * harness (loadSession path), never a quote/transcript replay.
 *
 * Idempotency: importing the same session again modifies the previously
 * imported conversation in place (events are replaced with the current source
 * transcript) instead of creating a duplicate.
 */
export async function importHarnessSession(input: {
  workspace: WorkspaceRecord;
  backendId: AgentBackendId;
  externalSessionId: string;
}): Promise<HarnessImportResult> {
  const source: HarnessImportSource | null = getImportSourceForBackend(input.backendId);
  if (!source) {
    throw new Error(`Backend ${input.backendId} does not support conversation import.`);
  }
  const transcript = await source.readSession(input.externalSessionId);
  if (transcript.summary.id !== input.externalSessionId) {
    // Reader resolved an alias/short id — normalize to the canonical native id.
    input = { ...input, externalSessionId: transcript.summary.id };
  }

  let providerSessionId: string | null = input.externalSessionId;
  try {
    providerSessionId = source.prepareNativeResume
      ? await source.prepareNativeResume(input.externalSessionId, input.workspace.root)
      : input.externalSessionId;
  } catch (error) {
    console.warn(
      `[agent-import] native resume preparation failed for ${input.externalSessionId}:`,
      error instanceof Error ? error.message : error
    );
  }

  const existing = await findImportedConversation(
    input.workspace.id,
    input.backendId,
    input.externalSessionId
  );

  if (existing) {
    const staleEvents = await readConversationEvents(input.workspace.id, existing.id);
    if (staleEvents.length > 0) {
      await deleteConversationEvents(
        input.workspace.id,
        existing.id,
        staleEvents.map((event) => event.eventId)
      );
    }
    const events: AgentEventInput[] = settleImportedTurns(
      transcript.events.map((event) => ({ ...event, conversationId: existing.id })),
      existing.id
    );
    await appendConversationEvents(input.workspace.id, existing.id, events);
    const updated = await updateConversationRecord(input.workspace.id, existing.id, (current) => ({
      ...current,
      title: transcript.summary.title,
      // Adopt the source model only while the conversation still runs on the
      // backend default — a model the user picked in Cesium is never clobbered.
      config:
        transcript.summary.modelId &&
        (!current.config.modelId || current.config.modelId === "auto")
          ? {
              ...current.config,
              modelId: transcript.summary.modelId,
              modelName: transcript.summary.modelName ?? transcript.summary.modelId,
            }
          : current.config,
      providerSessionId,
      status: "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      origin: {
        kind: "import",
        backendId: input.backendId,
        externalSessionId: input.externalSessionId,
        sourcePath: transcript.summary.sourcePath,
        ...(transcript.summary.cwd ? { sourceCwd: transcript.summary.cwd } : {}),
        ...(transcript.startedAt ? { sourceStartedAt: transcript.startedAt } : {}),
        sourceUpdatedAt: transcript.summary.updatedAt ?? null,
        importedAt: Date.now(),
      },
    }));
    return {
      conversationId: updated.id,
      created: false,
      eventCount: events.length,
      providerSessionId,
      title: updated.title,
      backendId: input.backendId,
    };
  }

  const conversationId = createConversationId();
  const record = buildImportedRecord({
    workspace: input.workspace,
    backendId: input.backendId,
    transcript,
    providerSessionId,
    conversationId,
  });
  await saveConversationRecord(record);
  const events: AgentEventInput[] = settleImportedTurns(
    transcript.events.map((event) => ({ ...event, conversationId })),
    conversationId
  );
  await appendConversationEvents(input.workspace.id, conversationId, events);

  return {
    conversationId,
    created: true,
    eventCount: events.length,
    providerSessionId,
    title: record.title,
    backendId: input.backendId,
  };
}
