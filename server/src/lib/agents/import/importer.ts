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
      modelId: backend?.defaultModelId ?? "auto",
      modelName: backend?.defaultModelName ?? "Auto",
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
      importedAt: now,
    },
  };
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
    const events: AgentEventInput[] = transcript.events.map((event) => ({
      ...event,
      conversationId: existing.id,
    }));
    await appendConversationEvents(input.workspace.id, existing.id, events);
    const updated = await updateConversationRecord(input.workspace.id, existing.id, (current) => ({
      ...current,
      title: transcript.summary.title,
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
  const events: AgentEventInput[] = transcript.events.map((event) => ({
    ...event,
    conversationId,
  }));
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
