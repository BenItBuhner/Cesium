import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
  AgentConversationStatus,
  AgentPlanEntry,
  AgentStoredEvent,
} from "./protocol";
import {
  isCompressingContextStatusDetail,
  isTakingLongerStatusDetail,
} from "./agent-completion-error";

/** Agent is actively working or waiting on user mid-turn (not paused). */
export function isAgentConversationBusy(status: AgentConversationStatus): boolean {
  return (
    status === "running" ||
    status === "pause_requested" ||
    status === "pausing" ||
    status === "awaiting_permission" ||
    status === "awaiting_question"
  );
}

/** Cesium pause drain / paused — turn still open but model loop is halted. */
export function isAgentConversationPaused(status: AgentConversationStatus): boolean {
  return status === "paused";
}

/** Composer shows Cesium pause/stop pill (running drain or paused mid-turn). */
export function isAgentCesiumTurnActive(status: AgentConversationStatus): boolean {
  return isAgentConversationBusy(status) || isAgentConversationPaused(status);
}

export function isAgentCesiumPauseDraining(status: AgentConversationStatus): boolean {
  return status === "pause_requested" || status === "pausing";
}

export type GoalProgressSnapshotStatus = {
  progressPercent: number;
  headline: string | null;
  summary: string | null;
  updatedAt: number;
  toolCallId: string;
};

export type GoalProgressStatus = GoalProgressSnapshotStatus & {
  history: GoalProgressSnapshotStatus[];
  /** Set when the latest Goal progress has since been marked complete. */
  completedAt?: number | null;
  /** Completed running time for this goal, excluding the currently active interval. */
  runtimeSeconds?: number;
  /** Start time for the currently active running interval, when the agent is running this goal now. */
  runtimeActiveSince?: number | null;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const WORKFLOW_SNAPSHOT_STATUSES = new Set([
  "pending",
  "compiling",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

const WORKFLOW_SNAPSHOT_AGENT_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cached",
  "skipped",
]);

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function extractWorkflowRunSnapshotFromRaw(rawValue: unknown): WorkflowRunSnapshot | undefined {
  const raw = objectRecord(rawValue);
  const candidate = objectRecord(raw?.workflowRun);
  if (!candidate) {
    return undefined;
  }
  if (
    typeof candidate.runId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.status !== "string" ||
    !WORKFLOW_SNAPSHOT_STATUSES.has(candidate.status) ||
    !(typeof candidate.currentPhase === "string" || candidate.currentPhase === null) ||
    !isNumberOrNull(candidate.tokenBudget) ||
    typeof candidate.tokensUsed !== "number" ||
    typeof candidate.maxAgents !== "number" ||
    typeof candidate.agentsUsed !== "number" ||
    typeof candidate.maxConcurrent !== "number" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.updatedAt !== "number" ||
    !isNumberOrNull(candidate.completedAt) ||
    typeof candidate.scriptPath !== "string" ||
    !Array.isArray(candidate.recentLogs) ||
    !(typeof candidate.returnPreview === "string" || candidate.returnPreview === null) ||
    !(typeof candidate.errorPreview === "string" || candidate.errorPreview === null) ||
    !Array.isArray(candidate.phases) ||
    !Array.isArray(candidate.agents)
  ) {
    return undefined;
  }
  const logs = candidate.recentLogs;
  const phases = candidate.phases;
  const agents = candidate.agents;
  if (
    !logs.every((entry) => {
      const log = objectRecord(entry);
      return (
        log &&
        typeof log.at === "number" &&
        typeof log.message === "string" &&
        (typeof log.phase === "string" || log.phase === null || log.phase === undefined)
      );
    }) ||
    !phases.every((entry) => {
      const phase = objectRecord(entry);
      return (
        phase &&
        typeof phase.title === "string" &&
        (typeof phase.detail === "string" || phase.detail === undefined) &&
        (typeof phase.model === "string" || phase.model === undefined)
      );
    }) ||
    !agents.every((entry) => {
      const agent = objectRecord(entry);
      return (
        agent &&
        typeof agent.id === "string" &&
        typeof agent.label === "string" &&
        (typeof agent.phase === "string" || agent.phase === null) &&
        typeof agent.status === "string" &&
        WORKFLOW_SNAPSHOT_AGENT_STATUSES.has(agent.status) &&
        typeof agent.tokensUsed === "number" &&
        isNumberOrNull(agent.startedAt) &&
        isNumberOrNull(agent.completedAt) &&
        (typeof agent.promptPreview === "string" || agent.promptPreview === undefined) &&
        (typeof agent.resultPreview === "string" || agent.resultPreview === undefined) &&
        (typeof agent.errorPreview === "string" || agent.errorPreview === undefined)
      );
    })
  ) {
    return undefined;
  }
  return {
    ...(candidate as unknown as WorkflowRunSnapshot),
    agentRecordsTotal:
      typeof candidate.agentRecordsTotal === "number"
        ? candidate.agentRecordsTotal
        : agents.length,
    agentsTruncated:
      typeof candidate.agentsTruncated === "boolean"
        ? candidate.agentsTruncated
        : false,
  };
}

function workflowSnapshotWorkedStatus(
  status: WorkflowRunSnapshot["status"]
): Extract<WorkedSessionEntry, { kind: "tool" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

function workflowSnapshotDetail(snapshot: WorkflowRunSnapshot): string {
  const phase = snapshot.currentPhase ? ` - ${snapshot.currentPhase}` : "";
  const agents = ` - ${snapshot.agentsUsed}/${snapshot.maxAgents} agents`;
  const tokens =
    snapshot.tokenBudget != null
      ? ` - ${snapshot.tokensUsed}/${snapshot.tokenBudget} tokens`
      : ` - ${snapshot.tokensUsed} tokens`;
  const error = snapshot.errorPreview ? ` - ${snapshot.errorPreview.slice(0, 240)}` : "";
  return `${snapshot.status}${phase}${agents}${tokens}${error}`;
}

function normalizeGoalToolName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.startsWith("goal_")) {
    return trimmed;
  }
  if (trimmed.startsWith("burn_goal_")) {
    return `goal_${trimmed.slice("burn_goal_".length)}`;
  }
  return null;
}

function goalToolNameFromEvent(event: AgentStoredEvent): string | null {
  if (event.kind !== "tool_call_update" || !event.raw) {
    return null;
  }
  const raw = objectRecord(event.raw);
  const request = objectRecord(raw?.request);
  const name = typeof request?.name === "string" ? request.name.trim() : "";
  return normalizeGoalToolName(name);
}

function firstGoalToolAt(events: readonly AgentStoredEvent[]): number | null {
  for (const event of events) {
    if (goalToolNameFromEvent(event)) {
      return event.createdAt;
    }
  }
  return null;
}

function isGoalRuntimeRunningStatus(status: AgentConversationStatus | null | undefined): boolean {
  return status === "running";
}

function goalRuntimeStatus(
  events: readonly AgentStoredEvent[],
  conversationStatus: AgentConversationStatus | null | undefined
): Pick<GoalProgressStatus, "runtimeSeconds" | "runtimeActiveSince"> | null {
  if (!conversationStatus) {
    return null;
  }
  const goalStartedAt = firstGoalToolAt(events);
  if (goalStartedAt == null) {
    return null;
  }

  let statusAtGoalStart: AgentConversationStatus | null = null;
  let runtimeMs = 0;
  let latestStatusAt: number | null = null;
  let hasStatusEvent = false;

  for (const event of events) {
    if (event.kind === "status") {
      hasStatusEvent = true;
    }
    if (event.kind === "status" && event.createdAt < goalStartedAt) {
      statusAtGoalStart = event.status;
    }
  }

  let runningStartedAt: number | null =
    isGoalRuntimeRunningStatus(statusAtGoalStart ?? "idle") ||
    (!hasStatusEvent && isGoalRuntimeRunningStatus(conversationStatus))
      ? goalStartedAt
      : null;

  for (const event of events) {
    if (event.kind !== "status" || event.createdAt < goalStartedAt) {
      continue;
    }
    latestStatusAt = event.createdAt;
    if (isGoalRuntimeRunningStatus(event.status)) {
      if (runningStartedAt == null) {
        runningStartedAt = Math.max(event.createdAt, goalStartedAt);
      }
      continue;
    }
    if (runningStartedAt != null) {
      runtimeMs += Math.max(0, event.createdAt - runningStartedAt);
      runningStartedAt = null;
    }
  }

  if (runningStartedAt == null && isGoalRuntimeRunningStatus(conversationStatus)) {
    runningStartedAt = Math.max(goalStartedAt, latestStatusAt ?? goalStartedAt);
  }
  if (runningStartedAt != null && !isGoalRuntimeRunningStatus(conversationStatus)) {
    runtimeMs += Math.max(0, (latestStatusAt ?? goalStartedAt) - runningStartedAt);
    runningStartedAt = null;
  }

  return {
    runtimeSeconds: Math.max(0, Math.floor(runtimeMs / 1000)),
    runtimeActiveSince: runningStartedAt,
  };
}

export function goalProgressStatuses(
  events: readonly AgentStoredEvent[]
): GoalProgressSnapshotStatus[] {
  const statuses: GoalProgressSnapshotStatus[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      event.kind !== "tool_call_update" ||
      event.status !== "completed" ||
      !event.raw
    ) {
      continue;
    }
    const raw = objectRecord(event.raw);
    const request = objectRecord(raw?.request);
    const toolName = normalizeGoalToolName(
      typeof request?.name === "string" ? request.name : ""
    );
    if (toolName !== "goal_summarize" && toolName !== "goal_summarize_state") {
      continue;
    }
    const args = objectRecord(request?.arguments);
    if (!args) {
      continue;
    }
    const progressPercent = args.progressPercent;
    if (typeof progressPercent !== "number" || !Number.isFinite(progressPercent)) {
      continue;
    }
    const headline = typeof args.headline === "string" && args.headline.trim()
      ? args.headline.trim()
      : null;
    const summary = typeof args.summary === "string" && args.summary.trim()
      ? args.summary.trim()
      : null;
    statuses.push({
      progressPercent: Math.max(0, Math.min(100, Math.round(progressPercent))),
      headline,
      summary,
      updatedAt: event.createdAt,
      toolCallId: event.toolCallId,
    });
  }
  return statuses;
}

export function latestGoalProgressStatus(
  events: readonly AgentStoredEvent[],
  conversationStatus?: AgentConversationStatus | null
): GoalProgressStatus | null {
  const history = goalProgressStatuses(events);
  const latest = history.at(-1);
  if (!latest) {
    return null;
  }
  let completedAt: number | null = null;
  for (const event of events) {
    if (
      event.createdAt < latest.updatedAt ||
      event.kind !== "tool_call_update" ||
      event.status !== "completed"
    ) {
      continue;
    }
    if (goalToolNameFromEvent(event) === "goal_complete") {
      completedAt = event.createdAt;
    }
  }
  const runtime = goalRuntimeStatus(events, conversationStatus);
  const completion = completedAt == null ? {} : { completedAt };
  return runtime
    ? { ...latest, history, ...completion, ...runtime }
    : { ...latest, history, ...completion };
}

/** Apply a streamed `status` event to a conversation record (null = no change). */
export function mergeAgentConversationStatusFromEvent(
  conversation: AgentConversationRecord,
  event: Extract<AgentStoredEvent, { kind: "status" }>
): AgentConversationRecord | null {
  const detail = event.detail?.trim() ?? null;
  if (event.status === "failed") {
    if (conversation.status === "failed" && (detail ?? conversation.lastError) === conversation.lastError) {
      return null;
    }
    return {
      ...conversation,
      status: "failed",
      lastError: detail ?? conversation.lastError,
    };
  }
  if (event.status === "idle") {
    if (conversation.status === "idle" && conversation.lastError === null) {
      return null;
    }
    return {
      ...conversation,
      status: "idle",
      lastError: null,
    };
  }
  if (conversation.status === event.status) {
    return null;
  }
  return {
    ...conversation,
    status: event.status,
  };
}
import type {
  AgentModeOption,
  ChatMessage,
  ModelInfo,
  PermissionChoiceOption,
  TodoItem,
  UserMessageSegment,
  WorkedSessionEditPreview,
  WorkedSessionEntry,
  WorkflowRunSnapshot,
} from "./types";
import { questionEventToChatMessage } from "./ask-question-dock";
import {
  DEFAULT_MODE_OPTIONS,
  formatModeLabel,
  resolveCanonicalModeId,
} from "./chat-modes";
import { splitContentByDesignBlocks } from "./design-capture";
import { splitContentByTextReferenceBlocks } from "./text-reference";
import {
  findConversationModeConfigOptionForUi,
  findConversationModelConfigOptionForUi,
} from "./agent-config-option-utils";
import {
  classifyToolCallAsSubagentCard,
  extractAcpToolCallEntries,
  extractCodexSubagentStates,
  extractSubagentSessionIds,
  extractSubagentTaskText,
  getSubagentTaskInput,
  getToolRawUpdate,
} from "./agent-subagent-routing";
import type { ProjectAgentEventsOptions } from "./agent-subagent-routing";
import { formatToolFileLabel, toolPathBasename } from "./workspace-tool-path-display";
import {
  isCesiumFailureAssistantChunk,
  isCompletionFailureThreadContent,
} from "./agent-completion-error";
import {
  extractMcpServerIdFromRecords,
  extractMcpServerIdFromTitle,
  extractMcpServerIdFromWorkedTool,
  formatMcpServerDisplayName,
  isMcpWorkedTool,
  summarizeMcpServerCounts,
} from "./mcp-server-display";

export type { ProjectAgentEventsOptions };

function modelProviderForBackend(backendId: AgentBackendId): ModelInfo["provider"] {
  switch (backendId) {
    case "cesium-agent":
      return "auto";
    case "cursor-sdk":
      return "cursor";
    case "opencode-server":
    case "opencode-v2-beta":
      return "opencode";
    case "google-antigravity-cli":
      return "google";
    case "codex-app-server":
      return "codex";
    case "claude-code-sdk":
      return "claude";
    default:
      return "auto";
  }
}

function isCodexBackendId(backendId: AgentBackendId | undefined): boolean {
  return backendId === "codex-app-server";
}

function isOpenCodeBackendId(backendId: AgentBackendId | undefined): boolean {
  return backendId === "opencode-server" || backendId === "opencode-v2-beta";
}

function getBackendForConversation(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): AgentBackendInfo | undefined {
  return backends.find((candidate) => candidate.id === conversation.config.backendId);
}

function createBackendDraftConversation(
  backend: AgentBackendInfo
): AgentConversationRecord {
  const configOptions = backend.cachedConfigOptions ?? [];
  const draftConversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `draft-${backend.id}`,
    workspaceId: "draft",
    title: "New chat",
    createdAt: 0,
    updatedAt: 0,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: backend.id,
      mode: backend.defaultMode,
      modelId: backend.defaultModelId,
      modelName: backend.defaultModelName,
    },
    providerSessionId: null,
    configOptions,
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: Boolean(backend.experimental),
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const modeOption = findConversationModeConfigOptionForUi(draftConversation);
  const modelOption = findConversationModelConfigOptionForUi(draftConversation);
  const modelId = modelOption?.currentValue || backend.defaultModelId;
  const modelName =
    modelOption?.options.find((option) => option.value === modelId)?.name ||
    backend.defaultModelName;
  draftConversation.config.mode =
    (modeOption?.currentValue || backend.defaultMode) as AgentConversationRecord["config"]["mode"];
  draftConversation.config.modelId = modelId;
  draftConversation.config.modelName = modelName;
  const modeOpts = buildConversationModeOptions(draftConversation, [backend]);
  draftConversation.config.mode = resolveCanonicalModeId(
    String(draftConversation.config.mode),
    modeOpts
  ) as AgentConversationRecord["config"]["mode"];
  return draftConversation;
}

function isPrimaryConfigCategory(category: AgentConversationRecord["configOptions"][number]["category"]): boolean {
  return category === "mode" || category === "model";
}

function mergeConversationConfigOptionsWithBackend(
  conversation: AgentConversationRecord,
  backend: AgentBackendInfo | undefined
): AgentConversationRecord["configOptions"] {
  const conversationOptions = conversation.configOptions;
  const backendOptions = backend?.cachedConfigOptions ?? [];
  if (conversationOptions.length === 0) {
    return backendOptions;
  }
  if (backendOptions.length === 0) {
    return conversationOptions;
  }

  const usedConversationIndexes = new Set<number>();
  const merged = backendOptions.map((backendOption) => {
    const conversationIndex = conversationOptions.findIndex((candidate, index) => {
      if (usedConversationIndexes.has(index)) {
        return false;
      }
      if (candidate.id === backendOption.id) {
        return true;
      }
      return (
        isPrimaryConfigCategory(backendOption.category) &&
        candidate.category === backendOption.category
      );
    });
    if (conversationIndex === -1) {
      return backendOption;
    }

    usedConversationIndexes.add(conversationIndex);
    const conversationOption = conversationOptions[conversationIndex]!;
    const preferBackendCatalog =
      isPrimaryConfigCategory(backendOption.category) &&
      backendOption.options.length >= conversationOption.options.length;
    /**
     * Model catalogs and enabled mode lists can change after a conversation was
     * created. Prefer the backend's live catalog so stale snapshots cannot
     * resurrect disabled modes or hide newly discovered models.
     */
    const baseOption =
      (backendOption.category === "model" || backendOption.category === "mode") &&
      backendOption.options.length > 0
        ? backendOption
        : preferBackendCatalog
          ? backendOption
          : conversationOption;
    const fallbackCurrentValue = conversationOption.currentValue || backendOption.currentValue;
    const currentValue =
      backendOption.category === "model"
        ? conversation.config.modelId || fallbackCurrentValue
        : backendOption.category === "mode"
          ? conversation.config.mode || fallbackCurrentValue
          : fallbackCurrentValue;
    return {
      ...baseOption,
      currentValue,
    };
  });

  for (let index = 0; index < conversationOptions.length; index += 1) {
    if (!usedConversationIndexes.has(index)) {
      merged.push(conversationOptions[index]!);
    }
  }

  return merged;
}

function getEffectiveConfigOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): AgentConversationRecord["configOptions"] {
  if (conversation.configOptions.length > 0) {
    return mergeConversationConfigOptionsWithBackend(
      conversation,
      getBackendForConversation(conversation, backends)
    );
  }
  return getBackendForConversation(conversation, backends)?.cachedConfigOptions ?? [];
}

function findConfigOptionByCategory(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[],
  category: AgentConversationRecord["configOptions"][number]["category"]
): AgentConversationRecord["configOptions"][number] | undefined {
  return getEffectiveConfigOptions(conversation, backends).find(
    (option) => option.category === category && option.options.length > 0
  );
}

export function findConversationModeConfigOption(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
) {
  const configOptions = getEffectiveConfigOptions(conversation, backends);
  return findConversationModeConfigOptionForUi({
    ...conversation,
    configOptions,
  });
}

export function buildConversationModeOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
): AgentModeOption[] {
  const modeOption = findConversationModeConfigOption(conversation, backends);
  if (!modeOption || modeOption.options.length === 0) {
    return DEFAULT_MODE_OPTIONS;
  }
  return modeOption.options.map((option) => ({
    id: option.value,
    label: formatModeLabel(option.name.trim() || option.value),
    description: option.description,
  }));
}

export function findConversationModelConfigOption(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[] = []
) {
  const configOptions = getEffectiveConfigOptions(conversation, backends);
  return findConversationModelConfigOptionForUi({
    ...conversation,
    configOptions,
  });
}

function toTodoItems(entries: AgentPlanEntry[]): TodoItem[] {
  return entries.map((entry) => ({
    id: entry.id,
    text: entry.content,
    status: entry.status,
  }));
}

function summarizeTodoLabel(entries: AgentPlanEntry[]): string {
  if (entries.length === 0) {
    return "0 of 0 Done";
  }
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const blocked = entries.filter((entry) => entry.status === "blocked").length;
  return blocked > 0
    ? `${completed} of ${entries.length} Done · ${blocked} Blocked`
    : `${completed} of ${entries.length} Done`;
}

function dockActiveTodoUnderLatestUser(messages: ChatMessage[]): ChatMessage[] {
  let latestTodoIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "todo" && (message.todos?.length ?? 0) > 0) {
      latestTodoIndex = index;
      break;
    }
  }
  if (latestTodoIndex === -1) {
    return messages;
  }
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1 || latestTodoIndex === latestUserIndex + 1) {
    return messages;
  }
  const todo = messages[latestTodoIndex]!;
  const without = messages.filter((_, index) => index !== latestTodoIndex);
  let userIndex = -1;
  for (let index = without.length - 1; index >= 0; index -= 1) {
    if (without[index]?.type === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex === -1) {
    return messages;
  }
  return [
    ...without.slice(0, userIndex + 1),
    todo,
    ...without.slice(userIndex + 1),
  ];
}

export function agentPermissionOptionsToUiChoices(
  options: { optionId: string; name: string; kind: PermissionChoiceOption["kind"] }[]
): PermissionChoiceOption[] {
  return options.map((option) => ({
    id: option.optionId,
    label: option.name,
    kind: option.kind,
  }));
}

type ProjectedTurn = {
  id: string;
  userMessage?: ChatMessage;
  timeline: Array<
    | { kind: "trace"; entry: WorkedSessionEntry }
    | { kind: "assistant"; text: string; messageId: string }
    | { kind: "message"; message: ChatMessage }
  >;
  /** User-visible worked-session content: tool rows and other non-message trace blocks */
  trace: WorkedSessionEntry[];
  toolEntryById: Map<string, WorkedSessionEntry>;
  /** Next slot for orphan `tool_call_update` → running tool (parallel tools; avoids all binding to open[0]) */
  orphanToolUpdateSlot: number;
  /** First assistant_message_chunk message id (for standalone assistant bubble id) */
  assistantMessageId?: string;
  /** Assistant message ids that have already received a terminal end event. */
  endedAssistantMessageIds: Set<string>;
  permissionCards: Map<string, ChatMessage>;
  todoCards: Map<string, ChatMessage>;
  subagentCards: Map<string, ChatMessage>;
  /**
   * OpenCode: child `ses_*` session id → parent spawn task `toolCallId` so global SSE merges
   * into the same subagent card as the shell/task row (avoids duplicate "Subagent" cards).
   */
  openCodeSpawnToolBySessionId: Map<string, string>;
  /**
   * Spawn task `toolCallId`s that never received a wire `ses_*` on the ACP tool payload, in order.
   * When the first global-SSE event arrives for `ses_child`, we attach it to the next pending spawn (FIFO).
   */
  openCodeUnlinkedSpawnQueue: string[];
  /** Child `ses_*` ids that received SSE before their spawn tool_call was projected (paired with spawns FIFO). */
  openCodeOrphanSseSessionOrder: string[];
  /** The user message ID that should be highlighted as the handoff message */
  handoffMessageId?: string;
  /** Set when a terminal status event ends the turn before assistant output. */
  turnEndedWithFailure?: boolean;
  /** Set when the runtime has emitted an idle/failed/cancelled terminal status for this turn. */
  turnSettled?: boolean;
  /** Provider auto-retry in progress — show "Taking longer" instead of "Working". */
  takingLonger?: boolean;
  /** Cesium context compression in progress — show "Compressing context". */
  compressingContext?: boolean;
  /** Wall-clock start for this turn (`user_message.createdAt`). */
  turnStartedAt?: number;
  /** Wall-clock end when the runtime settles this turn (`status` idle/failed/cancelled). */
  turnCompletedAt?: number;
};

function createTurn(id: string): ProjectedTurn {
  return {
    id,
    timeline: [],
    trace: [],
    toolEntryById: new Map(),
    orphanToolUpdateSlot: 0,
    endedAssistantMessageIds: new Set(),
    permissionCards: new Map(),
    todoCards: new Map(),
    subagentCards: new Map(),
    openCodeSpawnToolBySessionId: new Map(),
    openCodeUnlinkedSpawnQueue: [],
    openCodeOrphanSseSessionOrder: [],
    handoffMessageId: undefined,
  };
}

function appendTraceEntry(turn: ProjectedTurn, entry: WorkedSessionEntry): void {
  turn.trace.push(entry);
  turn.timeline.push({ kind: "trace", entry });
}

function appendTimelineMessage(turn: ProjectedTurn, message: ChatMessage): void {
  turn.timeline.push({ kind: "message", message });
}

function mergeTranscriptRowsById(
  current: ChatMessage[] | undefined,
  incoming: ChatMessage[] | undefined
): ChatMessage[] {
  const merged: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const row of [...(current ?? []), ...(incoming ?? [])]) {
    if (seen.has(row.id)) {
      continue;
    }
    merged.push(row);
    seen.add(row.id);
  }
  return merged;
}

function mergeSubagentCard(target: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (target.type !== "subagent" || incoming.type !== "subagent") {
    return target;
  }
  const currentTitleScore = subagentTitleQualityScore(target.subagentTitle);
  const incomingTitleScore = subagentTitleQualityScore(incoming.subagentTitle);
  if (incomingTitleScore >= currentTitleScore && incoming.subagentTitle) {
    target.subagentTitle = incoming.subagentTitle;
  }
  target.subagentId = target.subagentId ?? incoming.subagentId;
  target.subagentMeta = incoming.subagentMeta ?? target.subagentMeta;
  target.subagentStatus = incoming.subagentStatus ?? target.subagentStatus;
  target.subagentComplete =
    target.subagentStatus === "running"
      ? false
      : incoming.subagentComplete ?? target.subagentComplete;
  target.subagentTranscript = mergeTranscriptRowsById(
    target.subagentTranscript,
    incoming.subagentTranscript
  );
  target.recentActivity = incoming.recentActivity ?? target.recentActivity;
  return target;
}

/** OpenCode SSE bridge uses synthetic ids so sub-agent assistant deltas land in the subagent card. */
const OPENCODE_SUBAGENT_ASSISTANT_CHUNK = /^opencode-subagent:([^:]+):(.+)$/;

/** OpenCode child session ids (SSE `sessionID`); allow common token chars inside the suffix. */
const OPENCODE_WIRE_SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;

function isOpenCodeWireSessionId(id: string | undefined): id is string {
  return Boolean(id && OPENCODE_WIRE_SESSION_ID.test(id));
}

function scrubOpenCodeUnlinkedSpawn(turn: ProjectedTurn, spawnToolCallId: string): void {
  const q = turn.openCodeUnlinkedSpawnQueue;
  for (let i = q.length - 1; i >= 0; i -= 1) {
    if (q[i] === spawnToolCallId) {
      q.splice(i, 1);
    }
  }
}

function scrubOpenCodeOrphanSseSession(turn: ProjectedTurn, sessionId: string): void {
  const q = turn.openCodeOrphanSseSessionOrder;
  for (let i = q.length - 1; i >= 0; i -= 1) {
    if (q[i] === sessionId) {
      q.splice(i, 1);
    }
  }
}

function enqueueOpenCodeOrphanSseSession(turn: ProjectedTurn, sessionId: string): void {
  if (!isOpenCodeWireSessionId(sessionId) || turn.openCodeSpawnToolBySessionId.has(sessionId)) {
    return;
  }
  if (turn.openCodeOrphanSseSessionOrder.includes(sessionId)) {
    return;
  }
  turn.openCodeOrphanSseSessionOrder.push(sessionId);
}

function registerOpenCodeUnlinkedSpawn(turn: ProjectedTurn, spawnToolCallId: string): void {
  if (turn.openCodeUnlinkedSpawnQueue.includes(spawnToolCallId)) {
    return;
  }
  for (const mapped of turn.openCodeSpawnToolBySessionId.values()) {
    if (mapped === spawnToolCallId) {
      return;
    }
  }
  turn.openCodeUnlinkedSpawnQueue.push(spawnToolCallId);
}

/**
 * When SSE uses a real `ses_*` id but the spawn task never embedded it in ACP, merge into the
 * next unlinked spawn card (same order as spawn tool_calls).
 */
function tryClaimOpenCodeSpawnForChildSession(
  turn: ProjectedTurn,
  childSessionId: string
): ChatMessage | undefined {
  if (!isOpenCodeWireSessionId(childSessionId) || turn.openCodeSpawnToolBySessionId.has(childSessionId)) {
    return undefined;
  }
  while (turn.openCodeUnlinkedSpawnQueue.length > 0) {
    const spawnToolCallId = turn.openCodeUnlinkedSpawnQueue[0]!;
    const msg = turn.subagentCards.get(spawnToolCallId);
    if (!msg || msg.type !== "subagent") {
      turn.openCodeUnlinkedSpawnQueue.shift();
      continue;
    }
    turn.openCodeUnlinkedSpawnQueue.shift();
    linkOpenCodeSpawnToSession(turn, spawnToolCallId, childSessionId, msg);
    return msg;
  }
  return undefined;
}

/** If global SSE created an orphan card before the spawn tool_call landed, fold it into the new spawn row. */
function tryAttachOrphanOpenCodeSseToNewSpawn(
  turn: ProjectedTurn,
  spawnToolCallId: string,
  message: ChatMessage
): boolean {
  while (turn.openCodeOrphanSseSessionOrder.length > 0) {
    const sessionId = turn.openCodeOrphanSseSessionOrder[0]!;
    if (turn.openCodeSpawnToolBySessionId.has(sessionId)) {
      turn.openCodeOrphanSseSessionOrder.shift();
      continue;
    }
    const orphan = turn.subagentCards.get(`sse-${sessionId}`);
    if (!orphan || orphan.type !== "subagent") {
      turn.openCodeOrphanSseSessionOrder.shift();
      continue;
    }
    turn.openCodeOrphanSseSessionOrder.shift();
    linkOpenCodeSpawnToSession(turn, spawnToolCallId, sessionId, message);
    return true;
  }
  return false;
}

function resolveOpenCodeSubagentMessage(
  turn: ProjectedTurn,
  childSessionId: string
): ChatMessage | undefined {
  const sid = childSessionId.trim();
  if (!sid) {
    return undefined;
  }
  const direct =
    findSubagentMessageBySessionId(turn, [sid]) ?? turn.subagentCards.get(`sse-${sid}`);
  if (direct) {
    return direct;
  }
  const spawnToolCallId = turn.openCodeSpawnToolBySessionId.get(sid);
  if (spawnToolCallId) {
    return turn.subagentCards.get(spawnToolCallId);
  }
  return undefined;
}

function absorbOpenCodeOrphanSubagentCard(
  turn: ProjectedTurn,
  primary: ChatMessage,
  orphan: ChatMessage
): void {
  const pTr = primary.subagentTranscript?.length ? primary.subagentTranscript : [];
  const oTr = orphan.subagentTranscript?.length ? orphan.subagentTranscript : [];
  const seen = new Set(pTr.map((m) => m.id));
  const merged = [...pTr];
  for (const row of oTr) {
    if (!seen.has(row.id)) {
      merged.push(row);
      seen.add(row.id);
    }
  }
  primary.subagentTranscript = merged;
  primary.recentActivity = buildSubagentRecentActivity(merged, undefined);

  turn.timeline = turn.timeline.filter(
    (item) => !(item.kind === "message" && item.message === orphan)
  );
  const dropKeys: string[] = [];
  for (const [k, v] of turn.subagentCards) {
    if (v === orphan) {
      dropKeys.push(k);
    }
  }
  for (const k of dropKeys) {
    turn.subagentCards.delete(k);
  }
}

/** Attach OpenCode `ses_*` identity to the spawn-task card; merge an earlier SSE-only duplicate if any. */
function linkOpenCodeSpawnToSession(
  turn: ProjectedTurn,
  spawnToolCallId: string,
  sessionId: string,
  message: ChatMessage
): void {
  if (!isOpenCodeWireSessionId(sessionId)) {
    return;
  }
  scrubOpenCodeUnlinkedSpawn(turn, spawnToolCallId);
  scrubOpenCodeOrphanSseSession(turn, sessionId);
  turn.openCodeSpawnToolBySessionId.set(sessionId, spawnToolCallId);

  const orphan = turn.subagentCards.get(`sse-${sessionId}`);
  if (orphan && orphan !== message) {
    absorbOpenCodeOrphanSubagentCard(turn, message, orphan);
  }

  message.subagentId = sessionId;
  turn.subagentCards.set(spawnToolCallId, message);
  turn.subagentCards.set(`sse-${sessionId}`, message);
}

function appendSubagentOpenCodeAssistantChunk(
  turn: ProjectedTurn,
  subagentSessionId: string,
  openCodeMessageId: string,
  text: string
): void {
  if (!text) {
    return;
  }
  let message =
    resolveOpenCodeSubagentMessage(turn, subagentSessionId) ??
    tryClaimOpenCodeSpawnForChildSession(turn, subagentSessionId);
  if (!message) {
    message = {
      id: `subagent-${subagentSessionId}`,
      type: "subagent",
      subagentId: subagentSessionId,
      subagentTitle: "Subagent",
      subagentStatus: "running",
      subagentComplete: false,
      subagentTranscript: [],
    };
    turn.subagentCards.set(`sse-${subagentSessionId}`, message);
    enqueueOpenCodeOrphanSseSession(turn, subagentSessionId);
    appendTimelineMessage(turn, message);
  }
  const tr = message.subagentTranscript?.length ? message.subagentTranscript : [];
  const chunkId = `${openCodeMessageId}-assistant`;
  const last = tr[tr.length - 1];
  if (last?.type === "assistant" && last.id === chunkId) {
    last.content = `${last.content ?? ""}${text}`;
    const cleaned = stripAgentTodoJsonAssistantContent(last.content);
    if (!cleaned.trim()) {
      tr.pop();
    } else {
      last.content = cleaned;
    }
  } else {
    const cleanedChunk = stripAgentTodoJsonAssistantContent(text);
    if (cleanedChunk.trim()) {
      tr.push({
        id: chunkId,
        type: "assistant",
        content: cleanedChunk,
      });
    }
  }
  message.subagentTranscript = tr;
  message.recentActivity = buildSubagentRecentActivity(tr, undefined);
}

/** OpenCode global SSE: merge tool rows into the child session's transcript (not the root turn trace). */
function mergeOpenCodeSubagentToolIntoTranscript(
  turn: ProjectedTurn,
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  workspaceRoot: string | null | undefined
): void {
  const sid = event.openCodeSubagentSessionId;
  if (!sid) {
    return;
  }
  let message =
    resolveOpenCodeSubagentMessage(turn, sid) ?? tryClaimOpenCodeSpawnForChildSession(turn, sid);
  if (!message) {
    message = {
      id: `subagent-${sid}`,
      type: "subagent",
      subagentId: sid,
      subagentTitle: "Subagent",
      subagentStatus: "running",
      subagentComplete: false,
      subagentTranscript: [],
    };
    turn.subagentCards.set(`sse-${sid}`, message);
    enqueueOpenCodeOrphanSseSession(turn, sid);
    appendTimelineMessage(turn, message);
  }
  const tr = message.subagentTranscript?.length ? message.subagentTranscript : [];
  let existingTool: Extract<WorkedSessionEntry, { kind: "tool" }> | undefined;
  let hostIdx = -1;
  for (let i = tr.length - 1; i >= 0; i--) {
    const m = tr[i];
    if (m?.type !== "worked-session" || !Array.isArray(m.workedEntries)) {
      continue;
    }
    const found = m.workedEntries.find(
      (e): e is Extract<WorkedSessionEntry, { kind: "tool" }> =>
        e.kind === "tool" && e.toolCallId === event.toolCallId
    );
    if (found) {
      existingTool = found;
      hostIdx = i;
      break;
    }
  }
  const nextEntry = formatToolSummary(event, existingTool, workspaceRoot ?? undefined);
  if (!existingTool) {
    const lastTr = tr[tr.length - 1];
    const tailEntries =
      lastTr?.type === "worked-session" && Array.isArray(lastTr.workedEntries)
        ? lastTr.workedEntries
        : undefined;
    const canBatchIntoTail =
      message.subagentStatus === "running" &&
      tailEntries !== undefined &&
      lastTr !== undefined &&
      !lastTr.loading;

    if (canBatchIntoTail) {
      tailEntries.push(nextEntry);
      lastTr.workedLabel = buildWorkedSessionLabel(tailEntries);
      lastTr.workedHighlightedEntry = selectWorkedHighlightEntry(tailEntries);
    } else {
      tr.push({
        id: `subagent-${sid}-tool-${event.toolCallId}`,
        type: "worked-session",
        workedLabel: nextEntry.title,
        workedEntries: [nextEntry],
        workedDefaultOpen: true,
        workedHighlightedEntry: selectWorkedHighlightEntry([nextEntry]),
      });
    }
  } else if (hostIdx >= 0) {
    const host = tr[hostIdx];
    if (host?.type === "worked-session" && host.workedEntries) {
      const keepId = existingTool.toolCallId;
      Object.assign(existingTool, nextEntry);
      if (keepId) {
        existingTool.toolCallId = keepId;
      }
      host.workedLabel = buildWorkedSessionLabel(host.workedEntries);
      host.workedHighlightedEntry = selectWorkedHighlightEntry(host.workedEntries);
    }
  }
  message.subagentTranscript = tr;
  message.recentActivity = buildSubagentRecentActivity(tr, undefined);
  message.subagentStatus = "running";
  message.subagentComplete = false;
}

function appendAssistantChunk(turn: ProjectedTurn, text: string, messageId: string): void {
  if (!text) {
    return;
  }
  if (isCesiumFailureAssistantChunk(text)) {
    return;
  }
  if (turn.endedAssistantMessageIds.has(messageId)) {
    return;
  }
  if (!turn.assistantMessageId) {
    turn.assistantMessageId = messageId;
  }
  const last = turn.timeline[turn.timeline.length - 1];
  if (last?.kind === "assistant" && last.messageId === messageId) {
    last.text += text;
  } else {
    turn.timeline.push({ kind: "assistant", text, messageId });
  }
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function capitalizeFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const TOOL_TITLE_MAX_LEN = 56;
const TOOL_PATH_LABEL_MAX = 80;
const TOOL_PATTERN_QUOTED_MAX = 42;
const TERMINAL_TITLE_MAX = 72;

function truncateMiddleLabel(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const ellipsis = "…";
  const keep = max - ellipsis.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return value.slice(0, head) + ellipsis + value.slice(value.length - tail);
}

function cleanTerminalCommandLabel(command: string): string {
  const trimmed = command.trim();
  const match = /(?:^|\s)-Command\s+(.+)$/i.exec(trimmed);
  const commandBody = match?.[1]?.trim();
  if (!commandBody) {
    return trimmed;
  }
  if (
    (commandBody.startsWith('"') && commandBody.endsWith('"')) ||
    (commandBody.startsWith("'") && commandBody.endsWith("'"))
  ) {
    return commandBody.slice(1, -1).trim();
  }
  return commandBody;
}

function conciseQuotedSearchPattern(raw: string, max = TOOL_PATTERN_QUOTED_MAX): string {
  const t = raw.trim();
  if (!t) {
    return '""';
  }
  const inner = t.length > max ? truncateMiddleLabel(t, max) : t;
  return `"${inner}"`;
}

/** Drop detail lines that only repeat the title (e.g. path shown twice for reads/updates). */
function stripRedundantToolDetail(
  detail: string | undefined,
  title: string
): string | undefined {
  if (!detail?.trim()) {
    return undefined;
  }
  const d = detail.trim();
  const t = title.trim();
  if (/^updated\s+/i.test(d)) {
    return undefined;
  }
  if (d === t) {
    return undefined;
  }
  const readMatch = /^Read\s+(.+)$/i.exec(t);
  if (readMatch) {
    const titled = readMatch[1]!.trim();
    if (d === titled || toolPathBasename(d) === titled || titled === toolPathBasename(d)) {
      return undefined;
    }
  }
  const updateMatch = /^Update\s+(.+)$/i.exec(t);
  if (updateMatch && d === updateMatch[1]!.trim()) {
    return undefined;
  }
  const deleteMatch = /^Delete\s+(.+)$/i.exec(t);
  if (deleteMatch && d === deleteMatch[1]!.trim()) {
    return undefined;
  }
  const webMatch = /^Web ·\s+(.+)$/i.exec(t);
  if (webMatch && d === webMatch[1]!.trim()) {
    return undefined;
  }
  return detail;
}

const TOOL_PATH_STRING_KEYS = [
  "path",
  "filePath",
  "filepath",
  "relPath",
  "relativePath",
  "relative_path",
  "file",
  "targetPath",
  "uri",
  "file_path",
  "fileName",
  "filename",
  "file_name",
  "target_file",
  "target",
  "source",
  "resourcePath",
  "file_uri",
] as const;

function pathFromReadLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^(?:read|view|open)\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    const rest = m[1]!.trim();
    if (!rest || /^file$/i.test(rest)) {
      continue;
    }
    return rest;
  }
  return undefined;
}

function queryFromFindLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^find\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    let rest = m[1]!.trim();
    if (!rest || /^in\s+workspace$/i.test(rest) || /^workspace$/i.test(rest)) {
      continue;
    }
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1).trim();
    }
    return rest;
  }
  return undefined;
}

function patternFromGrepLikeToolTitle(...candidates: (string | undefined)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw?.trim()) {
      continue;
    }
    const m = /^grep\s+(.+)$/i.exec(raw.trim());
    if (!m) {
      continue;
    }
    let rest = m[1]!.trim();
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1);
    }
    return rest;
  }
  return undefined;
}

function withConciseToolDetail<T extends Extract<WorkedSessionEntry, { kind: "tool" }>>(
  row: T
): T {
  const rawDetail =
    row.rawDetail ??
    (row.status !== "failed" && isVerboseToolPayloadDetail(row.detail) ? row.detail?.trim() : undefined);
  const nextDetail = rawDetail
    ? undefined
    : stripRedundantToolDetail(row.detail, row.title);
  if (nextDetail === row.detail && rawDetail === row.rawDetail) {
    return row;
  }
  return { ...row, detail: nextDetail, rawDetail };
}

function humanizeToolCallName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function inferUserSegmentKind(token: string): UserMessageSegment["type"] | null {
  const bare = token.startsWith("@") ? token.slice(1) : token;
  const lowered = bare.toLowerCase();
  if (["codebase", "docs", "web", "terminal"].includes(lowered)) {
    return "context";
  }
  if (
    bare.includes("/") ||
    bare.includes("\\") ||
    bare.startsWith(".") ||
    /\.[a-z0-9]{1,12}$/i.test(bare)
  ) {
    return "file";
  }
  return null;
}

/**
 * Build the per-slice @-chip segments for a plain text run. Split out so
 * {@link parseUserMessageSegments} can apply it to each non-design slice
 * returned by {@link splitContentByDesignBlocks}.
 */
function parseAtChipSegments(content: string): {
  segments: UserMessageSegment[];
  sawChip: boolean;
} {
  const pattern = /@[^\s]+/g;
  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;
  let sawChip = false;

  for (const match of content.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({
        type: "text",
        text: content.slice(lastIndex, start),
      });
    }

    let chip = token;
    let trailing = "";
    while (chip.length > 1 && /[),.;:!?]}]/.test(chip.at(-1) ?? "")) {
      trailing = `${chip.at(-1)}${trailing}`;
      chip = chip.slice(0, -1);
    }

    const kind = inferUserSegmentKind(chip);
    if (kind) {
      sawChip = true;
      segments.push({
        type: kind,
        text: kind === "context" ? chip : chip.slice(1),
      });
      if (trailing) {
        segments.push({ type: "text", text: trailing });
      }
    } else {
      segments.push({ type: "text", text: token });
    }
    lastIndex = start + token.length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: "text",
      text: content.slice(lastIndex),
    });
  }

  return { segments, sawChip };
}

function parseUserMessageSegments(content: string): UserMessageSegment[] | undefined {
  // Compact-reference XML blocks take precedence — split the message on them
  // first so long/code-like bodies don't confuse the @-chip pass.
  const referenceSplit = splitContentByTextReferenceBlocks(content);
  const designSplit = splitContentByDesignBlocks(content);
  const structuredSplit = referenceSplit ?? designSplit;
  if (structuredSplit) {
    const out: UserMessageSegment[] = [];
    for (const seg of structuredSplit) {
      const nestedDesign =
        seg.type === "text" && referenceSplit ? splitContentByDesignBlocks(seg.text) : null;
      if (nestedDesign) {
        for (const nestedSeg of nestedDesign) {
          if (nestedSeg.type !== "text") {
            out.push(nestedSeg);
            continue;
          }
          const atChips = parseAtChipSegments(nestedSeg.text);
          if (atChips.sawChip) {
            out.push(...atChips.segments);
          } else if (nestedSeg.text.length > 0) {
            out.push({ type: "text", text: nestedSeg.text });
          }
        }
        continue;
      }
      if (seg.type !== "text") {
        out.push(seg);
        continue;
      }
      const atChips = parseAtChipSegments(seg.text);
      if (atChips.sawChip) {
        out.push(...atChips.segments);
      } else if (seg.text.length > 0) {
        out.push({ type: "text", text: seg.text });
      }
    }
    return out.filter((s) => s.type !== "text" || s.text.length > 0);
  }

  const atChips = parseAtChipSegments(content);
  return atChips.sawChip
    ? atChips.segments.filter((segment) => segment.text.length > 0)
    : undefined;
}

function toWorkedToolStatus(
  status: string
): Extract<WorkedSessionEntry, { kind: "tool" }>["status"] {
  switch (status) {
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

function inferToolKindFromTitle(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("call_mcp") || n.includes("refresh_mcp") || /^mcp\s/.test(n)) {
    return "mcp";
  }
  if (n.includes("todo")) {
    return "todo";
  }
  if (n.includes("workflow")) {
    return "workflow";
  }
  if (n.includes("ask question") || n.includes("asked question")) {
    return "question";
  }
  if (n.includes("search web") || n.includes("web search") || n.includes("websearch")) {
    return "search_web";
  }
  if (n.includes("grep") || n.includes("ripgrep")) {
    return "grep";
  }
  if (n.includes("glob") || n.includes("find") || n.includes("search")) {
    return "search";
  }
  if (n.includes("delete") || n.includes("remove") || n.includes("unlink")) {
    return "delete";
  }
  if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("patch") ||
    n.includes("apply") ||
    n.includes("update") ||
    n.includes("create") ||
    n.includes("insert") ||
    n.includes("str replace") ||
    n.includes("replace") ||
    n.includes("rename") ||
    n.includes("mkdir")
  ) {
    return "edit";
  }
  if (n.includes("read") || n.includes("open") || n.includes("view")) {
    return "read";
  }
  if (
    n.includes("run") ||
    n.includes("shell") ||
    n.includes("command") ||
    n.includes("bash") ||
    n.includes("terminal") ||
    n.includes("execute")
  ) {
    return "terminal";
  }
  return "tool";
}

function recordHasAnyKey(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => key in record && record[key] != null);
}

function looksLikeEditPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  if (
    recordHasAnyKey(record, [
      "diffString",
      "linesAdded",
      "linesRemoved",
      "beforeFullFileContent",
      "afterFullFileContent",
      "old_string",
      "new_string",
      "oldString",
      "newString",
      "replacement",
      "replacements",
      "patch",
      "edits",
      "contents",
      "renameTo",
      "newPath",
    ])
  ) {
    return true;
  }
  const errorText =
    typeof record.error === "string"
      ? record.error
      : record.error &&
          typeof record.error === "object" &&
          typeof (record.error as Record<string, unknown>).error === "string"
        ? ((record.error as Record<string, unknown>).error as string)
        : undefined;
  return Boolean(errorText && /failed to find context|apply patch|replace/i.test(errorText));
}

function looksLikeReadPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  return (
    typeof record.path === "string" ||
    typeof record.filePath === "string" ||
    typeof record.file_path === "string" ||
    "readRange" in record ||
    "lineRange" in record
  );
}

function looksLikeWorkspaceFindPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  return recordHasAnyKey(record, ["globPattern", "glob_pattern", "glob"]);
}

function looksLikeGrepToolPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeEditPayload(record)) {
    return false;
  }
  if (looksLikeWorkspaceFindPayload(record)) {
    return false;
  }
  return recordHasAnyKey(record, ["pattern", "query", "regex", "searchTerm", "search", "needle"]);
}

function inferToolKindFromPayloadRecords(
  values: Array<Record<string, unknown> | undefined>
): string | undefined {
  if (values.some((value) => looksLikeEditPayload(value))) {
    return "edit";
  }
  if (values.some((value) => looksLikeWorkspaceFindPayload(value))) {
    return "search";
  }
  if (values.some((value) => looksLikeGrepToolPayload(value))) {
    return "grep";
  }
  if (values.some((value) => looksLikeReadPayload(value))) {
    return "read";
  }
  return undefined;
}

function summarizeWorkedToolBucket(
  kind: string,
  count: number,
  fileCount: number,
  allHaveEditPreview: boolean,
  mcpServerCounts?: Map<string, number>
): string {
  const resolvedCount = fileCount > 0 ? fileCount : count;
  switch (kind) {
    case "read":
      return resolvedCount === 1 ? "read 1 file" : `read ${resolvedCount} files`;
    case "edit":
      if (allHaveEditPreview) {
        return count === 1 ? "edit" : `${count} edits`;
      }
      return resolvedCount === 1 ? "edited 1 file" : `edited ${resolvedCount} files`;
    case "delete":
      return resolvedCount === 1 ? "deleted 1 file" : `deleted ${resolvedCount} files`;
    case "grep":
      return count === 1 ? "grepped" : `grepped ${count} times`;
    case "search_web":
      return count === 1 ? "searched web" : `searched web ${count} times`;
    case "search":
      return count === 1 ? "searched workspace" : `searched workspace ${count} times`;
    case "terminal":
    case "execute":
      return count === 1 ? "ran a command" : `ran ${count} commands`;
    case "todo":
      return count === 1 ? "updated todo list" : `updated todo list ${count} times`;
    case "goal":
      return count === 1 ? "updated Goal" : `updated Goal ${count} times`;
    case "workflow":
      return count === 1 ? "ran a workflow" : `ran workflows ${count} times`;
    case "question":
    case "ask":
      return count === 1 ? "asked question" : "asked questions";
    case "mcp":
      if (mcpServerCounts && mcpServerCounts.size > 0) {
        return summarizeMcpServerCounts(mcpServerCounts);
      }
      return count === 1 ? "called MCP tool" : "called MCP tools";
    default:
      return count === 1 ? "used a tool" : `used ${count} tools`;
  }
}

function buildWorkedSessionLabel(entries: WorkedSessionEntry[]): string {
  const tools = entries.filter(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> => entry.kind === "tool"
  );
  const hasCompression = entries.some((entry) => entry.kind === "compression");
  const thoughtCount = entries.filter((entry) => entry.kind === "reasoning").length;
  if (hasCompression && tools.length === 0 && thoughtCount === 0) {
    return "Compressed context";
  }
  if (tools.length === 0) {
    if (thoughtCount > 0) {
      return thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`;
    }
    return "Tools";
  }
  const orderedBuckets: Array<{
    kind: string;
    count: number;
    files: Set<string>;
    allEditPreviews: boolean;
    mcpServerCounts?: Map<string, number>;
  }> = [];
  const bucketByKind = new Map<string, (typeof orderedBuckets)[number]>();
  for (const tool of tools) {
    const inferredKind =
      tool.toolKind ??
      (tool.variant === "terminal" ? "terminal" : inferToolKindFromTitle(tool.title));
    const kind = isMcpWorkedTool(tool) ? "mcp" : inferredKind;
    const bucketKey = kind;
    const bucket =
      bucketByKind.get(bucketKey) ??
      (() => {
        const created = {
          kind,
          count: 0,
          files: new Set<string>(),
          allEditPreviews: true,
          mcpServerCounts: kind === "mcp" ? new Map<string, number>() : undefined,
        };
        bucketByKind.set(bucketKey, created);
        orderedBuckets.push(created);
        return created;
      })();
    bucket.count += 1;
    if (kind === "mcp" && bucket.mcpServerCounts) {
      const serverId = extractMcpServerIdFromWorkedTool(tool) ?? "";
      const key = serverId || "__unknown__";
      bucket.mcpServerCounts.set(key, (bucket.mcpServerCounts.get(key) ?? 0) + 1);
    }
    if (kind === "edit") {
      bucket.allEditPreviews = bucket.allEditPreviews && Boolean(tool.editPreview);
    } else {
      bucket.allEditPreviews = false;
    }
    if (tool.editPreview?.path) {
      bucket.files.add(tool.editPreview.path);
      continue;
    }
    for (const file of tool.files ?? []) {
      bucket.files.add(file);
    }
  }
  const segments = orderedBuckets
    .map((bucket) =>
      summarizeWorkedToolBucket(
        bucket.kind,
        bucket.count,
        bucket.files.size,
        bucket.allEditPreviews,
        bucket.mcpServerCounts
      )
    )
    .concat(thoughtCount > 0 ? [thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`] : []);
  const label = segments.join(", ");
  const failedCount = tools.filter((tool) => tool.status === "failed").length;
  return failedCount > 0
    ? `${capitalizeFirst(label)} · ${failedCount} failed`
    : capitalizeFirst(label);
}

function selectWorkedHighlightEntry(
  workedEntries: WorkedSessionEntry[]
): Extract<WorkedSessionEntry, { kind: "tool" }> | undefined {
  const withEdit = workedEntries.filter(
    (e): e is Extract<WorkedSessionEntry, { kind: "tool" }> =>
      e.kind === "tool" && Boolean(e.editPreview)
  );
  if (withEdit.length === 0) {
    return undefined;
  }
  for (let i = withEdit.length - 1; i >= 0; i -= 1) {
    const t = withEdit[i]!;
    if (t.status === "pending" || t.status === "running") {
      return t;
    }
  }
  return withEdit[withEdit.length - 1];
}

/**
 * ACP can emit `permission_request` before the matching `tool_call` lands. Reorder so
 * work-session embed (`prev=worked, next=permission`) in MessageThreadContent matches.
 */
function fixPermissionPlacedAfterWorkedForTools(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages];
  for (let i = 0; i < out.length; i += 1) {
    const m = out[i]!;
    if (m.type !== "permission-request" || !m.permissionLinkedToolCallId) {
      continue;
    }
    const anchor = m.permissionLinkedToolCallId;
    let workIdx = -1;
    for (let j = out.length - 1; j > i; j -= 1) {
      const w = out[j]!;
      if (w.type !== "worked-session" || !w.workedEntries?.length) {
        continue;
      }
      const hasTool = w.workedEntries.some(
        (e) => e.kind === "tool" && e.toolCallId === anchor
      );
      if (hasTool) {
        workIdx = j;
        break;
      }
    }
    if (workIdx < 0 || workIdx < i) {
      continue;
    }
    const [perm] = out.splice(i, 1);
    const newIdx = workIdx > i ? workIdx - 1 : workIdx;
    out.splice(newIdx + 1, 0, perm);
    i -= 1;
  }
  return out;
}

function mergeWorkedSessionPair(
  a: ChatMessage,
  c: ChatMessage
): ChatMessage {
  const combined = [...(a.workedEntries ?? []), ...(c.workedEntries ?? [])];
  return {
    ...a,
    workedEntries: combined,
    workedLabel: buildWorkedSessionLabel(combined),
    workedHighlightedEntry: selectWorkedHighlightEntry(combined),
    loading: Boolean(a.loading || c.loading),
    workedDefaultOpen:
      a.workedDefaultOpen !== false || c.workedDefaultOpen !== false ? true : false,
  };
}

function isTodoOnlyWorkedSession(message: ChatMessage | undefined): boolean {
  if (message?.type !== "worked-session") {
    return false;
  }
  const tools = (message.workedEntries ?? []).filter(
    (entry): entry is Extract<WorkedSessionEntry, { kind: "tool" }> => entry.kind === "tool"
  );
  if (tools.length === 0) {
    return false;
  }
  return tools.every(
    (tool) =>
      tool.toolKind === "todo" ||
      /todo/i.test(tool.title) ||
      /updated todo list/i.test(tool.title)
  );
}

/**
 * Todo tool bursts often flush into separate worked-session rows around the shared
 * checklist card (and legacy per-item todo-update rows). Collapse those back into
 * one dropdown so consecutive todo writes do not look janky.
 */
function mergeTodoWorkedSessionNoise(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.filter((message) => message.type !== "todo-update");
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < out.length; i += 1) {
      const a = out[i];
      const b = out[i + 1];
      if (
        a?.type === "worked-session" &&
        b?.type === "worked-session" &&
        isTodoOnlyWorkedSession(a) &&
        isTodoOnlyWorkedSession(b)
      ) {
        out.splice(i, 2, mergeWorkedSessionPair(a, b));
        changed = true;
        break;
      }
      if (i + 2 >= out.length) {
        continue;
      }
      const c = out[i + 2];
      if (
        a?.type === "worked-session" &&
        b?.type === "todo" &&
        c?.type === "worked-session" &&
        isTodoOnlyWorkedSession(a) &&
        isTodoOnlyWorkedSession(c)
      ) {
        out.splice(i, 3, mergeWorkedSessionPair(a, c), b);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * `permission_request` is stored as a timeline `message` between tool trace entries. That makes
 * {@link projectTurnTimelineToMessages} flush a worked-session before and after the permission row,
 * which splits one tool burst into two dropdowns. Collapse those back into a single worked-session
 * while keeping the permission message immediately after it (so {@link MessageThreadContent} can
 * still embed it next to the linked tool).
 */
function mergeAdjacentWorkedSessionsAroundPermission(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 2 < out.length; i += 1) {
      const a = out[i];
      const b = out[i + 1];
      const c = out[i + 2];
      if (
        a?.type === "worked-session" &&
        b?.type === "permission-request" &&
        c?.type === "worked-session"
      ) {
        out.splice(i, 3, mergeWorkedSessionPair(a, c), b);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function projectTurnTimelineToMessages(turn: ProjectedTurn): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let assistantText = "";
  let workedEntries: WorkedSessionEntry[] = [];
  let segmentIndex = 0;

  const flushAssistant = () => {
    const cleaned = stripAgentTodoJsonAssistantContent(assistantText);
    assistantText = "";
    if (cleaned.trim().length === 0 || isCompletionFailureThreadContent(cleaned)) {
      return;
    }
    messages.push({
      id: `${turn.assistantMessageId ?? `assistant-${turn.id}`}-${segmentIndex++}`,
      type: "assistant",
      content: cleaned,
    });
  };

  const flushWorked = () => {
    if (workedEntries.length === 0) {
      return;
    }
    const highlight = selectWorkedHighlightEntry(workedEntries);
    messages.push({
      id: `turn-worked-${turn.id}-${segmentIndex++}`,
      type: "worked-session",
      workedLabel: buildWorkedSessionLabel(workedEntries),
      workedEntries,
      workedDefaultOpen: true,
      workedHighlightedEntry: highlight,
    });
    workedEntries = [];
  };

  for (let timelineIndex = 0; timelineIndex < turn.timeline.length; timelineIndex += 1) {
    const item = turn.timeline[timelineIndex]!;
    if (item.kind === "message") {
      flushWorked();
      flushAssistant();
      messages.push(item.message);
      continue;
    }
    if (item.kind === "assistant") {
      const chunk = item.text;
      if (chunk === "") {
        continue;
      }
      flushWorked();
      assistantText += chunk;
      continue;
    }
    const entry = item.entry;
    flushAssistant();
    workedEntries.push(entry);
  }

  flushWorked();
  flushAssistant();

  // Merge *before* `fixPermissionPlacedAfterWorkedForTools`. Otherwise a permission for a tool
  // that was flushed into the *second* worked-session (e.g. web search after workspace tools)
  // gets moved to the end: [w1, w2, perm] — the triplet [w1, perm, w2] never forms and the UI
  // shows two "Searched workspace" dropdowns.
  const ordered = fixPermissionPlacedAfterWorkedForTools(
    mergeTodoWorkedSessionNoise(
      mergeAdjacentWorkedSessionsAroundPermission(messages)
    )
  );

  // An unanswered permission request means the agent is blocked on the user,
  // not working — the permission card itself communicates the waiting state.
  const awaitingPermission = ordered.some(
    (message) => message.type === "permission-request" && !message.permissionResolved
  );
  const shouldShowLiveStatus =
    turn.userMessage && !turn.turnEndedWithFailure && !turn.turnSettled && !awaitingPermission;
  if (shouldShowLiveStatus) {
    const compressing = Boolean(turn.compressingContext);
    const liveStatusLabel = compressing
      ? "Compressing context"
      : turn.takingLonger
        ? "Taking longer"
        : "Working";
    const hasWorkedSession = ordered.some((message) => message.type === "worked-session");
    const hasAssistantMessage = ordered.some((message) => message.type === "assistant");
    const shouldAppendLiveStatus = ordered.length === 0 || hasWorkedSession || hasAssistantMessage;
    if (shouldAppendLiveStatus) {
      ordered.push({
        id: `turn-working-${turn.id}`,
        type: "worked-session",
        workedLabel: liveStatusLabel,
        workedEntries: [],
        workedDefaultOpen: false,
        loading: true,
      });
    }
  }

  return mergeDuplicateSubagentMessages(ordered);
}

function turnTimelineHasAssistantContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      stripAgentTodoJsonAssistantContent(message.content ?? "").trim().length > 0
  );
}

function appendTurnCompletionFooter(
  turn: ProjectedTurn,
  timelineMsgs: ChatMessage[]
): ChatMessage[] {
  if (
    !turn.userMessage ||
    !turn.turnSettled ||
    turn.turnStartedAt == null ||
    turn.turnCompletedAt == null ||
    turn.turnCompletedAt <= turn.turnStartedAt ||
    !turnTimelineHasAssistantContent(timelineMsgs)
  ) {
    return timelineMsgs;
  }
  return [
    ...timelineMsgs,
    {
      id: `turn-footer-${turn.userMessage.id}`,
      type: "turn-footer",
      turnDurationMs: turn.turnCompletedAt - turn.turnStartedAt,
      turnFooterUserMessageId: turn.userMessage.id,
    },
  ];
}

function mergeDuplicateSubagentMessages(messages: ChatMessage[]): ChatMessage[] {
  const output: ChatMessage[] = [];
  const bySubagentId = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.type !== "subagent" || !message.subagentId?.trim()) {
      output.push(message);
      continue;
    }
    const key = message.subagentId.trim();
    const existing = bySubagentId.get(key);
    if (!existing) {
      bySubagentId.set(key, message);
      output.push(message);
      continue;
    }
    mergeSubagentCard(existing, message);
  }
  return output;
}

function parseLooseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** OpenCode / plan-mode models often stream the same checklist as JSON that duplicates structured `plan` events. */
export function isAgentTodoJsonArrayPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const o = item as Record<string, unknown>;
    const text = o.content ?? o.text ?? o.title ?? o.description;
    const st = o.status;
    return (
      typeof text === "string" &&
      text.trim().length > 0 &&
      (st === "pending" || st === "in_progress" || st === "blocked" || st === "completed")
    );
  });
}

function tryParseLeadingJsonArray(text: string): unknown | undefined {
  const t = text.trim();
  if (!t.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export function isAgentTodoJsonDetailString(text: string): boolean {
  const parsed = tryParseLeadingJsonArray(text);
  return parsed != null && isAgentTodoJsonArrayPayload(parsed);
}

/** Remove assistant bubbles that are only a redundant todo JSON dump (optionally in a ```json fence). */
export function stripAgentTodoJsonAssistantContent(source: string): string {
  const replaced = source.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, (match, inner) => {
    const t = String(inner).trim();
    return isAgentTodoJsonDetailString(t) ? "" : match;
  });
  const trimmedAll = replaced.trim();
  if (isAgentTodoJsonDetailString(trimmedAll)) {
    return "";
  }
  return replaced.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function parseVerboseToolDetail(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail?.trim()) {
    return undefined;
  }
  return parseLooseJsonObject(detail);
}

function isVerboseToolPayloadDetail(detail: string | undefined): boolean {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return false;
  }
  if (
    /<\s*(path|content|stdout|output|result|type)\s*>/i.test(trimmed) ||
    /\bmessage\.part\.(?:updated|delta)\b/i.test(trimmed)
  ) {
    return true;
  }
  const parsed = parseVerboseToolDetail(trimmed);
  if (
    parsed &&
    ["content", "text", "stdout", "output", "result"].some((key) => key in parsed)
  ) {
    return true;
  }
  const nonEmptyLineCount = trimmed.split(/\r?\n/).filter((line) => line.trim()).length;
  if (nonEmptyLineCount >= 2 && trimmed.length > 80) {
    return true;
  }
  return (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (trimmed.includes("\\n") || trimmed.includes("\n") || trimmed.length > 180)
  );
}

function safeToolDetailText(
  detail: string | undefined,
  options: { suppressVerbosePayload?: boolean } = {}
): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (options.suppressVerbosePayload && isVerboseToolPayloadDetail(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function suppressPathOnlyDetail(detail: string | undefined): string | undefined {
  const parsed = parseVerboseToolDetail(detail);
  if (
    parsed &&
    Object.keys(parsed).length > 0 &&
    Object.keys(parsed).every((key) =>
      ["path", "filePath", "filepath", "relativePath", "targetPath", "uri"].includes(key)
    )
  ) {
    return undefined;
  }
  return detail;
}

/** When stream-json IDs do not line up, completion updates never land — close out on turn end. */
function finalizeOpenToolsInTurn(
  turn: ProjectedTurn,
  finalStatus: "completed" | "failed" | "cancelled"
): void {
  for (const entry of turn.trace) {
    if (entry.kind !== "tool") {
      continue;
    }
    if (entry.status === "pending" || entry.status === "running") {
      entry.status = finalStatus;
    }
  }
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function parseSubagentResultMessages(text: string, baseId: string): ChatMessage[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const messages: ChatMessage[] = [];
  const assistantLines: string[] = [];
  const lines = normalized.split("\n");
  let segmentIndex = 0;

  const flushAssistant = () => {
    const content = assistantLines.join("\n").trim();
    assistantLines.length = 0;
    if (!content) {
      return;
    }
    messages.push({
      id: `${baseId}-assistant-${segmentIndex++}`,
      type: "assistant",
      content,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]?.trim();
    const next = lines[index + 1]?.trim();
    if (
      current &&
      /^used a tool$/i.test(current) &&
      next &&
      !/^used a tool$/i.test(next)
    ) {
      flushAssistant();
      messages.push({
        id: `${baseId}-tool-${segmentIndex++}`,
        type: "worked-session",
        workedLabel: next,
        workedEntries: [
          {
            kind: "tool",
            title: next,
            toolKind: inferToolKindFromTitle(next),
            status: "completed",
          },
        ],
        workedDefaultOpen: true,
      });
      index += 1;
      continue;
    }
    assistantLines.push(lines[index] ?? "");
  }

  flushAssistant();
  return messages;
}

function buildSubagentTranscriptFromTaskEvent(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  title: string
): ChatMessage[] {
  const rawInput = getSubagentTaskInput(event);
  const { taskId, resultText } = extractSubagentTaskText(event);
  const transcript: ChatMessage[] = [];
  const prompt = typeof rawInput?.prompt === "string" ? rawInput.prompt.trim() : "";
  if (prompt) {
    transcript.push({
      id: `${event.toolCallId}-prompt`,
      type: "user",
      content: prompt,
      segments: parseUserMessageSegments(prompt),
    });
  }
  if (resultText) {
    transcript.push(...parseSubagentResultMessages(resultText, taskId ?? event.toolCallId));
  }
  if (transcript.length === 0) {
    transcript.push({
      id: `${event.toolCallId}-empty`,
      type: "assistant",
      content: `No transcript details were exposed for ${title}.`,
    });
  }
  return transcript;
}

function buildSubagentRecentActivity(
  transcript: ChatMessage[],
  fallback: string | undefined
): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.type === "worked-session") {
      const toolTitle = message.workedEntries?.find((entry) => entry.kind === "tool");
      if (toolTitle && toolTitle.kind === "tool") {
        return toolTitle.title;
      }
    }
    if (message?.type === "assistant") {
      const line = firstNonEmptyLine(message.content);
      if (line) {
        return line;
      }
    }
  }
  return firstNonEmptyLine(fallback);
}

function findSubagentMessageBySessionId(
  turn: ProjectedTurn,
  sessionIds: string[]
): ChatMessage | undefined {
  if (sessionIds.length === 0) {
    return undefined;
  }
  return Array.from(turn.subagentCards.values()).find(
    (message) => message.subagentId != null && sessionIds.includes(message.subagentId)
  );
}

function codexSubagentRuntimeStatus(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): ChatMessage["subagentStatus"] | null {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return null;
  }
  const tool = typeof rawUpdate.tool === "string" ? rawUpdate.tool.toLowerCase() : "";
  const states =
    rawUpdate.agents_states && typeof rawUpdate.agents_states === "object" && !Array.isArray(rawUpdate.agents_states)
      ? (rawUpdate.agents_states as Record<string, unknown>)
      : undefined;
  const statusValues = states
    ? Object.values(states)
        .map((value) => {
          if (!value || typeof value !== "object") {
            return undefined;
          }
          const record = value as Record<string, unknown>;
          return typeof record.status === "string" ? record.status.toLowerCase() : undefined;
        })
        .filter((value): value is string => Boolean(value))
    : [];

  if (event.status === "failed" || event.status === "cancelled") {
    return "failed";
  }
  if (tool === "spawn_agent") {
    return "running";
  }
  if (tool === "wait") {
    if (
      statusValues.some(
        (value) => !["completed", "failed", "cancelled", "done", "finished"].includes(value)
      )
    ) {
      return "running";
    }
    return event.status === "completed" ? "completed" : "running";
  }
  return null;
}

function codexCollabToolName(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string | null {
  const rawUpdate = getToolRawUpdate(event);
  if (rawUpdate?.type !== "collab_tool_call") {
    return null;
  }
  return typeof rawUpdate.tool === "string" ? rawUpdate.tool.toLowerCase() : null;
}

function codexStateStatusToSubagentStatus(
  status: string | undefined
): ChatMessage["subagentStatus"] {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) {
    return "running";
  }
  if (["failed", "error", "cancelled", "canceled"].includes(normalized)) {
    return "failed";
  }
  if (["completed", "done", "finished"].includes(normalized)) {
    return "completed";
  }
  return "running";
}

function subagentStatusFromToolEventStatus(
  status: AgentStoredEvent extends infer T
    ? T extends { kind: "tool_call" | "tool_call_update"; status: infer S }
      ? S
      : never
    : never
): ChatMessage["subagentStatus"] {
  if (status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (status === "completed") {
    return "completed";
  }
  return "running";
}

function compactJsonForRejected(record: Record<string, unknown>): string | undefined {
  try {
    const compact = JSON.stringify(record);
    if (!compact || compact === "{}" || compact === "null") {
      return undefined;
    }
    return compact.length > 800 ? `${compact.slice(0, 797)}...` : compact;
  } catch {
    return undefined;
  }
}

function findFirstStringByKey(
  value: unknown,
  keys: string[],
  depth = 0
): string | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstStringByKey(entry, keys, depth + 1);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key] as string;
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstStringByKey(nestedValue, keys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findFirstNumberByKey(
  value: unknown,
  keys: string[],
  depth = 0
): number | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNumberByKey(entry, keys, depth + 1);
      if (match != null) {
        return match;
      }
    }
    return undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "number") {
      return record[key] as number;
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstNumberByKey(nestedValue, keys, depth + 1);
    if (match != null) {
      return match;
    }
  }
  return undefined;
}

function findFirstStringArrayByKey(
  value: unknown,
  keys: string[],
  depth = 0
): string[] | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return value as string[];
    }
    for (const entry of value) {
      const match = findFirstStringArrayByKey(entry, keys, depth + 1);
      if (match?.length) {
        return match;
      }
    }
    return undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key]) && record[key].every((entry) => typeof entry === "string")) {
      return record[key] as string[];
    }
  }
  for (const nestedValue of Object.values(record)) {
    const match = findFirstStringArrayByKey(nestedValue, keys, depth + 1);
    if (match?.length) {
      return match;
    }
  }
  return undefined;
}

function extractToolNameFromCliRaw(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const fromFn =
    raw.function && typeof raw.function === "object"
      ? pick((raw.function as Record<string, unknown>).name)
      : undefined;
  if (fromFn) {
    return fromFn;
  }
  const fromFc =
    raw.function_call && typeof raw.function_call === "object"
      ? pick((raw.function_call as Record<string, unknown>).name)
      : undefined;
  if (fromFc) {
    return fromFc;
  }
  const direct = pick(raw.tool_name) ?? pick(raw.toolName) ?? pick(raw.name);
  if (direct && !/^(text|assistant)$/i.test(direct)) {
    return direct;
  }
  return findFirstStringByKey(raw, ["tool_name", "function_name", "toolName"]);
}

function findFirstStringAcrossValues(
  values: unknown[],
  keys: string[]
): string | undefined {
  for (const value of values) {
    const match = findFirstStringByKey(value, keys);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function pluginMetadataFromToolEvent(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  values: unknown[],
  existing?: Extract<WorkedSessionEntry, { kind: "tool" }>
): Pick<Extract<WorkedSessionEntry, { kind: "tool" }>, "pluginId" | "pluginName" | "pluginIconUrl"> {
  const direct = {
    pluginId: "pluginId" in event ? event.pluginId : undefined,
    pluginName: "pluginName" in event ? event.pluginName : undefined,
    pluginIconUrl: "pluginIconUrl" in event ? event.pluginIconUrl : undefined,
  };
  return {
    pluginId:
      direct.pluginId ??
      existing?.pluginId ??
      findFirstStringAcrossValues(values, ["pluginId", "plugin_id"]),
    pluginName:
      direct.pluginName ??
      existing?.pluginName ??
      findFirstStringAcrossValues(values, ["pluginName", "plugin_name", "displayName", "display_name"]),
    pluginIconUrl:
      direct.pluginIconUrl ??
      existing?.pluginIconUrl ??
      findFirstStringAcrossValues(values, ["pluginIconUrl", "plugin_icon_url", "iconUrl", "icon_url"]),
  };
}

function findFirstNumberAcrossValues(
  values: unknown[],
  keys: string[]
): number | undefined {
  for (const value of values) {
    const match = findFirstNumberByKey(value, keys);
    if (match != null) {
      return match;
    }
  }
  return undefined;
}

function findFirstStringArrayAcrossValues(
  values: unknown[],
  keys: string[]
): string[] | undefined {
  for (const value of values) {
    const match = findFirstStringArrayByKey(value, keys);
    if (match?.length) {
      return match;
    }
  }
  return undefined;
}

function isGenericToolTitle(title: string | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "tool call" ||
    normalized === "tool" ||
    normalized === "function call" ||
    normalized === "function" ||
    normalized === "ran" ||
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "find" ||
    normalized === "search" ||
    normalized === "read file" ||
    normalized === "find in workspace" ||
    normalized === "grep workspace" ||
    normalized === "web search" ||
    /^todo ·/i.test(normalized) ||
    normalized === "todo list" ||
    normalized === "update todo list"
  );
}

/** `locations` on the stored event can be empty while `raw.update.locations` still has uri/path. */
function stripFileSchemePrefix(p: string): string {
  if (!/^file:\/\//i.test(p)) {
    return p;
  }
  try {
    return decodeURIComponent(p.replace(/^file:\/\//i, ""));
  } catch {
    return p.replace(/^file:\/\//i, "");
  }
}

function pathFromRawLocationItem(item: Record<string, unknown>): string | undefined {
  const keys = ["path", "filePath", "file_path", "file", "uri", "href"] as const;
  let raw: string | undefined;
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) {
      raw = v;
      break;
    }
  }
  const t = raw?.trim();
  return t ? stripFileSchemePrefix(t) : undefined;
}

const PATH_SCAVENGE_KEYS = [
  ...TOOL_PATH_STRING_KEYS,
  "workspacePath",
  "workspace_path",
  "cwd",
  "directory",
  "folder",
  "absolutePath",
  "absolute_path",
  "localPath",
  "local_path",
  "fullPath",
  "full_path",
  "source",
  "destination",
  "rootPath",
] as const;

function looksLikeFsPathString(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 4096) {
    return false;
  }
  if (/^file:/i.test(t)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) {
    return true;
  }
  if (t.includes("/") || t.includes("\\")) {
    return true;
  }
  return false;
}

function isLikelyBareFileReferenceString(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 384 || /\s/.test(t)) {
    return false;
  }
  return /^[\w./%-]+\.[A-Za-z0-9]{1,12}$/.test(t);
}

function collectPathsFromUnknown(value: unknown, depth: number, out: string[]): void {
  if (depth > 14 || out.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") && (t.includes("path") || t.includes("file"))) {
      const o = parseLooseJsonObject(t);
      if (o) {
        collectPathsFromUnknown(o, depth + 1, out);
      }
    } else if (looksLikeFsPathString(t) || isLikelyBareFileReferenceString(t)) {
      out.push(stripFileSchemePrefix(t));
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (x): x is string =>
          typeof x === "string" && x.trim().length > 0 && !x.includes("\n")
      ) &&
      value.every(
        (x) => Boolean(looksLikeFsPathString(x) || isLikelyBareFileReferenceString(x))
      )
    ) {
      for (const s of value) {
        out.push(stripFileSchemePrefix(s.trim()));
      }
      return;
    }
    for (const item of value) {
      collectPathsFromUnknown(item, depth + 1, out);
    }
    return;
  }
  const o = value as Record<string, unknown>;
  for (const key of PATH_SCAVENGE_KEYS) {
    const v = o[key];
    if (
      typeof v === "string" &&
      v.trim() &&
      (looksLikeFsPathString(v) || isLikelyBareFileReferenceString(v))
    ) {
      out.push(stripFileSchemePrefix(v.trim()));
    }
  }
  for (const v of Object.values(o)) {
    collectPathsFromUnknown(v, depth + 1, out);
  }
}

function scavengePathsFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string[] {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  if (!raw) {
    return [];
  }
  const collected: string[] = [];
  collectPathsFromUnknown(raw, 0, collected);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of collected) {
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(p);
    }
  }
  return deduped;
}

function extractPathsFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string[] | undefined {
  const raw =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const update =
    raw?.update && typeof raw.update === "object" && !Array.isArray(raw.update)
      ? (raw.update as Record<string, unknown>)
      : undefined;
  const out: string[] = [];
  const pushPath = (p: string | undefined) => {
    const t = p?.trim();
    if (t && !out.includes(t)) {
      out.push(stripFileSchemePrefix(t));
    }
  };
  const locs = update?.locations;
  if (Array.isArray(locs)) {
    for (const loc of locs) {
      if (!loc || typeof loc !== "object") {
        continue;
      }
      pushPath(pathFromRawLocationItem(loc as Record<string, unknown>));
    }
  }
  const singleLoc = update?.location;
  if (singleLoc && typeof singleLoc === "object" && !Array.isArray(singleLoc)) {
    pushPath(pathFromRawLocationItem(singleLoc as Record<string, unknown>));
  }
  pushPath(
    typeof update?.path === "string"
      ? update.path
      : typeof update?.filePath === "string"
        ? update.filePath
        : typeof update?.file_path === "string"
          ? update.file_path
          : typeof update?.target_file === "string"
            ? update.target_file
            : typeof update?.uri === "string"
              ? update.uri
              : undefined
  );
  return out.length > 0 ? out : undefined;
}

function extractPathFromToolEventRaw(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string | undefined {
  return extractPathsFromToolEventRaw(event)?.[0];
}

function pathFromPriorWorkedToolTitle(
  existing: Extract<WorkedSessionEntry, { kind: "tool" }> | undefined
): string | undefined {
  if (!existing?.title?.trim()) {
    return undefined;
  }
  const m = /^(Read|Update|Delete)\s+(.+)$/i.exec(existing.title.trim());
  const rest = m?.[2]?.trim();
  if (!rest || /^file$/i.test(rest)) {
    return undefined;
  }
  return rest;
}

function mergeWorkSessionEditPreview(
  existing: WorkedSessionEditPreview | undefined,
  incoming: WorkedSessionEditPreview | undefined
): WorkedSessionEditPreview | undefined {
  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }
  if (incoming.lines.length > existing.lines.length) {
    return incoming;
  }
  if (incoming.lines.length < existing.lines.length) {
    return existing;
  }
  const incN = (incoming.addedLines ?? 0) + (incoming.removedLines ?? 0);
  const exN = (existing.addedLines ?? 0) + (existing.removedLines ?? 0);
  return incN >= exN ? incoming : existing;
}

function burnToolRequestFromRaw(
  rawTop: Record<string, unknown> | undefined,
  rawToolRecord: Record<string, unknown> | undefined
): { name: string; args: Record<string, unknown> } | null {
  const request =
    parseLooseJsonObject(rawTop?.request) ??
    parseLooseJsonObject(rawToolRecord?.request) ??
    rawToolRecord;
  const rawName = typeof request?.name === "string" ? request.name.trim() : "";
  const normalizedName = normalizeGoalToolName(rawName);
  if (!normalizedName) {
    return null;
  }
  return {
    name: normalizedName,
    args: parseLooseJsonObject(request?.arguments) ?? parseLooseJsonObject(request?.args) ?? {},
  };
}

function countDoneItems(value: unknown): { done: number; total: number } | null {
  if (!Array.isArray(value)) {
    return null;
  }
  let done = 0;
  let total = 0;
  for (const item of value) {
    const record = parseLooseJsonObject(item);
    if (!record) {
      continue;
    }
    total += 1;
    const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
    if (status === "completed" || status === "complete" || status === "done") {
      done += 1;
    }
  }
  return total > 0 ? { done, total } : null;
}

function goalProgressPercent(args: Record<string, unknown>): string | undefined {
  const raw = args.progressPercent;
  return typeof raw === "number" && Number.isFinite(raw)
    ? `${Math.max(0, Math.min(100, Math.round(raw)))}%`
    : undefined;
}

function goalToolPresentation(
  goal: { name: string; args: Record<string, unknown> }
): { title: string; detail?: string } {
  switch (goal.name) {
    case "goal_set": {
      const summary =
        typeof goal.args.planSummary === "string" && goal.args.planSummary.trim()
          ? truncateMiddleLabel(goal.args.planSummary.trim(), 96)
          : typeof goal.args.objective === "string" && goal.args.objective.trim()
            ? truncateMiddleLabel(goal.args.objective.trim(), 96)
            : undefined;
      const milestones = countDoneItems(goal.args.milestones);
      const todos = countDoneItems(goal.args.todos);
      const evidenceCount = Array.isArray(goal.args.verificationEvidence)
        ? goal.args.verificationEvidence.length
        : 0;
      const counts = [
        milestones ? `${milestones.done}/${milestones.total} milestones` : null,
        todos ? `${todos.done}/${todos.total} todos` : null,
        evidenceCount > 0 ? `${evidenceCount} verification note${evidenceCount === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      const detail = summary ?? (counts.length > 0 ? counts.join(" · ") : undefined);
      return { title: "Set Goal", detail };
    }
    case "goal_get":
      return { title: "Read Goal", detail: "Loaded current objective, plan, and progress state" };
    case "goal_update_plan": {
      const summary =
        typeof goal.args.planSummary === "string" && goal.args.planSummary.trim()
          ? truncateMiddleLabel(goal.args.planSummary.trim(), 96)
          : undefined;
      return { title: "Record Goal plan", detail: summary };
    }
    case "goal_update_progress": {
      const milestones = countDoneItems(goal.args.milestones);
      const todos = countDoneItems(goal.args.todos);
      const evidenceCount = Array.isArray(goal.args.verificationEvidence)
        ? goal.args.verificationEvidence.length
        : 0;
      const parts = [
        milestones ? `${milestones.done}/${milestones.total} milestones` : null,
        todos ? `${todos.done}/${todos.total} todos` : null,
        evidenceCount > 0 ? `${evidenceCount} verification note${evidenceCount === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return {
        title: "Update Goal progress",
        detail: parts.length > 0 ? parts.join(" · ") : "Milestones, todos, or verification updated",
      };
    }
    case "goal_summarize":
    case "goal_summarize_state": {
      const percent = goalProgressPercent(goal.args);
      const headline =
        typeof goal.args.headline === "string" && goal.args.headline.trim()
          ? truncateMiddleLabel(goal.args.headline.trim(), 96)
          : undefined;
      return {
        title: "Summarize Goal",
        detail: [percent, headline].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "goal_complete":
      return { title: "Complete Goal", detail: "Objective marked complete after final verification" };
    case "goal_block": {
      const reason =
        typeof goal.args.reason === "string" && goal.args.reason.trim()
          ? truncateMiddleLabel(goal.args.reason.trim(), 96)
          : undefined;
      return { title: "Block Goal", detail: reason };
    }
    case "goal_pause": {
      const reason =
        typeof goal.args.reason === "string" && goal.args.reason.trim()
          ? truncateMiddleLabel(goal.args.reason.trim(), 96)
          : undefined;
      return { title: "Pause Goal", detail: reason };
    }
    case "goal_resume":
      return { title: "Resume Goal", detail: "Goal returned to active execution" };
    default:
      return { title: "Update Goal" };
  }
}

/** Stream-json `type` values that are not useful as a user-visible tool title */
const GENERIC_STREAM_TOOL_TYPES = new Set([
  "agent_message",
  "function_call",
  "function",
  "tool_call",
  "tool_use",
  "tool_result",
  "tool_output",
  "mcp_tool_use",
  "custom_tool_call",
]);

function formatToolSummary(
  event: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>,
  existing?: Extract<WorkedSessionEntry, { kind: "tool" }>,
  workspaceRoot?: string | null
): Extract<WorkedSessionEntry, { kind: "tool" }> {
  const ws = workspaceRoot ?? undefined;
  const rawUpdate = getToolRawUpdate(event);
  const rawTop =
    "raw" in event && event.raw && typeof event.raw === "object"
      ? (event.raw as Record<string, unknown>)
      : undefined;
  const workflowRunSnapshot = extractWorkflowRunSnapshotFromRaw(event.raw);
  const workflowRun = workflowRunSnapshot ?? existing?.workflowRun;
  const rawToolRecord =
    (rawUpdate &&
    (extractAcpToolCallEntries(rawUpdate).length > 0 ||
      typeof rawUpdate.type === "string" ||
      typeof rawUpdate.title === "string")
      ? rawUpdate
      : undefined) ?? rawTop;
  const rawType =
    typeof rawToolRecord?.type === "string" &&
    rawToolRecord.type &&
    rawToolRecord.type !== "agent_message"
      ? rawToolRecord.type
      : undefined;
  /** ACP often sends `rawInput` / `rawOutput` as JSON strings; parse like `getSubagentTaskInput`. */
  const rawInputRecords = [
    parseLooseJsonObject(rawUpdate?.rawInput),
    parseLooseJsonObject(rawUpdate?.raw_input),
    parseLooseJsonObject(rawTop?.rawInput),
    parseLooseJsonObject(rawTop?.raw_input),
  ].filter((value): value is Record<string, unknown> => value != null);
  const rawOutputRecords = [
    parseLooseJsonObject(rawUpdate?.rawOutput),
    parseLooseJsonObject(rawUpdate?.raw_output),
    parseLooseJsonObject(rawTop?.rawOutput),
    parseLooseJsonObject(rawTop?.raw_output),
  ].filter((value): value is Record<string, unknown> => value != null);
  const acpToolCallsBase = rawToolRecord ? extractAcpToolCallEntries(rawToolRecord) : [];
  const acpToolCallsFromWrapped = rawInputRecords.flatMap((rec) =>
    extractAcpToolCallEntries(rec)
  );
  const acpToolCalls = [...acpToolCallsBase, ...acpToolCallsFromWrapped];
  const acpToolCall = acpToolCalls[0];
  const acpToolName = acpToolCall?.rawName
    ? humanizeToolCallName(acpToolCall.rawName)
    : undefined;
  const acpToolKinds = acpToolCalls
    .map((entry) => inferToolKindFromTitle(humanizeToolCallName(entry.rawName)))
    .filter((kind) => kind !== "tool");
  const acpToolResultSuccess = acpToolCalls
    .map((entry) =>
      entry.result?.success &&
      typeof entry.result.success === "object" &&
      !Array.isArray(entry.result.success)
        ? (entry.result.success as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  const acpToolResultRejected = acpToolCalls
    .map((entry) =>
      entry.result?.rejected &&
      typeof entry.result.rejected === "object" &&
      !Array.isArray(entry.result.rejected)
        ? (entry.result.rejected as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  const rawTypeLabel =
    rawType && !GENERIC_STREAM_TOOL_TYPES.has(rawType)
      ? String(rawType).replace(/_/g, " ")
      : undefined;
  const nestedArgRecord =
    acpToolCall?.args ??
    parseLooseJsonObject(rawToolRecord?.arguments) ??
    parseLooseJsonObject(rawToolRecord?.input) ??
    parseLooseJsonObject(rawToolRecord?.args) ??
    parseLooseJsonObject(rawToolRecord?.params);
  const nestedFromFunction =
    rawToolRecord?.function && typeof rawToolRecord.function === "object"
      ? parseLooseJsonObject((rawToolRecord.function as Record<string, unknown>).arguments) ??
        parseLooseJsonObject((rawToolRecord.function as Record<string, unknown>).input)
      : undefined;
  const titleFromRaw =
    extractToolNameFromCliRaw(rawToolRecord) ??
    acpToolName ??
    (typeof rawToolRecord?.tool_name === "string" ? rawToolRecord.tool_name : undefined) ??
    (typeof rawToolRecord?.name === "string" ? rawToolRecord.name : undefined) ??
    rawTypeLabel;
  const rawTitleLabel =
    titleFromRaw != null && titleFromRaw !== ""
      ? String(titleFromRaw).replace(/[_-]/g, " ")
      : undefined;
  const acpKind = typeof rawToolRecord?.kind === "string" ? rawToolRecord.kind : undefined;
  const rawInputs = [
    ...rawInputRecords,
    ...acpToolCalls.map((entry) => entry.args),
    nestedArgRecord,
    nestedFromFunction,
    rawToolRecord,
    rawTop,
  ].filter((value): value is Record<string, unknown> => value != null);
  const rawOutputs = [
    ...rawOutputRecords,
    acpToolResultSuccess,
    acpToolResultRejected,
    ...acpToolCalls.map((entry) => entry.result),
  ].filter((value): value is Record<string, unknown> => value != null);
  const pluginMetadata = pluginMetadataFromToolEvent(
    event,
    [...rawInputs, ...rawOutputs],
    existing
  );

  const scavengedPaths = scavengePathsFromToolEventRaw(event);
  const normalizedLocations =
    event.locations
      ?.flatMap((loc) => {
        const p = typeof loc.path === "string" ? loc.path.trim() : "";
        if (!p) {
          return [];
        }
        return [{
          path: p,
          line: typeof loc.line === "number" ? loc.line : undefined,
        }];
      }) ?? existing?.locations;
  /** `locations: []` is truthy for `??` — treat empty like missing so we still scan raw / scavenger. */
  const locationPaths = normalizedLocations?.map((loc) => loc.path) ?? [];
  const editPreview = mergeWorkSessionEditPreview(existing?.editPreview, event.editPreview);
  const path =
    locationPaths[0] ??
    editPreview?.path ??
    extractPathFromToolEventRaw(event) ??
    findFirstStringAcrossValues(rawInputs, [...TOOL_PATH_STRING_KEYS]) ??
    findFirstStringAcrossValues(rawOutputs, [...TOOL_PATH_STRING_KEYS]) ??
    scavengedPaths[0] ??
    existing?.files?.[0] ??
    pathFromPriorWorkedToolTitle(existing);

  const files =
    (locationPaths.length > 0 ? locationPaths : undefined) ??
    extractPathsFromToolEventRaw(event) ??
    findFirstStringArrayAcrossValues(rawOutputs, [
      "files",
      "paths",
      "matchedFiles",
      "results",
    ]) ??
    (scavengedPaths.length > 0 ? scavengedPaths : undefined) ??
    existing?.files;

  let status = toWorkedToolStatus(event.status);
  if (acpToolResultRejected) {
    status = "failed";
  } else if (rawToolRecord?.subtype === "completed") {
    status = "completed";
  } else if (rawToolRecord?.subtype === "started" && status === "pending") {
    status = "running";
  }
  const explicitTitle = "title" in event ? event.title : undefined;
  const toolKindFromEvent = "toolKind" in event ? event.toolKind : undefined;
  const payloadToolKind = inferToolKindFromPayloadRecords([
    ...rawInputs,
    ...rawOutputs,
  ]);
  const rawKind =
    (toolKindFromEvent && toolKindFromEvent !== "tool" ? toolKindFromEvent : undefined) ??
    payloadToolKind ??
    existing?.toolKind ??
    (acpToolKinds.length === 1 ? acpToolKinds[0] : undefined) ??
    (acpToolName ? inferToolKindFromTitle(acpToolName) : undefined) ??
    (acpKind && acpKind !== "tool" ? acpKind : undefined) ??
    (titleFromRaw ? inferToolKindFromTitle(titleFromRaw) : undefined) ??
    (rawTitleLabel ? inferToolKindFromTitle(rawTitleLabel) : undefined);
  const toolKind = rawKind === "execute" ? "terminal" : rawKind;
  const resolvedTitleLabel = isGenericToolTitle(explicitTitle)
    ? rawTitleLabel
    : explicitTitle ?? rawTitleLabel;
  const streamToolTitle =
    typeof explicitTitle === "string" && explicitTitle.trim()
      ? explicitTitle.trim()
      : undefined;
  const rejectedReason = findFirstStringByKey(acpToolResultRejected, [
    "reason",
    "message",
    "error",
    "detail",
    "description",
  ]);
  const rejectedFallback =
    acpToolResultRejected &&
    typeof acpToolResultRejected === "object" &&
    !Array.isArray(acpToolResultRejected)
      ? compactJsonForRejected(acpToolResultRejected as Record<string, unknown>)
      : undefined;
  const detail =
    safeToolDetailText(event.detail) ??
    (acpToolResultRejected
      ? rejectedReason?.trim() ||
        rejectedFallback ||
        "Tool call was rejected by the current approval settings."
      : undefined);
  const rawDetail = isVerboseToolPayloadDetail(detail) ? detail?.trim() : existing?.rawDetail;
  if (workflowRun || toolKind === "workflow" || toolKindFromEvent === "workflow") {
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind: "workflow",
      title: workflowRun
        ? `Workflow ${truncateMiddleLabel(workflowRun.name, TOOL_TITLE_MAX_LEN)}`
        : truncateMiddleLabel(
            resolvedTitleLabel ?? existing?.title ?? "Workflow",
            TOOL_TITLE_MAX_LEN
          ),
      detail: workflowRun
        ? workflowSnapshotDetail(workflowRun)
        : safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      rawDetail: undefined,
      status: workflowRun ? workflowSnapshotWorkedStatus(workflowRun.status) : status,
      locations: undefined,
      editPreview: undefined,
      files: undefined,
      workflowRun,
    });
  }
  const burnTool = burnToolRequestFromRaw(rawTop, rawToolRecord);
  if (burnTool) {
    const presentation = goalToolPresentation(burnTool);
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind: "goal",
      title: presentation.title,
      detail:
        presentation.detail ??
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        existing?.detail,
      rawDetail: undefined,
      status,
      locations: undefined,
      editPreview: undefined,
      files: undefined,
    });
  }
  const command = findFirstStringAcrossValues(rawInputs, ["command", "cmd", "script"]);
  if (command) {
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind: toolKind === "tool" ? "terminal" : toolKind,
      title: `Ran ${truncateMiddleLabel(cleanTerminalCommandLabel(command), TERMINAL_TITLE_MAX)}`,
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (status === "failed" ? "Command failed" : existing?.detail),
      rawDetail,
      variant: "terminal",
      status,
      locations: undefined,
      editPreview,
      files: undefined,
    });
  }
  const likelyEdit =
    toolKind === "edit" ||
    toolKind === "write" ||
    payloadToolKind === "edit" ||
    /\b(write|edit|patch|apply|replace|str_replace|update)\b/i.test(
      `${resolvedTitleLabel ?? ""} ${titleFromRaw ?? ""}`
    );
  const likelyRead =
    !likelyEdit &&
    (toolKind === "read" ||
      payloadToolKind === "read" ||
      /\bread\b/i.test(resolvedTitleLabel ?? "") ||
      Boolean(pathFromReadLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel)) ||
      (Boolean(path) &&
        /\bread|cat|open|load|view\b/i.test(
          `${resolvedTitleLabel ?? ""} ${titleFromRaw ?? ""}`
        )));

  if (toolKind === "grep" || /\bgrep\b/i.test(acpToolName ?? "")) {
    const query =
      findFirstStringAcrossValues(rawInputs, [
        "query",
        "pattern",
        "regex",
        "search",
        "searchTerm",
        "term",
        "needle",
      ]) ??
      patternFromGrepLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const totalFiles = findFirstNumberAcrossValues(rawOutputs, [
      "totalFiles",
      "fileCount",
      "count",
    ]);
    const matchedFiles =
      findFirstStringArrayAcrossValues(rawOutputs, ["files", "matchedFiles", "results"])?.length ??
      totalFiles;
    const grepTitle = query?.trim()
      ? `Grep ${conciseQuotedSearchPattern(query)}`
      : "Grep workspace";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: grepTitle,
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (matchedFiles != null
          ? `${pluralize(matchedFiles, "file")} matched`
          : existing?.detail),
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (toolKind === "search_web") {
    const query = findFirstStringAcrossValues(rawInputs, [
      "query",
      "searchTerm",
      "term",
      "search",
    ]);
    const webTitle = query?.trim()
      ? `Web · ${truncateMiddleLabel(query.trim(), 44)}`
      : "Web search";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: webTitle,
      detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (
    toolKind === "search" ||
    explicitTitle === "Find" ||
    resolvedTitleLabel === "Find" ||
    (resolvedTitleLabel && /^find\b/i.test(resolvedTitleLabel.trim()))
  ) {
    const query =
      findFirstStringAcrossValues(rawInputs, ["globPattern"]) ??
      findFirstStringAcrossValues(rawInputs, [
        "query",
        "pattern",
        "regex",
        "search",
        "searchTerm",
        "term",
        "needle",
        "include",
      ]) ??
      queryFromFindLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const totalFiles = findFirstNumberAcrossValues(rawOutputs, [
      "totalFiles",
      "fileCount",
      "count",
    ]);
    const matchedFiles =
      findFirstStringArrayAcrossValues(rawOutputs, ["files", "matchedFiles", "results"])?.length ??
      totalFiles;
    const findTitle = query?.trim()
      ? `Find ${conciseQuotedSearchPattern(query)}`
      : "Find in workspace";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: findTitle,
      detail:
        safeToolDetailText(detail, { suppressVerbosePayload: true }) ??
        (matchedFiles != null
          ? `${pluralize(matchedFiles, "file")} matched`
          : existing?.detail),
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  if (likelyRead) {
    const safeReadDetail = safeToolDetailText(suppressPathOnlyDetail(detail), {
      suppressVerbosePayload: true,
    });
    const readPath =
      path?.trim() ||
      (files?.length === 1 && files[0]?.trim() ? files[0]!.trim() : undefined) ||
      pathFromReadLikeToolTitle(streamToolTitle, resolvedTitleLabel, rawTitleLabel);
    const readTitle = readPath
      ? `Read ${truncateMiddleLabel(
          formatToolFileLabel(readPath, ws) ?? toolPathBasename(readPath),
          TOOL_PATH_LABEL_MAX
        )}`
      : "Ran";
    let readFiles = readPath
      ? [readPath, ...(files ?? []).filter((file) => file !== readPath)]
      : files;
    if (readFiles?.length === 1 && readPath && readFiles[0] === readPath) {
      readFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: readTitle,
      detail: safeReadDetail ?? existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: readFiles,
    });
  }

  if (likelyEdit) {
    const nextTitle = path?.trim()
      ? `Update ${truncateMiddleLabel(
          formatToolFileLabel(path, ws) ?? toolPathBasename(path),
          TOOL_PATH_LABEL_MAX
        )}`
      : truncateMiddleLabel(
          resolvedTitleLabel ?? existing?.title ?? "Update file",
          TOOL_TITLE_MAX_LEN
        );
    let editFiles = path ? [path, ...(files ?? []).filter((file) => file !== path)] : files;
    if (editFiles?.length === 1 && path && editFiles[0] === path) {
      editFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: nextTitle,
      detail:
        safeToolDetailText(suppressPathOnlyDetail(detail), { suppressVerbosePayload: true }) ??
        existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: editFiles,
    });
  }

  if (toolKind === "delete") {
    const delTitle = path?.trim()
      ? `Delete ${truncateMiddleLabel(
          formatToolFileLabel(path, ws) ?? toolPathBasename(path),
          TOOL_PATH_LABEL_MAX
        )}`
      : truncateMiddleLabel(
          resolvedTitleLabel ?? existing?.title ?? "Delete file",
          TOOL_TITLE_MAX_LEN
        );
    let delFiles = path ? [path, ...(files ?? []).filter((file) => file !== path)] : files;
    if (delFiles?.length === 1 && path && delFiles[0] === path) {
      delFiles = undefined;
    }
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: delTitle,
      detail:
        safeToolDetailText(suppressPathOnlyDetail(detail), { suppressVerbosePayload: true }) ??
        existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files: delFiles,
    });
  }

  if (toolKind === "todo") {
    const todoCount = Array.isArray(rawInputs[0]?.todos)
      ? (rawInputs[0]?.todos as unknown[]).length
      : findFirstNumberAcrossValues(rawInputs, ["count", "total"]);
    const todoLabel =
      todoCount != null && todoCount > 0
        ? `Todo · ${todoCount} item${todoCount === 1 ? "" : "s"}`
        : "Todo list";
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind,
      title: todoLabel,
      detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
    });
  }

  const mcpToolName = acpToolCalls
    .map((entry) => entry.rawName)
    .find((name) => /call_mcp_tool|refresh_mcp_servers/i.test(name ?? ""));
  const isMcpTool =
    toolKind === "mcp" ||
    toolKindFromEvent === "mcp" ||
    Boolean(mcpToolName) ||
    /^MCP\s+/i.test(resolvedTitleLabel ?? "") ||
    /refresh mcp servers/i.test(resolvedTitleLabel ?? "");
  if (isMcpTool) {
    if (/refresh mcp servers/i.test(resolvedTitleLabel ?? streamToolTitle ?? "")) {
      return withConciseToolDetail({
        kind: "tool",
        toolCallId: event.toolCallId,
        toolKind: "mcp",
        title: "Refresh MCP servers",
        detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
        rawDetail,
        status,
        locations: normalizedLocations,
        editPreview,
        files,
        ...pluginMetadata,
      });
    }
    const mcpServerId =
      existing?.mcpServerId ??
      extractMcpServerIdFromRecords([
        ...rawInputs,
        rawToolRecord,
        rawTop,
        ...(rawToolRecord?.request && typeof rawToolRecord.request === "object"
          ? [rawToolRecord.request as Record<string, unknown>]
          : []),
      ]) ??
      extractMcpServerIdFromTitle(resolvedTitleLabel) ??
      extractMcpServerIdFromTitle(streamToolTitle) ??
      extractMcpServerIdFromTitle(existing?.title);
    const mcpToolNameFromTitle =
      resolvedTitleLabel?.match(/^MCP\s+.+?\s+-\s+(.+)$/i)?.[1]?.trim() ??
      findFirstStringAcrossValues(rawInputs, ["toolName", "tool_name"]) ??
      undefined;
    const mcpTitle = mcpServerId
      ? mcpToolNameFromTitle
        ? `${formatMcpServerDisplayName(mcpServerId)} · ${mcpToolNameFromTitle}`
        : formatMcpServerDisplayName(mcpServerId)
      : truncateMiddleLabel(
          resolvedTitleLabel ?? existing?.title ?? "MCP tool",
          TOOL_TITLE_MAX_LEN
        );
    return withConciseToolDetail({
      kind: "tool",
      toolCallId: event.toolCallId,
      toolKind: "mcp",
      mcpServerId,
      title: mcpTitle,
      detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
      rawDetail,
      status,
      locations: normalizedLocations,
      editPreview,
      files,
      variant: existing?.variant,
      ...pluginMetadata,
    });
  }

  return withConciseToolDetail({
    kind: "tool",
    toolCallId: event.toolCallId,
    toolKind,
    title: truncateMiddleLabel(
      resolvedTitleLabel ?? existing?.title ?? "Tool call",
      TOOL_TITLE_MAX_LEN
    ),
    detail: safeToolDetailText(detail, { suppressVerbosePayload: true }) ?? existing?.detail,
    rawDetail,
    status,
    locations: normalizedLocations,
    editPreview,
    files,
    ...pluginMetadata,
    variant: existing?.variant,
  });
}

function isConcreteAcpToolCallId(id: string | undefined): id is string {
  return Boolean(id && id.trim() && id !== "tool-call");
}

function toolCallInitialShapeSignature(
  e: Extract<AgentStoredEvent, { kind: "tool_call" | "tool_call_update" }>
): string {
  const title = typeof e.title === "string" ? e.title : "";
  const toolKind = typeof e.toolKind === "string" ? e.toolKind : "";
  const loc0 = e.locations?.[0];
  const path0 =
    loc0 && typeof loc0 === "object" && loc0 !== null
      ? String(
          (loc0 as { path?: string; filePath?: string }).path ??
            (loc0 as { path?: string; filePath?: string }).filePath ??
            ""
        )
      : "";
  const st = e.status;
  const stBucket =
    (st === "pending" || st === "in_progress" || st === ("running" as string)) ? "open" : st;
  return `${title}\0${toolKind}\0${stBucket}\0${path0}`;
}

type TrackedAcpToolReplay = {
  lastCompletedUserTurn: number;
  initialCallShape: string;
};

function stablePlanEntriesSignature(entries: AgentPlanEntry[]): string {
  const normalized = [...entries]
    .map((en) => ({
      id: en.id,
      content: en.content,
      status: en.status,
      priority: en.priority ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(normalized);
}

/**
 * ACP clients sometimes re-announce an earlier `tool_call` (same `toolCallId` + call shape) after
 * a new `user_message` with fresh `seq` / `eventId` even when the provider is not re-invoking the
 * tool. Those rows are stored in the log and the UI replays them as a fake "second wave". Drop
 * the spurious *initial* `tool_call` when that id already completed in a prior user turn and the
 * announcement matches the prior call shape.
 *
 * ACP can also re-broadcast `tool_call_update` rows alone (after stripping or skipping the replay
 * `tool_call`). The projector would otherwise synthesize fresh tool rows from those orphan updates
 * in the new turn — same counts as the prior wave. Drop updates for an id until a new `tool_call`
 * for that id appears after the latest `user_message`, when that id already finished in an earlier
 * user turn.
 *
 * The same session sync can re-emit a full `plan` (todo checklist) identical to the snapshot at the
 * previous turn boundary; the projector would stack that under the newest user bubble. Drop plans
 * whose payload exactly matches what we already had when the latest `user_message` arrived.
 */
export function stripSpuriousAcpToolCallReplays(
  events: AgentStoredEvent[]
): AgentStoredEvent[] {
  let userTurn = 0;
  const byId = new Map<string, TrackedAcpToolReplay>();
  /** Tool ids that have a retained `tool_call` since the latest `user_message`. */
  const seenToolCallSinceUserMessage = new Set<string>();
  /** Last retained `plan` fingerprint per `planId` (after replay stripping). */
  const lastOutPlanSigById = new Map<string, string>();
  /** At each `user_message`, copy of {@link lastOutPlanSigById} — identical incoming plans are replays. */
  let planReplaySuppressById = new Map<string, string>();
  const out: AgentStoredEvent[] = [];
  for (const e of events) {
    if (e.kind === "user_message") {
      userTurn += 1;
      seenToolCallSinceUserMessage.clear();
      planReplaySuppressById = new Map(lastOutPlanSigById);
      out.push(e);
      continue;
    }
    if (e.kind === "plan") {
      const sig = stablePlanEntriesSignature(e.entries);
      if (planReplaySuppressById.get(e.planId) === sig) {
        continue;
      }
      lastOutPlanSigById.set(e.planId, sig);
      out.push(e);
      continue;
    }
    if (e.kind !== "tool_call" && e.kind !== "tool_call_update") {
      out.push(e);
      continue;
    }
    if (
      (e.kind === "tool_call" || e.kind === "tool_call_update") &&
      "openCodeSubagentSessionId" in e &&
      e.openCodeSubagentSessionId
    ) {
      out.push(e);
      continue;
    }
    if (!isConcreteAcpToolCallId(e.toolCallId)) {
      out.push(e);
      continue;
    }
    const id = e.toolCallId;
    const shape = toolCallInitialShapeSignature(e);
    if (e.kind === "tool_call") {
      const t = byId.get(id);
      const st = e.status;
      if (st === "completed" || st === "failed" || st === "cancelled") {
        byId.set(id, {
          lastCompletedUserTurn: userTurn,
          initialCallShape: t?.initialCallShape ?? shape,
        });
        seenToolCallSinceUserMessage.add(id);
        out.push(e);
        continue;
      }
      if (
        t &&
        t.lastCompletedUserTurn > 0 &&
        t.lastCompletedUserTurn < userTurn &&
        t.initialCallShape === shape
      ) {
        continue;
      }
      if (!t || t.lastCompletedUserTurn < userTurn) {
        byId.set(id, {
          lastCompletedUserTurn: t?.lastCompletedUserTurn ?? 0,
          initialCallShape: shape,
        });
      }
      seenToolCallSinceUserMessage.add(id);
      out.push(e);
      continue;
    }
    const t = byId.get(id);
    if (
      !seenToolCallSinceUserMessage.has(id) &&
      t &&
      t.lastCompletedUserTurn > 0 &&
      t.lastCompletedUserTurn < userTurn
    ) {
      continue;
    }
    const terminal =
      e.status === "completed" || e.status === "failed" || e.status === "cancelled";
    if (terminal) {
      byId.set(id, {
        lastCompletedUserTurn: userTurn,
        initialCallShape: t?.initialCallShape ?? shape,
      });
    } else if (!t) {
      byId.set(id, { lastCompletedUserTurn: 0, initialCallShape: shape });
    }
    out.push(e);
  }
  return out;
}

/**
 * If the append pipeline would not retain this event after {@link stripSpuriousAcpToolCallReplays},
 * reject it so the WebSocket layer does not grow client state with ghost tools / orphan updates.
 */
export function isIncomingEventDroppedByAcpToolStrip(
  priorEvents: AgentStoredEvent[],
  incoming: AgentStoredEvent
): boolean {
  if (
    incoming.kind !== "tool_call" &&
    incoming.kind !== "tool_call_update" &&
    incoming.kind !== "plan"
  ) {
    return false;
  }
  const merged = stripSpuriousAcpToolCallReplays(
    dedupeAgentStoredEvents([...priorEvents, incoming].sort((a, b) => a.seq - b.seq))
  );
  return !merged.some((e) => e.eventId === incoming.eventId);
}

function subagentTitleQualityScore(title: string | undefined): number {
  const t = title?.trim() ?? "";
  if (!t) {
    return 0;
  }
  if (/^subagent$/i.test(t)) {
    return 1;
  }
  if (/^subagent task$/i.test(t)) {
    return 2;
  }
  return t.length + 10;
}

/**
 * Merges all subagent rows for the same `subagentId` (defensive against duplicate timeline cards).
 */
export function extractLiveSubagentTranscriptFromMessages(
  projected: ChatMessage[],
  sessionId: string
): {
  transcript: ChatMessage[];
  subagentRunning: boolean;
  title?: string;
} | null {
  const sid = sessionId.trim();
  if (!sid) {
    return null;
  }
  const mergedTranscript: ChatMessage[] = [];
  const seenRowIds = new Set<string>();
  let bestTitle: string | undefined;
  let bestScore = -1;
  let lastMatch: ChatMessage | undefined;
  for (const m of projected) {
    if (m.type !== "subagent" || m.subagentId !== sid) {
      continue;
    }
    lastMatch = m;
    const sc = subagentTitleQualityScore(m.subagentTitle);
    if (sc > bestScore) {
      bestScore = sc;
      bestTitle = m.subagentTitle;
    }
    for (const row of m.subagentTranscript ?? []) {
      if (!seenRowIds.has(row.id)) {
        mergedTranscript.push(row);
        seenRowIds.add(row.id);
      }
    }
  }
  if (bestScore < 0) {
    return null;
  }
  return {
    transcript: mergedTranscript,
    subagentRunning: lastMatch?.subagentStatus === "running",
    title: bestTitle,
  };
}

/**
 * Cache keyed by the events array's identity: the store replaces the array on
 * every change, so identity is an exact freshness signal. The previous string
 * key sampled first/mid/last events and could return stale projections when a
 * snapshot enriched payloads without touching the sampled fields. WeakMap also
 * frees entries with the arrays — no LRU bookkeeping, no retention cap to tune.
 */
const projectionCacheByEvents = new WeakMap<AgentStoredEvent[], Map<string, ChatMessage[]>>();

function projectionOptionsKey(options?: ProjectAgentEventsOptions): string {
  return `${options?.backendId ?? "none"}|${options?.workspaceRoot ?? "none"}`;
}

export function projectAgentEventsToChatMessages(
  events: AgentStoredEvent[],
  options?: ProjectAgentEventsOptions
): ChatMessage[] {
  const optionsKey = projectionOptionsKey(options);
  const cachedByOptions = projectionCacheByEvents.get(events);
  const cached = cachedByOptions?.get(optionsKey);
  if (cached) {
    return cached;
  }
  const workspaceRoot = options?.workspaceRoot;
  const ordered = stripSpuriousAcpToolCallReplays(
    dedupeAgentStoredEvents([...events].sort((a, b) => a.seq - b.seq))
  );
  const hiddenHandoffTranscriptMessageIds = new Set<string>();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (
      current?.kind === "assistant_message_end" &&
      next?.kind === "agent_handoff"
    ) {
      hiddenHandoffTranscriptMessageIds.add(current.messageId);
    }
  }

  const supersededHandoffEventIds = new Set<string>();
  const supersededTranscriptMessageIds = new Set<string>();
  let lastUserMessageSeq = -1;
  for (const event of ordered) {
    if (event.kind === "user_message" && event.seq > lastUserMessageSeq) {
      lastUserMessageSeq = event.seq;
    }
  }
  const trailingHandoffs: Array<{
    handoff: Extract<AgentStoredEvent, { kind: "agent_handoff" }>;
    transcriptMessageId: string | null;
  }> = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event.kind === "agent_handoff" && event.seq > lastUserMessageSeq) {
      let transcriptMessageId: string | null = null;
      for (let j = index - 1; j >= 0; j -= 1) {
        const prev = ordered[j];
        if (
          prev.kind === "assistant_message_end" &&
          prev.seq > lastUserMessageSeq &&
          hiddenHandoffTranscriptMessageIds.has(prev.messageId)
        ) {
          transcriptMessageId = prev.messageId;
          break;
        }
        if (prev.kind === "user_message" || prev.seq <= lastUserMessageSeq) {
          break;
        }
      }
      trailingHandoffs.unshift({ handoff: event, transcriptMessageId });
    } else {
      break;
    }
  }
  if (trailingHandoffs.length > 1) {
    for (let i = 0; i < trailingHandoffs.length - 1; i += 1) {
      const { handoff, transcriptMessageId } = trailingHandoffs[i];
      supersededHandoffEventIds.add(handoff.eventId);
      if (transcriptMessageId) {
        supersededTranscriptMessageIds.add(transcriptMessageId);
      }
    }
  }
  const pendingHandoffEvent =
    trailingHandoffs.length > 0
      ? trailingHandoffs[trailingHandoffs.length - 1].handoff
      : null;
const turns: ProjectedTurn[] = [];
let currentTurn: ProjectedTurn | null = null;

  const ensureTurn = () => {
    if (!currentTurn) {
      currentTurn = createTurn(`synthetic-${turns.length + 1}`);
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const event of ordered) {
    try {
    switch (event.kind) {
    case "user_message": {
      if (event.hidden) {
        break;
      }
      const prev = currentTurn;
      currentTurn = createTurn(event.messageId);
      const bubbleText = event.displayContent ?? event.content;
        currentTurn.userMessage = {
          id: event.messageId,
          type: "user",
          content: bubbleText,
          rawContent: event.content,
          segments: parseUserMessageSegments(bubbleText),
          showReplyCue: true,
          attachments: event.attachments,
        };
        currentTurn.turnStartedAt = event.createdAt;
        currentTurn.turnCompletedAt = undefined;
        if (
          prev &&
          prev.id.startsWith("synthetic-") &&
          !prev.userMessage &&
          prev.timeline.length > 0
        ) {
          currentTurn.trace = prev.trace;
          currentTurn.timeline = prev.timeline;
          currentTurn.toolEntryById = prev.toolEntryById;
          currentTurn.orphanToolUpdateSlot = prev.orphanToolUpdateSlot;
          currentTurn.assistantMessageId = prev.assistantMessageId;
          currentTurn.endedAssistantMessageIds = new Set(prev.endedAssistantMessageIds);
          currentTurn.turnEndedWithFailure = prev.turnEndedWithFailure;
          currentTurn.turnSettled = prev.turnSettled;
          currentTurn.takingLonger = prev.takingLonger;
          currentTurn.compressingContext = prev.compressingContext;
          currentTurn.permissionCards = prev.permissionCards;
          currentTurn.todoCards = prev.todoCards;
          currentTurn.subagentCards = prev.subagentCards;
          currentTurn.openCodeSpawnToolBySessionId = new Map(prev.openCodeSpawnToolBySessionId);
          currentTurn.openCodeUnlinkedSpawnQueue = [...prev.openCodeUnlinkedSpawnQueue];
          currentTurn.openCodeOrphanSseSessionOrder = [...prev.openCodeOrphanSseSessionOrder];
          const prevIdx = turns.indexOf(prev);
          if (prevIdx >= 0) {
            turns.splice(prevIdx, 1);
          }
        }
        turns.push(currentTurn);
        break;
      }
      case "assistant_message_chunk": {
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        if (supersededTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        const ocSub = OPENCODE_SUBAGENT_ASSISTANT_CHUNK.exec(event.messageId);
        if (ocSub) {
          const turn = ensureTurn();
          appendSubagentOpenCodeAssistantChunk(turn, ocSub[1]!, ocSub[2]!, event.text);
          break;
        }
        const turn = ensureTurn();
        appendAssistantChunk(turn, event.text, event.messageId);
        break;
      }
      case "assistant_message_end": {
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        if (supersededTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        const turn = ensureTurn();
        const hasAssistantText = turn.timeline.some(
          (item) => item.kind === "assistant" && item.text.trim().length > 0
        );
        if (!hasAssistantText && event.stopReason === "failed") {
          appendAssistantChunk(
            turn,
            "The provider ended the turn without returning any visible text.",
            event.messageId
          );
        }
        turn.endedAssistantMessageIds.add(event.messageId);
        finalizeOpenToolsInTurn(turn, event.stopReason === "failed" ? "failed" : "completed");
        break;
      }
      case "reasoning": {
        const turn = ensureTurn();
        appendTraceEntry(turn, {
          kind: "reasoning",
          text: event.text,
        });
        break;
      }
      case "compression_summary": {
        const turn = ensureTurn();
        turn.compressingContext = false;
        appendTraceEntry(turn, {
          kind: "compression",
          summary: event.summary,
          retainedTurnCount: event.retainedTurnCount,
          compressedTurnCount: event.compressedTurnCount,
        });
        break;
      }
      case "question": {
        const turn = ensureTurn();
        appendTimelineMessage(turn, questionEventToChatMessage(event));
        break;
      }
      case "subagent": {
        const turn = ensureTurn();
        const transcript = event.transcript?.length
          ? projectAgentEventsToChatMessages(event.transcript, {
              ...options,
              backendId: options?.backendId,
            })
          : [];
        const nextMessage = {
          id: `subagent-${event.subagentId}`,
          type: "subagent",
          subagentId: event.subagentId,
          subagentTitle: event.title,
          subagentMeta: event.meta,
          subagentStatus: event.status,
          subagentComplete: event.status !== "running",
          subagentTranscript: transcript,
          recentActivity: event.recentActivity,
        } satisfies ChatMessage;
        const existing = findSubagentMessageBySessionId(turn, [event.subagentId]);
        if (existing) {
          mergeSubagentCard(existing, nextMessage);
          turn.subagentCards.set(event.subagentId, existing);
        } else {
          turn.subagentCards.set(event.subagentId, nextMessage);
          appendTimelineMessage(turn, nextMessage);
        }
        break;
      }
      case "tool_call": {
        const turn = ensureTurn();
        if (
          isOpenCodeBackendId(options?.backendId) &&
          event.openCodeSubagentSessionId &&
          event.openCodeSubagentSessionId.trim()
        ) {
          mergeOpenCodeSubagentToolIntoTranscript(turn, event, options?.workspaceRoot ?? workspaceRoot);
          break;
        }
        if (classifyToolCallAsSubagentCard(options?.backendId, event)) {
          const rawInput = getSubagentTaskInput(event);
          const taskText = extractSubagentTaskText(event);
          const sessionIds = extractSubagentSessionIds(event);
          const codexBackend = isCodexBackendId(options?.backendId);
          const codexStates =
            codexBackend ? extractCodexSubagentStates(event) : [];
          const codexTool = codexBackend ? codexCollabToolName(event) : null;
          if (codexBackend && codexTool === "wait" && codexStates.length === 0) {
            break;
          }
          if (codexBackend && codexStates.length > 0) {
            const fallbackTitle =
              (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
              (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
              "Subagent task";
            for (const state of codexStates) {
              const existingMessage =
                (codexTool === "spawn_agent" ? turn.subagentCards.get(event.toolCallId) : undefined) ??
                findSubagentMessageBySessionId(turn, [state.sessionId]);
              const message =
                existingMessage ??
                ({
                  id: `subagent-${state.sessionId}`,
                  type: "subagent",
                  subagentId: state.sessionId,
                } satisfies ChatMessage);
              const baseTranscript =
                message.subagentTranscript?.length
                  ? message.subagentTranscript
                  : buildSubagentTranscriptFromTaskEvent(event, fallbackTitle);
              const transcript = state.message
                ? [...baseTranscript, ...parseSubagentResultMessages(state.message, state.sessionId)]
                : baseTranscript;
              message.subagentId = state.sessionId;
              message.subagentTitle = message.subagentTitle ?? fallbackTitle;
              message.subagentMeta = undefined;
              message.subagentStatus = codexStateStatusToSubagentStatus(state.status);
              message.subagentComplete = message.subagentStatus !== "running";
              message.subagentTranscript = transcript;
              message.recentActivity = buildSubagentRecentActivity(transcript, state.message);
              if (!existingMessage) {
                turn.subagentCards.set(
                  codexTool === "spawn_agent" ? event.toolCallId : `${event.toolCallId}:${state.sessionId}`,
                  message
                );
                appendTimelineMessage(turn, message);
              }
            }
            break;
          }
          const title =
            (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
            (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
            (typeof event.title === "string" && event.title.trim() && event.title.trim().toLowerCase() !== "task"
              ? event.title.trim()
              : undefined) ||
            "Subagent task";
          const transcript = buildSubagentTranscriptFromTaskEvent(event, title);
          const existingMessage =
            findSubagentMessageBySessionId(turn, sessionIds) ?? turn.subagentCards.get(event.toolCallId);
          const message =
            existingMessage ??
            ({
              id: `subagent-${event.toolCallId}`,
              type: "subagent",
              subagentId: taskText.sessionId ?? taskText.taskId ?? event.toolCallId,
            } satisfies ChatMessage);
          message.subagentId = taskText.sessionId ?? taskText.taskId ?? event.toolCallId;
          message.subagentTitle = title;
          message.subagentMeta = undefined;
          message.subagentStatus =
            codexSubagentRuntimeStatus(event) ?? subagentStatusFromToolEventStatus(event.status);
          message.subagentComplete = message.subagentStatus !== "running";
          message.subagentTranscript = transcript;
          message.recentActivity = buildSubagentRecentActivity(
            transcript,
            (typeof rawInput?.description === "string" ? rawInput.description : undefined) ??
              (typeof rawInput?.prompt === "string" ? rawInput.prompt : undefined)
          );
          if (!existingMessage) {
            turn.subagentCards.set(event.toolCallId, message);
            appendTimelineMessage(turn, message);
          } else {
            turn.subagentCards.set(event.toolCallId, message);
          }
          if (isOpenCodeBackendId(options?.backendId)) {
            const wireSes = taskText.sessionId?.trim();
            if (wireSes && isOpenCodeWireSessionId(wireSes)) {
              linkOpenCodeSpawnToSession(turn, event.toolCallId, wireSes, message);
            } else if (
              !existingMessage &&
              !tryAttachOrphanOpenCodeSseToNewSpawn(turn, event.toolCallId, message)
            ) {
              registerOpenCodeUnlinkedSpawn(turn, event.toolCallId);
            }
          }
          break;
        }
        const existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const entry = formatToolSummary(event, existing, workspaceRoot);
        if (!existing) {
          appendTraceEntry(turn, entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          Object.assign(existing, entry);
        }
        break;
      }
      case "tool_call_update": {
        const turn = ensureTurn();
        if (
          isOpenCodeBackendId(options?.backendId) &&
          event.openCodeSubagentSessionId &&
          event.openCodeSubagentSessionId.trim()
        ) {
          mergeOpenCodeSubagentToolIntoTranscript(turn, event, options?.workspaceRoot ?? workspaceRoot);
          break;
        }
        if (classifyToolCallAsSubagentCard(options?.backendId, event)) {
          const rawInput = getSubagentTaskInput(event);
          const taskText = extractSubagentTaskText(event);
          const sessionIds = extractSubagentSessionIds(event);
          const codexBackend = isCodexBackendId(options?.backendId);
          const codexStates =
            codexBackend ? extractCodexSubagentStates(event) : [];
          const codexTool = codexBackend ? codexCollabToolName(event) : null;
          if (codexBackend && codexTool === "wait" && codexStates.length === 0) {
            break;
          }
          if (codexBackend && codexStates.length > 0) {
            const fallbackTitle =
              (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
              (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
              "Subagent task";
            for (const state of codexStates) {
              const existingMessage =
                (codexTool === "spawn_agent" ? turn.subagentCards.get(event.toolCallId) : undefined) ??
                findSubagentMessageBySessionId(turn, [state.sessionId]);
              const message =
                existingMessage ??
                ({
                  id: `subagent-${state.sessionId}`,
                  type: "subagent",
                  subagentId: state.sessionId,
                } satisfies ChatMessage);
              const baseTranscript =
                message.subagentTranscript?.length
                  ? message.subagentTranscript
                  : buildSubagentTranscriptFromTaskEvent(event, fallbackTitle);
              const transcript = state.message
                ? [...baseTranscript, ...parseSubagentResultMessages(state.message, state.sessionId)]
                : baseTranscript;
              message.subagentId = state.sessionId;
              message.subagentTitle = message.subagentTitle ?? fallbackTitle;
              message.subagentMeta = undefined;
              message.subagentStatus = codexStateStatusToSubagentStatus(state.status);
              message.subagentComplete = message.subagentStatus !== "running";
              message.subagentTranscript = transcript;
              message.recentActivity = buildSubagentRecentActivity(transcript, state.message);
              if (!existingMessage) {
                turn.subagentCards.set(
                  codexTool === "spawn_agent" ? event.toolCallId : `${event.toolCallId}:${state.sessionId}`,
                  message
                );
                appendTimelineMessage(turn, message);
              }
            }
            break;
          }
          const title =
            (typeof rawInput?.description === "string" && rawInput.description.trim()) ||
            (typeof rawInput?.prompt === "string" && rawInput.prompt.trim()) ||
            (typeof event.title === "string" && event.title.trim() && event.title.trim().toLowerCase() !== "task"
              ? event.title.trim()
              : undefined) ||
            "Subagent task";
          const transcript = buildSubagentTranscriptFromTaskEvent(event, title);
          const existingMessage =
            findSubagentMessageBySessionId(turn, sessionIds) ?? turn.subagentCards.get(event.toolCallId);
          const message =
            existingMessage ??
            ({
              id: `subagent-${event.toolCallId}`,
              type: "subagent",
              subagentId: taskText.sessionId ?? taskText.taskId ?? event.toolCallId,
            } satisfies ChatMessage);
          message.subagentId = taskText.sessionId ?? taskText.taskId ?? event.toolCallId;
          message.subagentTitle = title;
          message.subagentStatus =
            codexSubagentRuntimeStatus(event) ?? subagentStatusFromToolEventStatus(event.status);
          message.subagentComplete = message.subagentStatus !== "running";
          message.subagentMeta = undefined;
          message.subagentTranscript = transcript;
          message.recentActivity = buildSubagentRecentActivity(
            transcript,
            taskText.resultText ??
              (typeof rawInput?.description === "string" ? rawInput.description : undefined) ??
              (typeof rawInput?.prompt === "string" ? rawInput.prompt : undefined)
          );
          if (!existingMessage) {
            turn.subagentCards.set(event.toolCallId, message);
            appendTimelineMessage(turn, message);
          } else {
            turn.subagentCards.set(event.toolCallId, message);
          }
          if (isOpenCodeBackendId(options?.backendId)) {
            const wireSes = taskText.sessionId?.trim();
            if (wireSes && isOpenCodeWireSessionId(wireSes)) {
              linkOpenCodeSpawnToSession(turn, event.toolCallId, wireSes, message);
            } else if (
              !existingMessage &&
              !tryAttachOrphanOpenCodeSseToNewSpawn(turn, event.toolCallId, message)
            ) {
              registerOpenCodeUnlinkedSpawn(turn, event.toolCallId);
            }
          }
          break;
        }
        let existing = turn.toolEntryById.get(event.toolCallId) as
          | Extract<WorkedSessionEntry, { kind: "tool" }>
          | undefined;
        const unmatchedEntry = !existing ? formatToolSummary(event, undefined, workspaceRoot) : undefined;
        if (!existing) {
          const open = turn.trace.filter(
            (e): e is Extract<WorkedSessionEntry, { kind: "tool" }> =>
              e.kind === "tool" &&
              (e.status === "pending" || e.status === "running")
          );
          const terminalOrphan =
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled";
          const previewPath = unmatchedEntry?.files?.[0];
          const previewKind = unmatchedEntry?.toolKind;
          const previewTitle = unmatchedEntry?.title;
          const matchedByPath =
            previewPath != null
              ? open.find(
                  (entry) =>
                    entry.files?.includes(previewPath) &&
                    (!previewKind || !entry.toolKind || entry.toolKind === previewKind)
                )
              : undefined;
          const matchedByKindAndTitle =
            !matchedByPath && previewKind && previewTitle
              ? open.find(
                  (entry) =>
                    entry.toolKind === previewKind &&
                    entry.title === previewTitle
                )
              : undefined;
          if (matchedByPath || matchedByKindAndTitle) {
            existing = (matchedByPath ?? matchedByKindAndTitle)!;
            if (existing.toolCallId) {
              turn.toolEntryById.set(existing.toolCallId, existing);
            }
            turn.toolEntryById.set(event.toolCallId, existing);
          } else if (open.length >= 1) {
            const idx = terminalOrphan
              ? Math.min(turn.orphanToolUpdateSlot, open.length - 1)
              : 0;
            existing = open[idx];
            if (terminalOrphan) {
              turn.orphanToolUpdateSlot += 1;
            }
            if (existing.toolCallId) {
              turn.toolEntryById.set(existing.toolCallId, existing);
            }
            turn.toolEntryById.set(event.toolCallId, existing);
          }
        }
        const entry = existing
          ? formatToolSummary(event, existing, workspaceRoot)
          : unmatchedEntry ?? formatToolSummary(event, undefined, workspaceRoot);
        if (!existing) {
          appendTraceEntry(turn, entry);
          turn.toolEntryById.set(event.toolCallId, entry);
        } else {
          const keepToolCallId = existing.toolCallId;
          Object.assign(existing, entry);
          if (keepToolCallId) {
            existing.toolCallId = keepToolCallId;
          }
        }
        break;
      }
      case "plan": {
        const todos = toTodoItems(event.entries);
        const turn = ensureTurn();
        const existingCard = turn.todoCards.get(event.planId);
        const message: ChatMessage =
          existingCard ??
          {
            id: event.planId,
            type: "todo",
            todos: [],
            todoLabel: "0 of 0 Done",
          };
        message.todos = todos;
        message.todoLabel = summarizeTodoLabel(event.entries);
        if (!turn.todoCards.has(event.planId)) {
          turn.todoCards.set(event.planId, message);
          appendTimelineMessage(turn, message);
        }
        break;
      }
      case "plan_file":
        break;
      case "permission_request": {
        const id = `permission-${event.requestId}`;
        const turn = ensureTurn();
        const message: ChatMessage =
          turn.permissionCards.get(id) ??
          {
            id,
            type: "permission-request",
            permissionRequestId: event.requestId,
          };
        message.permissionRequestId = event.requestId;
        message.permissionTitle = event.title ?? "Permission required";
        const toolEntry = event.toolCallId
          ? (turn.toolEntryById.get(event.toolCallId) as
              | Extract<WorkedSessionEntry, { kind: "tool" }>
              | undefined)
          : undefined;
        const fromTool =
          toolEntry?.title && toolEntry.title !== message.permissionTitle
            ? toolEntry.title
            : event.toolCallId
              ? `Tool call: ${event.toolCallId}`
              : undefined;
        message.permissionDetail =
          event.detail?.trim() ||
          fromTool ||
          undefined;
        message.permissionOptions = agentPermissionOptionsToUiChoices(event.options);
        if (!message.permissionResolved) {
          message.permissionResolved = false;
          message.permissionSelectedOptionId = undefined;
        }
        message.permissionLinkedToolCallId = event.toolCallId;
        if (!turn.permissionCards.has(id)) {
          turn.permissionCards.set(id, message);
          appendTimelineMessage(turn, message);
        }
        break;
      }
      case "permission_resolved": {
        const id = `permission-${event.requestId}`;
        const turn = ensureTurn();
        const message = turn.permissionCards.get(id);
        if (message) {
          message.permissionResolved = true;
          message.permissionSelectedOptionId = event.optionId;
        }
        break;
      }
      case "system": {
        if (
          event.level === "warning" &&
          /\[Codex App Server\].*codex_core::(?:exec|tools::router):/i.test(event.text)
        ) {
          break;
        }
        const turn = ensureTurn();
        if (event.level === "error" && isCompletionFailureThreadContent(event.text)) {
          break;
        }
        appendTimelineMessage(turn, {
          id: event.eventId,
          type: "assistant",
          content:
            event.level === "error"
              ? event.text
              : event.level === "warning"
              ? event.text
              : event.level === "info"
                ? event.text
                : `[${event.level}] ${event.text}`,
        });
        break;
      }
      case "status": {
        if (event.status === "failed" || event.status === "cancelled") {
          const turn = ensureTurn();
          turn.turnEndedWithFailure = true;
          turn.turnSettled = true;
          turn.turnCompletedAt = event.createdAt;
          finalizeOpenToolsInTurn(turn, event.status);
        } else if (event.status === "idle") {
          const turn = ensureTurn();
          turn.turnSettled = true;
          turn.turnCompletedAt = event.createdAt;
          turn.takingLonger = false;
          turn.compressingContext = false;
          finalizeOpenToolsInTurn(turn, "completed");
        }
        if (
          event.status === "running" ||
          event.status === "idle" ||
          event.status === "awaiting_permission"
        ) {
          if (event.status === "running" && isTakingLongerStatusDetail(event.detail)) {
            ensureTurn().takingLonger = true;
          }
          if (event.status === "running" && isCompressingContextStatusDetail(event.detail)) {
            ensureTurn().compressingContext = true;
          }
          break;
        }
        if (event.status === "failed") {
          break;
        }
        if (event.status === "cancelled") {
          break;
        }
        appendTimelineMessage(ensureTurn(), {
          id: event.eventId,
          type: "activity-label",
          activityLabel: event.status[0].toUpperCase() + event.status.slice(1),
          activityDetail: event.detail,
        });
        break;
      }
      case "agent_handoff": {
        if (supersededHandoffEventIds.has(event.eventId)) {
          break;
        }
        const turn = ensureTurn();
        turn.handoffMessageId = event.handoffMessageId;
        const isPending = pendingHandoffEvent?.eventId === event.eventId;
        const message: ChatMessage = {
          id: isPending ? "handoff-pending" : event.eventId,
          type: "agent-handoff",
          handoffFromAgent: event.fromAgent,
          handoffToAgent: event.toAgent,
          handoffTurnCount: event.turnCount,
          handoffToolCallCount: event.toolCallCount,
        };
        appendTimelineMessage(turn, message);
        break;
      }
    case "chat_fork": {
      const turn = ensureTurn();
      const message: ChatMessage = {
        id: event.eventId,
        type: "chat-fork",
        forkFromAgent: event.fromAgent,
        forkFromConversationId: event.fromConversationId,
      };
      appendTimelineMessage(turn, message);
      break;
    }
    default:
        break;
    }
    } catch {
      // Skip events that cause rendering errors
    }
  }

const messages: ChatMessage[] = [];
for (const turn of turns) {
  const timelineMsgs = appendTurnCompletionFooter(
    turn,
    projectTurnTimelineToMessages(turn)
  );
  const forkInTimeline = timelineMsgs.filter((m) => m.type === "chat-fork");
  const otherTimeline = timelineMsgs.filter((m) => m.type !== "chat-fork");
  if (turn.userMessage) {
    for (const forkMsg of forkInTimeline) {
      messages.push(forkMsg);
    }
    if (turn.handoffMessageId && turn.userMessage.id === turn.handoffMessageId) {
      messages.push({ ...turn.userMessage, isHandoffMessage: true });
    } else {
      messages.push(turn.userMessage);
    }
    messages.push(...otherTimeline);
  } else {
    messages.push(...forkInTimeline, ...otherTimeline);
  }
}
  const dockedMessages = dockActiveTodoUnderLatestUser(messages);
  const byOptions = projectionCacheByEvents.get(events) ?? new Map<string, ChatMessage[]>();
  byOptions.set(optionsKey, dockedMessages);
  projectionCacheByEvents.set(events, byOptions);
  return dockedMessages;
}

export function getConversationLatestSeq(
  events: AgentStoredEvent[]
): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

/**
 * Newest-first list of the user's own past message text for the composer's
 * up/down arrow history recall. Each entry is the raw `content` (what would
 * actually be sent to the model) so resurrecting it into the composer and
 * submitting yields the same prompt. Duplicates of consecutive identical
 * messages are collapsed so users aren't forced to hit Up twice to skip a
 * double-send.
 *
 * Callers may need to load older history pages (see
 * `loadOlderConversationHistory`) to expand the window — this helper only
 * projects whatever events are currently loaded.
 */
export function extractComposerUserMessageHistory(
  events: AgentStoredEvent[]
): string[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const newestFirst: string[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const event = sorted[i]!;
    if (event.kind !== "user_message") {
      continue;
    }
    const content = event.content ?? "";
    if (!content.trim()) {
      continue;
    }
    if (newestFirst[newestFirst.length - 1] === content) {
      continue;
    }
    newestFirst.push(content);
  }
  return newestFirst;
}

/**
 * Drop duplicate rows that can appear when the same logical event is replayed
 * twice (e.g. overlapping subscribe/replay + live push) or stored with conflicting
 * seq/eventId pairs. Keeps the first occurrence in seq order.
 */
export function dedupeAgentStoredEvents(
  events: AgentStoredEvent[]
): AgentStoredEvent[] {
  if (events.length <= 1) {
    return events;
  }
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map<number, AgentStoredEvent>();
  for (const e of sorted) {
    if (!bySeq.has(e.seq)) {
      bySeq.set(e.seq, e);
    }
  }
  const seqDeduped = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const seenEventIds = new Set<string>();
  const out: AgentStoredEvent[] = [];
  for (const e of seqDeduped) {
    if (seenEventIds.has(e.eventId)) {
      continue;
    }
    seenEventIds.add(e.eventId);
    out.push(e);
  }
  return out;
}

function normalizeModelDetailLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  return normalized === "xhigh" ? "extra high" : normalized;
}

function titleCaseModelDetail(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "xhigh") {
    return "Extra High";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveThoughtOptionsForModel(
  modelOptionValue: NonNullable<ReturnType<typeof findConversationModelConfigOption>>["options"][number],
  thoughtLevelOption: NonNullable<ReturnType<typeof findConfigOptionByCategory>>
) {
  const supported = Array.isArray(modelOptionValue.metadata?.reasoningLevels)
    ? modelOptionValue.metadata?.reasoningLevels
    : null;
  if (!supported || supported.length === 0) {
    return [];
  }
  return thoughtLevelOption.options.filter((option) => supported.includes(option.value));
}

function formatModelVariantDetailLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "xhigh") {
    return "Extra High";
  }
  if (normalized === "extra high" || normalized === "extra-high") {
    return "Extra High";
  }
  if (normalized === "medium") {
    return "Medium";
  }
  if (normalized === "high") {
    return "High";
  }
  if (normalized === "low") {
    return "Low";
  }
  if (normalized === "fast") {
    return "Fast";
  }
  if (normalized === "thinking") {
    return "Thinking";
  }
  if (normalized === "max") {
    return "Max";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function cleanModelVariantBaseName(name: string): string {
  return name.replace(/\s*\(([^)]*)\)\s*$/g, (_match, inner: string) => {
    const parts = inner
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0 && parts.every(isCursorSdkStyleTuplePart)) {
      return "";
    }
    return ` (${inner})`;
  }).trim();
}

function isCursorSdkStyleTuplePart(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "none" ||
    normalized === "default" ||
    normalized === "auto" ||
    normalized === "false" ||
    /^\d+\s*k$/i.test(value.trim()) ||
    [
      "low",
      "medium",
      "high",
      "xhigh",
      "extra high",
      "extra-high",
      "fast",
      "max",
      "thinking",
    ].includes(normalized)
  );
}

function cursorSdkStyleVariantDetailLabel(key: string, value: string): string | null {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "none" ||
    normalizedValue === "default" ||
    normalizedValue === "auto" ||
    normalizedValue === "false"
  ) {
    return null;
  }
  if (/context|length|window|token/.test(normalizedKey) || /^\d+\s*k$/i.test(value.trim())) {
    return null;
  }
  if (/speed|fast/.test(normalizedKey)) {
    return normalizedValue === "fast" || normalizedValue === "true"
      ? "Fast"
      : formatModelVariantDetailLabel(value);
  }
  if (/thinking|reason|effort/.test(normalizedKey)) {
    return formatModelVariantDetailLabel(value);
  }
  if (
    ["low", "medium", "high", "xhigh", "extra-high", "extra high", "fast", "max", "thinking"]
      .includes(normalizedValue)
  ) {
    return formatModelVariantDetailLabel(value);
  }
  return null;
}

function formatModelVariantLabel(name: string, modelId: string): string {
  const trimmedName = cleanModelVariantBaseName(name.trim() || modelId.trim() || "Model");
  const normalizedName = trimmedName.toLowerCase();
  const details: string[] = [];

  const bracketMatch = /^(.*)\[(.*)\]$/.exec(modelId.trim());
  if (bracketMatch) {
    for (const rawEntry of bracketMatch[2].split(",")) {
      const [rawKey, rawValue] = rawEntry.split("=");
      const key = rawKey?.trim().toLowerCase();
      const value = rawValue?.trim();
      if (!key || !value) {
        continue;
      }
      const label = cursorSdkStyleVariantDetailLabel(key, value);
      if (label) details.push(label);
    }
  } else {
    const slashVariant = modelId.trim().split("/").at(-1)?.trim().toLowerCase();
    if (
      slashVariant &&
      ["low", "medium", "high", "xhigh", "thinking", "fast", "max"].includes(slashVariant)
    ) {
      details.push(slashVariant);
    }
  }

  const uniqueDetails = details.filter((detail, index, array) => {
    const normalized = normalizeModelDetailLabel(detail);
    return (
      !normalizedName.includes(normalized) &&
      array.findIndex((candidate) => normalizeModelDetailLabel(candidate) === normalized) ===
        index
    );
  });

  const detailLabels = uniqueDetails.map(formatModelVariantDetailLabel);

  return detailLabels.length > 0 ? `${trimmedName} ${detailLabels.join(" ")}` : trimmedName;
}

export function buildConversationModelOptions(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[],
  modelVisibility?: Record<string, Array<{ id: string; name: string; on: boolean }>>
): ModelInfo[] {
  const backend =
    backends.find((candidate) => candidate.id === conversation.config.backendId) ??
    backends[0];
  const provider = modelProviderForBackend(conversation.config.backendId);
  const modelOption = findConversationModelConfigOption(conversation, backends);
  const thoughtLevelOption = findConfigOptionByCategory(
    conversation,
    backends,
    "thought_level"
  );

  const backendToggles = modelVisibility?.[conversation.config.backendId];
  const catalogOptionCount = modelOption?.options.length ?? 0;
  const stalePlaceholderToggles =
    (conversation.config.backendId === "pi-agent" ||
      isOpenCodeBackendId(conversation.config.backendId)) &&
    (backendToggles?.length ?? 0) === 1 &&
    backendToggles?.[0]?.id.trim().toLowerCase() === "auto" &&
    catalogOptionCount > 1;
  const hasAuthoritativeToggleList =
    (backendToggles?.length ?? 0) > 0 && !stalePlaceholderToggles;
  const toggleById = hasAuthoritativeToggleList
    ? new Map(backendToggles!.map((t) => [t.id, t]))
    : null;

  const hiddenModelIds = new Set<string>();
  if (modelVisibility && !hasAuthoritativeToggleList) {
    const forBackend = modelVisibility[conversation.config.backendId];
    if (forBackend) {
      for (const toggle of forBackend) {
        if (!toggle.on) {
          hiddenModelIds.add(toggle.id);
        }
      }
    }
  }

  const selectedModelValue =
    conversation.config.modelId ||
    modelOption?.currentValue ||
    backend?.defaultModelId ||
    "auto";
  /** Prefer persisted `config.modelId` so UI matches PATCH updates; option `currentValue` can lag when no runtime session. */
  const effectiveSelectedId =
    conversation.config.modelId || modelOption?.currentValue || backend?.defaultModelId;
  const selectedName = conversation.config.modelName || backend?.defaultModelName;

  function filterVisible<T extends ModelInfo>(rows: T[]): T[] {
    if (hasAuthoritativeToggleList && toggleById) {
      return rows.filter((m) => {
        const mv = m.modelValue ?? m.id;
        if (mv === selectedModelValue) {
          return true;
        }
        const t = toggleById.get(mv);
        if (t) {
          return t.on;
        }
        /** Catalog has an id that is not in the server toggle list (e.g. stale options); do not show it. */
        return false;
      });
    }
    if (hiddenModelIds.size === 0) {
      return rows;
    }
    return rows.filter((m) => {
      const mv = m.modelValue ?? m.id;
      if (mv === selectedModelValue) {
        return true;
      }
      return !hiddenModelIds.has(mv);
    });
  }

  if (!modelOption || modelOption.options.length === 0) {
    return filterVisible([
      {
        id: conversation.config.modelId || backend?.defaultModelId || "auto",
        modelValue: conversation.config.modelId || backend?.defaultModelId || "auto",
        name: formatModelVariantLabel(
          conversation.config.modelName || backend?.defaultModelName || "Auto",
          conversation.config.modelId || backend?.defaultModelId || "auto"
        ),
        provider,
        backendId: conversation.config.backendId,
        selected: true,
      },
    ]);
  }

  if (thoughtLevelOption && thoughtLevelOption.options.length > 0) {
    const selectedThought = thoughtLevelOption.currentValue;
    const variantRows = modelOption.options.flatMap((option) =>
      resolveThoughtOptionsForModel(option, thoughtLevelOption).map((thought) => {
        const baseName = formatModelVariantLabel(option.name, option.value);
        const thoughtLabel = titleCaseModelDetail(thought.name || thought.value);
        const normalizedThought = normalizeModelDetailLabel(thoughtLabel);
        const name = baseName.toLowerCase().includes(normalizedThought)
          ? baseName
          : `${baseName} ${thoughtLabel}`;
        return {
          id: `${option.value}::${thoughtLevelOption.id}::${thought.value}`,
          modelValue: option.value,
          name,
          description: option.description,
          detail: `${backend?.label ?? conversation.config.backendId} · ${thoughtLevelOption.name}: ${thoughtLabel}`,
          provider,
          backendId: conversation.config.backendId,
          configSelections: [{ configId: thoughtLevelOption.id, value: thought.value }],
          selected:
            option.value === effectiveSelectedId &&
            (!selectedThought || thought.value === selectedThought),
        } satisfies ModelInfo;
      })
    );
    if (variantRows.length > 0) {
      return filterVisible(variantRows);
    }
  }

  return filterVisible(
    modelOption.options.map((option) => ({
      id: option.value,
      modelValue: option.value,
      name: formatModelVariantLabel(option.name, option.value),
      description: option.description,
      detail: backend?.label ?? conversation.config.backendId,
      provider,
      backendId: conversation.config.backendId,
      selected:
        option.value === effectiveSelectedId ||
        (!effectiveSelectedId &&
          !!selectedName &&
          (option.name === selectedName ||
            formatModelVariantLabel(option.name, option.value) === selectedName)),
    }))
  );
}

export function buildDraftModelOptionsForBackend(
  backend: AgentBackendInfo,
  modelVisibility?: Record<string, Array<{ id: string; name: string; on: boolean }>>
): ModelInfo[] {
  return buildConversationModelOptions(createBackendDraftConversation(backend), [backend], modelVisibility);
}

export function resolveDraftModelForBackend(
  backend: AgentBackendInfo
): ModelInfo {
  return resolveConversationModel(createBackendDraftConversation(backend), [backend]);
}

export function buildDraftModeOptionsForBackend(
  backend: AgentBackendInfo
): AgentModeOption[] {
  return buildConversationModeOptions(createBackendDraftConversation(backend), [backend]);
}

export function resolveConversationModel(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[]
): ModelInfo {
  const models = buildConversationModelOptions(conversation, backends);
  return (
    models.find((model) => model.selected) ??
    models[0] ?? {
      id: conversation.config.modelId,
      modelValue: conversation.config.modelId,
      name: formatModelVariantLabel(
        conversation.config.modelName,
        conversation.config.modelId
      ),
      provider: modelProviderForBackend(conversation.config.backendId),
      selected: true,
    }
  );
}
