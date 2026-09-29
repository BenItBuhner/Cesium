import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildCesiumBaseSystemPrompt,
  formatGitSummaryForPrompt,
  type BuildCesiumSystemPromptInput,
  type McpServerSummary,
} from "@cesium/core/mcp";
import {
  createWorkspaceWorktree,
  getGitWorkspaceStatus,
  switchWorkspaceBranch,
} from "../git-worktrees.js";
import { listWorkspaces } from "../workspace-registry.js";
import {
  applyConversationTitleAction,
  listConversationsForAgent,
  parseConversationTitleToolArgs,
  readConversationTranscriptForAgent,
  searchConversationsForAgent,
} from "./cesium/cesium-conversation-tools.js";
import {
  createCesiumAgentConfigOptions,
  findCesiumModelCatalogEntry,
  formatCesiumModelRoster,
  getCesiumAgentSettings,
  getCesiumModelCatalog,
  listCesiumAgentModelRoster,
  resolveCesiumModelContextWindow,
  resolveCesiumAuth,
  resolveCesiumSpawnModelId,
  type CesiumProviderKind,
  type CesiumToolPermissionCategory,
} from "../cesium-agent-settings.js";
import {
  findMatchingRememberedPermissionRule,
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../global-settings-store.js";
import { projectAgentActsWithoutAsking } from "./remembered-permissions.js";
import { projectAgentContextDir } from "../projects/paths.js";
import { callMcpToolRich, refreshWorkspaceMcpMirror } from "../mcp/connection-manager.js";
import { getMcpCatalogRevision, getMcpServer, getMcpSummariesForPrompt } from "../mcp/server-store.js";
import {
  resolveAgentPluginAttachments,
  type AgentPluginAttachmentSnapshot,
} from "../plugins/attachments.js";
import { BROWSER_MCP_SERVER_ID, callBuiltInBrowserTool } from "../mcp/builtin-browser-tools.js";
import { generateTranscriptFromEvents } from "./event-log-read.js";
import { asNumber } from "./json-coerce.js";
import { readConversationEvents, readConversationRecord } from "./session-store.js";
import {
  deltaPayloadFor,
  resolveSideChatDelta,
  sideChatInlineReminderEvent,
  sideChatOriginOf,
  sideChatTurnStartReminderEvent,
  unavailablePayloadFor,
  type SideChatOrigin,
  type SideChatReminderPayload,
} from "./side-chat/side-chat-store.js";
import { SideChatTail } from "./side-chat/side-chat-tail.js";
import {
  PROJECT_ORCHESTRATOR_BORROWED_TOOLS,
  PROJECT_ORCHESTRATOR_SYSTEM_PROMPT,
  PROJECT_ORCHESTRATOR_TOOLS,
  PROJECT_ORCHESTRATOR_TOOL_NAMES,
} from "../projects/orchestrator-tool-definitions.js";
import { isProjectsEnabled } from "../projects/feature-flag.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  buildCesiumContextSections,
  buildCesiumTurnFacts,
  changedCesiumReminderSections,
  hashCesiumReminderSections,
  renderCesiumTurnReminder,
} from "./cesium-reminders.js";
import {
  forgetCesiumMemoryEntry,
  formatCesiumMemoryEntry,
  listCesiumMemoryEntries,
  renderCesiumMemorySnapshot,
  saveCesiumMemoryEntry,
  searchCesiumMemoryEntries,
  type CesiumMemoryCategory,
  type CesiumMemoryScope,
} from "./cesium-memory.js";
import {
  createAuthoredSkill,
  deleteAuthoredSkill,
  listAuthorableSkills,
  readSkillById,
  updateAuthoredSkill,
} from "./cesium-skill-authoring.js";
import {
  attachCesiumTriggerConversation,
  createCesiumTrigger,
  deleteCesiumTrigger,
  formatCesiumTrigger,
  formatTriggerPromptPreamble,
  listCesiumTriggers,
  markCesiumTriggerFired,
  normalizeTriggerSchedule,
  updateCesiumTrigger,
  type CesiumTriggerSchedule,
} from "./cesium-triggers.js";
import {
  isOrchestrationPermissionCategory,
  isPersistentPermissionOptionId,
  STANDARD_PERMISSION_OPTIONS,
} from "./permission-options.js";
import {
  readCesiumPlanFile,
  writeCesiumPlanFile,
} from "./cesium-plan-files.js";
import { loadWorkspaceInstructionFiles } from "./instruction-files.js";
import { refreshWorkspaceSkillsMirror, slugifySkillId } from "./skills-mirror.js";
import {
  appendGoalSnapshot,
  blockGoal,
  completeGoal,
  ensureGoalForConversation,
  formatGoalForModel,
  pauseGoal,
  readGoalForConversation,
  resumeGoal,
  updateGoal,
  updateGoalPlan,
  updateGoalProgress,
} from "./goal-store.js";
import { goalCompactionRecoveryContext } from "./goal-steering.js";
import { executeWorkflowRun } from "./workflow-runtime.js";
import {
  createWorkflowRunRecord,
  persistWorkflowScript,
  readLatestWorkflowRunForConversation,
  readWorkflowRun,
  readWorkflowScriptFile,
  seedJournalFromPriorRun,
  upsertWorkflowRun,
} from "./workflow-store.js";
import { formatWorkflowRunForModel, isWorkflowRunActive } from "./workflow-types.js";
import type { WorkflowAgentSpawnRequest, WorkflowRunRecord } from "./workflow-types.js";
import {
  addOrchestrationComment,
  createOrchestrationIssue,
  deleteOrchestrationIssue,
  findOrchestrationAssignmentForConversation,
  readOrchestrationBoardSnapshot,
  findOrchestrationBoardForHeadConversation,
  resolveOrCreateOrchestrationBoardForHeadConversation,
  upsertOrchestrationAssignment,
  upsertOrchestrationIssue,
} from "../orchestration/store.js";
import type {
  OrchestrationAssignmentRecord,
  OrchestrationAssignmentPermissionPolicy,
  OrchestrationAssignmentStatus,
  OrchestrationBoardSnapshot,
} from "../orchestration/types.js";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  completionRetryDelayMs,
  findUpstreamErrorPayload,
  formatCompressingContextStatusDetail,
  formatTakingLongerStatusDetail,
  isTransientProviderCompletionError,
  sleepMs,
} from "./completion-retry.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentConversationStatus,
  AgentEventInput,
  AgentModelUsage,
  AgentPlanEntry,
  AgentQueuedChatPrompt,
  AgentPermissionCategory,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
  AgentTokenUsage,
  AgentToolCallStatus,
} from "./types.js";
import { addTokenUsage, contextTokensAfterResponse } from "./cesium/cesium-usage.js";
import { planToolResultPruning } from "./cesium/cesium-context-pruning.js";
import { DATA_DIR } from "../persistence.js";
import {
  asRecord,
  asString,
  asStringArray,
  safeJson,
  truncate,
} from "./cesium/cesium-coerce.js";
import {
  applyCesiumFileEdit,
  describeWriteFileOutcome,
  parseCesiumEditFileArgs,
  parseCesiumWriteFileArgs,
} from "./cesium/cesium-file-tools.js";
import { parseAskQuestionArgs } from "./cesium/cesium-ask-question.js";
import { formatGlobResult, globWorkspaceEntries } from "./cesium/cesium-glob.js";
import { BoundedTerminalOutput } from "./cesium/cesium-terminal-output.js";
import {
  applyTodoPatch,
  CESIUM_TODO_PLAN_ID,
  latestTodoEntries,
  parseTodoItems,
  todoEntriesFromReplace,
} from "./cesium/cesium-todo.js";
import {
  CESIUM_HEADROOM_CHARS_PER_TOKEN,
  CESIUM_RESPONSE_WARNING_MS,
  CESIUM_SYSTEM_PROMPT,
  CESIUM_TOOL_RESULT_MODEL_MAX_CHARS,
  CESIUM_TOOL_RESULT_MODEL_MIN_CHARS,
  CONTEXT_PRUNE_TARGET_RATIO,
  CONTEXT_PRUNE_TRIGGER_RATIO,
  DEFAULT_GREP_RESULTS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HISTORY_COMPACTION_TARGET_RATIO,
  HISTORY_COMPACTION_TARGET_TURNS,
  HISTORY_COMPACTION_THRESHOLD_RATIO,
  HISTORY_TURN_LIMIT,
  LARGE_FILE_LINE_LIMIT,
  MAX_GREP_RESULTS,
  MAX_READ_LINES,
  ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES,
  ORCHESTRATION_WAIT_DEFAULT_MS,
  ORCHESTRATION_WAIT_HEARTBEAT_MS,
  TERMINAL_OUTPUT_CAP,
  WAIT_HEARTBEAT_MS,
  WAIT_POLL_MS,
} from "./cesium/cesium-prompt.js";
import {
  cesiumPermissionToolKey,
  normalizeCallMcpToolArgs,
  normalizeCesiumToolName,
  normalizeCesiumToolRequestArguments,
  parseWaitToolArgs,
  permissionDecisionFromOption,
  resolveCesiumToolPermissionCategory,
  resolveCesiumTools,
  toolKind,
  toolTitle,
} from "./cesium/cesium-tools.js";
import {
  CESIUM_FEATURE_REGISTRY,
  CesiumHarnessPluginRuntime,
  harnessFeatureReminder,
  isSubagentsV2ToolName,
  loadCesiumHarnessPluginModulesFromEnv,
  SubagentsV2Runtime,
  type CesiumHarnessTurnOutcome,
  type CesiumToolDefinition,
  type ResolvedCesiumHarness,
} from "./cesium/features/index.js";
import {
  createSubagentProgressBroadcaster,
  createSubagentToolset,
  findPersistedSubagentTranscript,
  latestSubagentTranscriptActivity,
  pushRunningSubagentToolRow,
  runSubagentToolLoop,
  settleSubagentToolRow,
  subagentToolDefinitions,
  subagentToolsetGuidance,
  type CesiumSubagentToolset,
} from "./cesium/subagent-toolset.js";
import {
  CESIUM_TURN_CONTEXT_REMINDER_REASON,
  cesiumEnvironmentChangeNotice,
  cesiumRelocationChangeNotice,
  estimateHistoryTokens,
  reportedContextTokens,
  formatCesiumDateLabel,
  isEmptyCesiumAdapterResult,
  latestCesiumEnvironmentReminderSnapshot,
  latestContextReminderBaseline,
  latestMcpReminderSnapshot,
  mcpReminderChangeNotice,
  mcpReminderSnapshot,
  normalizeCesiumToolResultForModel,
  normalizeEventsToHistory,
  previousUserMessageCreatedAt,
  prunedToolCallIds,
  selectHistoryWindow,
  summarizeForCompression,
} from "./cesium/cesium-history.js";
import { resolveModelDisplayName } from "@cesium/core/model-display-name";
import {
  adapterHonorsMaxOutputTokens,
  modelPart,
  providerPart,
  runAdapter,
  streamAdapter,
  type RunAdapterInput,
} from "./cesium/cesium-model-adapters.js";
import {
  asOrchestrationAssignmentStatuses,
  asOrchestrationColumnId,
  asOrchestrationControlAction,
  asOrchestrationPermissionDecision,
  asOrchestrationPermissionPolicy,
  asOrchestrationPriority,
  asOrchestrationWaitFor,
} from "./cesium/cesium-orchestration-args.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
  CesiumToolRequest,
} from "./cesium/cesium-types.js";

export {
  buildOpenAiToolDefinitions,
  cesiumPermissionToolKey,
  normalizeCallMcpToolArgs,
  parseWaitToolArgs,
  sanitizeOpenAiCompatibleJsonSchema,
} from "./cesium/cesium-tools.js";
export type { NormalizedCallMcpToolArgs, ParsedWaitToolArgs } from "./cesium/cesium-tools.js";
export {
  isEmptyCesiumAdapterResult,
  normalizeCesiumToolResultForModel,
  normalizeEventsToHistory,
} from "./cesium/cesium-history.js";
export { openAiMessages } from "./cesium/cesium-model-adapters.js";

class CesiumTurnCancelledError extends Error {
  constructor() {
    super("Cesium turn cancelled.");
    this.name = "CesiumTurnCancelledError";
  }
}

type ActivePermission = {
  resolve: (value: "allow" | "reject") => void;
  reject: (error: Error) => void;
  toolKey: string;
  toolLabel: string;
  permissionCategory?: AgentPermissionCategory;
};

type ActiveQuestion = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  questions: CesiumQuestionStep[];
  allowMultiple: boolean;
  raw: Record<string, unknown>;
};

type CesiumQuestionStep = {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
};

type TerminalRun = {
  id: string;
  process: ChildProcessWithoutNullStreams;
  output: BoundedTerminalOutput;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
};

function optionValue(options: AgentConfigOption[], id: string, fallback: string): string {
  return options.find((option) => option.id === id)?.currentValue || fallback;
}

/** A tool result's character budget: the per-result cap, less when the context is nearly full. */
function toolResultBudgetForHeadroom(headroomTokens: number): number {
  return Math.max(
    CESIUM_TOOL_RESULT_MODEL_MIN_CHARS,
    Math.min(CESIUM_TOOL_RESULT_MODEL_MAX_CHARS, Math.floor(headroomTokens * CESIUM_HEADROOM_CHARS_PER_TOKEN))
  );
}

/**
 * Where a mid-turn pruning boundary starts: the trigger share of the window,
 * but early enough that headroom sizing has not yet started shrinking results.
 */
function pruneTriggerTokens(contextWindow: number): number {
  const shrinkStartsAt =
    contextWindow - DEFAULT_MAX_OUTPUT_TOKENS - CESIUM_TOOL_RESULT_MODEL_MAX_CHARS / CESIUM_HEADROOM_CHARS_PER_TOKEN;
  return Math.min(contextWindow * CONTEXT_PRUNE_TRIGGER_RATIO, shrinkStartsAt);
}

function resolvedModelId(
  conversationModelId: string | undefined,
  configOptions: AgentConfigOption[]
): string {
  const fromConversation = conversationModelId?.trim();
  if (fromConversation) {
    return fromConversation;
  }
  return optionValue(configOptions, "model", "openai/gpt-5.1");
}

function updateConfigOption(options: AgentConfigOption[], id: string, value: string): AgentConfigOption[] {
  return options.map((option) => option.id === id ? { ...option, currentValue: value } : option);
}

/** Relative paths resolve in the workspace; absolute ones may also point into `extraRoots`. */
function resolveWorkspacePath(workspaceRoot: string, inputPath: string, extraRoots: readonly string[] = []): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  for (const root of [workspaceRoot, ...extraRoots]) {
    const relative = path.relative(root, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return resolved;
    }
  }
  throw new Error(`Path escapes workspace: ${inputPath}`);
}

/** `null` when the file does not exist; other filesystem errors still throw. */
async function readWorkspaceFileIfExists(resolvedPath: string): Promise<string | null> {
  try {
    return await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function statusFromError(error: unknown): { status: AgentToolCallStatus; detail: string } {
  return {
    status: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Result for a tool call whose argument JSON did not parse; such a call never runs. */
function unparsedToolArgumentsResult(
  request: CesiumToolRequest,
  cutOff: { outputTokens?: number } | null
): string {
  if (cutOff) {
    const after = cutOff.outputTokens ? ` after ${cutOff.outputTokens} output tokens` : " at the output-token limit";
    return (
      `Your ${request.name} call was cut off${after}, so its arguments were incomplete ` +
      `(${request.unparsedArgumentChars ?? 0} characters of JSON) and it did not run. ` +
      "Split the content into smaller pieces, e.g. several smaller write_file or edit_file calls."
    );
  }
  return (
    `The arguments of your ${request.name} call were not valid JSON, so it did not run. ` +
    "Send the call again with a complete JSON object."
  );
}

const USER_REFUSED_TOOL_CALL_RESULT =
  "The user refused this tool call. Continue in a different fashion that is either less intrusive or destructive.";
const CESIUM_STREAM_CHUNK_FLUSH_MS = 120;
const CESIUM_STREAM_CHUNK_MIN_CHARS = 512;
const MAX_READ_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function imageMimeTypeForPath(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export type CesiumAssistantStreamSink = {
  /** The message the next text lands in; changes when an attempt is discarded. */
  readonly messageId: string;
  pushText: (text: string) => Promise<void>;
  pushReasoning: (text: string) => Promise<void>;
  flush: () => Promise<void>;
  /**
   * Drops a model attempt that is being retried. Text it already persisted is
   * closed out as a `discarded` message, which history replay skips, and the
   * retry streams into a fresh message.
   */
  discardAttempt: () => Promise<void>;
};

type CesiumAdapterStreamHandlers = {
  onTextDelta?: (text: string) => Promise<void>;
  onReasoningDelta?: (text: string) => Promise<void>;
  /** A failed attempt is about to be retried; drop what it streamed. */
  onDiscardAttempt?: () => Promise<void>;
};

/**
 * Persists one model turn's streamed output. Reasoning deltas are buffered into a
 * single `reasoning` event that is always appended before the first
 * `assistant_message_chunk`, so the thought dropdown renders above the answer.
 */
export function createCesiumAssistantStreamSink(input: {
  conversationId: string;
  messageId: string;
  reasoningMessageId: string;
  appendEvents: (events: AgentEventInput[]) => Promise<unknown>;
}): CesiumAssistantStreamSink {
  let messageId = input.messageId;
  let pendingText = "";
  let pendingReasoning = "";
  let persistedText = false;
  let lastFlushAt = 0;
  const flushReasoning = async () => {
    if (!pendingReasoning) {
      return;
    }
    const text = pendingReasoning;
    pendingReasoning = "";
    await input.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "reasoning",
        messageId: input.reasoningMessageId,
        text,
      },
    ]);
  };
  const flushText = async () => {
    if (!pendingText) {
      return;
    }
    const text = pendingText;
    pendingText = "";
    lastFlushAt = Date.now();
    persistedText = true;
    await input.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "assistant_message_chunk",
        messageId,
        text,
      },
    ]);
  };
  return {
    get messageId() {
      return messageId;
    },
    pushText: async (text: string) => {
      if (!text) {
        return;
      }
      await flushReasoning();
      pendingText += text;
      const now = Date.now();
      if (
        pendingText.length >= CESIUM_STREAM_CHUNK_MIN_CHARS ||
        now - lastFlushAt >= CESIUM_STREAM_CHUNK_FLUSH_MS
      ) {
        await flushText();
      }
    },
    pushReasoning: async (text: string) => {
      if (!text) {
        return;
      }
      pendingReasoning += text;
    },
    flush: async () => {
      await flushReasoning();
      await flushText();
    },
    discardAttempt: async () => {
      pendingReasoning = "";
      pendingText = "";
      if (!persistedText) {
        return;
      }
      persistedText = false;
      const discardedMessageId = messageId;
      messageId = `cesium-assistant-${randomUUID()}`;
      await input.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "assistant_message_end",
          messageId: discardedMessageId,
          stopReason: "discarded",
        },
      ]);
    },
  };
}

/** A fetch failure's message with its cause, which is where runtimes say the socket closed. */
function providerFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  const causeMessage =
    cause instanceof Error
      ? [cause.message, (cause as { code?: unknown }).code].filter(
          (part): part is string => typeof part === "string" && part.length > 0
        )
      : [];
  return causeMessage.length > 0 ? `${error.message} (${causeMessage.join(", ")})` : error.message;
}

function emptyModelResponseError(model: string, raw: unknown, attempts = 1): Error {
  return new Error(
    `Cesium received an empty model response from ${model} with no text and no tool calls` +
      (attempts > 1 ? ` after ${attempts} attempts. ` : ". ") +
      "Treating this as an upstream provider failure instead of a completed turn. " +
      `Raw response: ${truncate(safeJson(raw), 2000)}`
  );
}

class PermissionRefusedToolCallError extends Error {
  constructor() {
    super(USER_REFUSED_TOOL_CALL_RESULT);
    this.name = "PermissionRefusedToolCallError";
  }
}

const COORDINATOR_ROSTER_CHECKS_BEFORE_TURN_ENDS = 3;
const COORDINATOR_TURN_ENDS_NOTE =
  "You checked on your agents three times in a row, so your turn ends here. Their reports and any Project events arrive as your next turn.";

type CesiumPausePhase = "none" | "pause_requested" | "pausing" | "paused";

/** Model-facing framing for a steer injected into a running turn. */
type PendingSteer = { text: string; userMessageId: string; queuedPromptId?: string };

export function formatMidTurnSteer(text: string): string {
  return [
    "[Steering message - sent while you were working on this turn]",
    "Read it now and adjust the rest of this turn accordingly; earlier work stays valid unless it says otherwise.",
    "",
    text,
  ].join("\n");
}

/** Tools a read-only Project helper keeps; subagents it spawns inherit the same set. */
const READ_ONLY_HELPER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "glob",
  "wait",
  "search_history",
  "read_history_page",
  "list_conversations",
  "read_conversation",
  "search_conversations",
  "subagent",
  "read_subagent_transcript",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
]);

class CesiumSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  readonly capabilities: AgentBackendInfo["capabilities"];
  readonly steersQueuedPrompts = true;

  private disposed = false;
  private cancelled = false;
  /** Aborts the turn's in-flight provider requests; replaced at every prompt. */
  private turnAbort = new AbortController();
  private pausePhase: CesiumPausePhase = "none";
  private resumeWaiter: (() => void) | null = null;
  private resumeAck: (() => void) | null = null;
  private pendingPermissions = new Map<string, ActivePermission>();
  private pendingQuestions = new Map<string, ActiveQuestion>();
  private terminalRuns = new Map<string, TerminalRun>();
  /** Tool-call titles refined during execution (e.g. "Write x" → "Create x" once we know the file is new). */
  private refinedToolTitles = new Map<string, string>();
  private subagentTranscripts = new Map<string, AgentStoredEvent[]>();
  /** Images produced by tool calls (browser screenshots, image reads) awaiting attachment to the model turn. */
  private pendingToolImages: Array<{ mimeType: string; data: string; source: string }> = [];
  /** Whether the model running the current turn advertises image support. */
  private turnSupportsImages = false;
  /** Characters of the next tool result the model may see; the loop sets it from the context headroom. */
  private nextToolResultBudget = CESIUM_TOOL_RESULT_MODEL_MAX_CHARS;
  /** How each just-completed result was stored for the model, keyed by tool call id. */
  private toolResultShapes = new Map<string, { modelBudget?: number; spillPath?: string }>();
  /** The model response whose tool calls are running; batches tool calls for pruning. */
  private currentResponseId: string | null = null;
  /** Provider-reported usage of the current assistant message: its last response and the running sum. */
  private messageUsage: { last?: AgentModelUsage; total?: AgentTokenUsage; responses: number } = {
    responses: 0,
  };
  private activeSystemPrompt = CESIUM_SYSTEM_PROMPT;
  private activeUserMessageId: string | null = null;
  private harness: ResolvedCesiumHarness = resolveCesiumTools();
  private harnessSignature = "";
  private pluginRuntime: CesiumHarnessPluginRuntime | null = null;
  private subagentsV2: SubagentsV2Runtime | null = null;
  /**
   * Model access roster (enabled models + user notes) advertised to the
   * primary agent and subagents; refreshed with the harness each turn.
   */
  private modelRosterText = "";
  /**
   * Side chats only: live tail of the parent conversation for the running
   * turn, plus the highest parent seq already delivered this turn. Deltas are
   * appended to the model context between tool iterations and persisted as
   * inline reminders so the next rebuild reproduces the same tail.
   */
  private sideChatTail: SideChatTail | null = null;
  private sideChatCursor = 0;
  private sideChatParentUnavailableNoticed = false;
  /**
   * Mid-turn steers accepted by `steer()` and not yet shown to the model.
   * `acceptingSteers` flips off synchronously right before the loop commits
   * to finishing, so a steer is either injected into this turn or refused
   * (and queued by the runtime) - never silently dropped.
   */
  private pendingSteers: PendingSteer[] = [];
  private acceptingSteers = false;
  /**
   * Tool call ids already stored in this conversation. Some models number
   * their calls per response (kimi-k3 sends `read_file:0` every time), and a
   * repeated id would merge distinct calls wherever events are keyed by it.
   */
  private readonly usedToolCallIds = new Set<string>();
  /** Project coordinators: project_list_agents calls in a row this turn; any other tool resets it. */
  private rosterChecksInARow = 0;
  /** Set by a coordinator's third check in a row: the turn ends once this batch of tools is done. */
  private endTurnAfterTools = false;

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    sessionId?: string | null
  ) {
    this.sessionId = sessionId ?? `cesium-${callbacks.conversation.id}`;
    this.configOptions = configOptions;
    this.capabilities = backend.capabilities;
  }

  async initialize(): Promise<void> {
    const modelId = this.callbacks.conversation.config.modelId?.trim();
    if (modelId) {
      this.configOptions = updateConfigOption(this.configOptions, "model", modelId);
    }
    // Conversations saved while Cesium had operating modes and agent profiles
    // still carry "mode" and "profile" config options; neither exists anymore.
    this.configOptions = this.configOptions.filter(
      (option) => option.id !== "mode" && option.id !== "profile"
    );
    await this.refreshHarnessFromSettings();
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: this.sessionId,
      configOptions: this.configOptions,
      capabilities: this.capabilities,
      status:
        current.status === "running" ||
        current.status === "pause_requested" ||
        current.status === "pausing" ||
        current.status === "paused" ||
        current.status === "awaiting_permission" ||
        current.status === "awaiting_question"
          ? current.status
          : "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
  }

  private async resolveSystemPromptContext(
    mcpSummaries: McpServerSummary[],
    skillsList?: string
  ): Promise<BuildCesiumSystemPromptInput> {
    const workspaceRoot = this.callbacks.workspace.root;
    let gitSummary = "not a git repository";
    try {
      const status = await getGitWorkspaceStatus(this.callbacks.workspace, []);
      gitSummary = formatGitSummaryForPrompt(status);
    } catch {
      gitSummary = "not a git repository";
    }
    const agentsMarkdown = await loadWorkspaceInstructionFiles(workspaceRoot);
    const modelId =
      this.callbacks.conversation.config.modelId ||
      optionValue(this.configOptions, "model", "openai/gpt-5.1");
    return {
      mcpSummaries,
      modelName: resolveModelDisplayName(
        this.callbacks.conversation.config.modelName,
        String(modelId)
      ),
      workspaceRoot,
      dateLabel: formatCesiumDateLabel(new Date()),
      gitSummary,
      agentsMarkdown,
      skillsList: skillsList?.trim() || undefined,
    };
  }

  /**
   * Project id when this conversation is a Project orchestrator. Orchestrators
   * are a distinct agent type: their own system prompt, only the Project tools
   * (plus `ask_question`), and a Project-state reminder instead of the mode one.
   */
  private projectOrchestratorProjectId(): string | null {
    const origin = this.callbacks.conversation.origin;
    return origin?.kind === "project-orchestrator" ? origin.projectId : null;
  }

  /** Per-turn Project state (agents, notes, context files) plus the model roster for children. */
  private async projectOrchestratorReminderText(
    projectId: string,
    context: { dateLabel: string; modelName: string }
  ): Promise<string> {
    // Loaded lazily: the Project service reaches back into the runtime manager.
    const { buildProjectOrchestratorReminder } = await import(
      "../projects/orchestrator-tools.js"
    );
    return [
      await buildProjectOrchestratorReminder(projectId, context),
      this.modelRosterText
        ? `<available-models>\n${this.modelRosterText}\n</available-models>`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Base system prompt with the session constants filled in. Model name and
   * workspace root only change on a model switch or relocation, so the prompt
   * prefix stays byte-stable across ordinary turns; per-turn facts (date, git
   * state, AGENTS.md, MCP, skills) travel in the reminder instead.
   */
  private baseSystemPrompt(): string {
    if (this.projectOrchestratorProjectId()) {
      return PROJECT_ORCHESTRATOR_SYSTEM_PROMPT;
    }
    const modelId = this.currentModelId();
    return buildCesiumBaseSystemPrompt({
      modelName: resolveModelDisplayName(this.callbacks.conversation.config.modelName, modelId),
      workspaceRoot: this.callbacks.workspace.root,
    });
  }

  /** A Project explorer: only tools that read or delegate read-only work. */
  private isReadOnlyHelper(): boolean {
    const origin = this.callbacks.conversation.origin;
    return origin?.kind === "project-child" && origin.readOnly === true;
  }

  /**
   * Tool schemas advertised to the model: the full resolved harness.
   * Subagent-spawning tools carry the live Model access roster in their
   * descriptions (Codex spawn_agent parity) - and because children receive
   * these same definitions, the roster propagates recursively to every spawn
   * depth.
   */
  private advertisedTools(): CesiumToolDefinition[] {
    if (this.projectOrchestratorProjectId()) {
      return [
        ...PROJECT_ORCHESTRATOR_TOOLS,
        ...this.harness.tools.filter((tool) =>
          (PROJECT_ORCHESTRATOR_BORROWED_TOOLS as readonly string[]).includes(tool.name)
        ),
      ];
    }
    const tools = this.isReadOnlyHelper()
      ? this.harness.tools.filter((tool) => READ_ONLY_HELPER_TOOLS.has(tool.name))
      : this.harness.tools;
    if (!this.modelRosterText) {
      return tools;
    }
    return tools.map((tool) =>
      tool.name === "spawn_agent" || tool.name === "subagent"
        ? { ...tool, description: `${tool.description}\n\n${this.modelRosterText}` }
        : tool
    );
  }

  /** Model driving the current turn (composer selection, else conversation config). */
  private currentModelId(): string {
    return String(
      optionValue(
        this.configOptions,
        "model",
        this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
      )
    );
  }

  /** Best-effort roster refresh; an unreachable catalog never blocks the turn. */
  private async refreshModelRoster(): Promise<void> {
    try {
      const projectId = this.projectOrchestratorProjectId();
      if (projectId) {
        this.modelRosterText = await this.projectChildModelRoster(projectId);
        return;
      }
      const roster = await listCesiumAgentModelRoster({
        defaultModelId: this.currentModelId(),
      });
      this.modelRosterText = formatCesiumModelRoster(roster);
    } catch {
      this.modelRosterText = "";
    }
  }

  /** What an orchestrator may pass as `project_create_agent.model` for agents on this engine. */
  private async projectChildModelRoster(projectId: string): Promise<string> {
    const [{ readProject }, { homeEngineLabel }] = await Promise.all([
      import("../projects/project-store.js"),
      import("../projects/engine-registry.js"),
    ]);
    const settings = (await readProject(projectId))?.settings;
    const projectDefault =
      (settings?.defaultChildBackendId || "cesium-agent") === "cesium-agent"
        ? settings?.defaultChildModelId
        : null;
    const roster = await listCesiumAgentModelRoster({
      credentialedOnly: true,
      ...(projectDefault ? { defaultModelId: projectDefault } : {}),
    });
    return formatCesiumModelRoster(roster, {
      heading:
        `Cesium Agent models with credentials on ${homeEngineLabel()} (this engine), for project_create_agent.model. ` +
        '"(current default)" marks the model agents get when you omit it; only pass a model when an agent needs a different one. ' +
        "Other engines use their own keys and fall back to their default model.",
    });
  }

  /** Curated-memory snapshot for the per-turn reminder, or null when empty. */
  private async resolveMemorySnapshot(): Promise<string | null> {
    if (!this.harness.tools.some((tool) => tool.name === "memory")) {
      return null;
    }
    try {
      const entries = await listCesiumMemoryEntries({
        workspaceId: this.callbacks.workspace.id,
      });
      return renderCesiumMemorySnapshot(entries) || null;
    } catch {
      return null;
    }
  }

  private createAssistantStreamSink(
    messageId: string,
    iteration: number
  ): CesiumAssistantStreamSink {
    return createCesiumAssistantStreamSink({
      conversationId: this.callbacks.conversation.id,
      messageId,
      reasoningMessageId: `${messageId}-reasoning-${iteration}`,
      appendEvents: (events) => this.callbacks.appendEvents(events),
    });
  }

  /** The conversation's Goal while it is still open (not complete or cancelled). */
  private async readOpenGoal() {
    const goal = await readGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    }).catch(() => null);
    return goal && goal.status !== "complete" && goal.status !== "cancelled" ? goal : null;
  }

  private async resolveCurrentOrchestrationBoard() {
    return resolveOrCreateOrchestrationBoardForHeadConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      title: this.callbacks.conversation.title || "Orchestration",
      allowedBackendIds: ["cesium-agent"],
    });
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
    isRetry?: boolean;
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
    clientTimezone?: string;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Cesium session has been disposed.");
    }
    this.cancelled = false;
    this.turnAbort = new AbortController();
    this.pausePhase = "none";
    this.resumeWaiter = null;
    this.releaseResumeAck();
    this.activeUserMessageId = input.userMessageId;
    this.pendingSteers = [];
    this.acceptingSteers = true;
    this.rosterChecksInARow = 0;
    this.endTurnAfterTools = false;
    let pluginOutcome: CesiumHarnessTurnOutcome = { status: "cancelled" };
    let assistantMessageId = `cesium-assistant-${randomUUID()}`;
    try {
      await this.refreshHarnessFromSettings();
      const pluginTurnInput = await this.pluginRuntime?.turnStart({
        text: input.text,
        userMessageId: input.userMessageId,
        attachments: input.attachments,
        isRetry: input.isRetry,
        clientTimezone: input.clientTimezone,
      });
      if (pluginTurnInput) {
        input = { ...input, ...pluginTurnInput };
      }
      await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "Cesium is starting…",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      lastError: null,
      providerSessionId: this.sessionId,
    }));
      const modelId = optionValue(
        this.configOptions,
        "model",
        this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
      );
      const modelProviderId = providerPart(modelId);
      const auth = await resolveCesiumAuth({
        modelId,
        configuredApiKind:
          modelProviderId === "openai"
            ? (optionValue(this.configOptions, "api_kind", "openai-responses") as CesiumProviderKind)
            : undefined,
      });
      const orchestratorProjectId = this.projectOrchestratorProjectId();
      // An orchestrator's workspace is the Project context folder and it has
      // no MCP or skill tools, so the MCP and skills mirrors (which write
      // folders into the workspace root) are skipped for it.
      if (!orchestratorProjectId) {
        await refreshWorkspaceMcpMirror({
          workspaceId: this.callbacks.workspace.id,
          workspaceRoot: this.callbacks.workspace.root,
        }).catch(async (error) => {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "system",
              level: "warning",
              text: `MCP server refresh failed before the model turn. ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ]);
        });
      }
      const summaries = orchestratorProjectId
        ? []
        : await getMcpSummariesForPrompt(this.callbacks.workspace.id);
      const pluginAttachments: Pick<AgentPluginAttachmentSnapshot, "plugins" | "warnings"> =
        orchestratorProjectId
          ? { plugins: [], warnings: [] }
          : await resolveAgentPluginAttachments({
              workspaceId: this.callbacks.workspace.id,
              workspaceRoot: this.callbacks.workspace.root,
              backendId: "cesium-agent",
            });
      if (pluginAttachments.warnings.length > 0) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `Agent plugins: ${pluginAttachments.warnings
              .map((warning) => `${warning.pluginName}: ${warning.reason}`)
              .join("; ")}`,
          },
        ]);
      }
      const skillsMirror = orchestratorProjectId
        ? { skills: [], skillsList: "" }
        : await refreshWorkspaceSkillsMirror({
            workspaceRoot: this.callbacks.workspace.root,
            pluginSkills: pluginAttachments.plugins.flatMap((plugin) =>
              plugin.definition.skills.map((skill) => ({
                id: skill.id,
                title: skill.title,
                description: skill.description,
                body: skill.body,
                triggerHints: skill.triggerHints,
                pluginId: plugin.definition.pluginId,
                pluginName: plugin.definition.displayName,
              }))
            ),
          }).catch(async (error) => {
            await this.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "system",
                level: "warning",
                text: `Agent skills mirror refresh failed before the model turn. ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ]);
            return { skills: [], skillsList: "" };
          });
      const board = orchestratorProjectId
        ? null
        : await findOrchestrationBoardForHeadConversation(
            this.callbacks.workspace.id,
            this.callbacks.conversation.id
          ).catch(() => null);
      const goalState = orchestratorProjectId ? null : await this.readOpenGoal();
      const workflowState = orchestratorProjectId
        ? null
        : await readLatestWorkflowRunForConversation({
            workspaceId: this.callbacks.workspace.id,
            conversationId: this.callbacks.conversation.id,
          })
            .then((run) => (run && isWorkflowRunActive(run.status) ? run : null))
            .catch(() => null);
      const sideChatTurn = await this.beginSideChatTurn();
      const promptContext = await this.resolveSystemPromptContext(
        summaries,
        skillsMirror.skillsList
      );
      const nowMs = Date.now();
      const timeZone = input.clientTimezone?.trim() || undefined;
      promptContext.dateLabel = formatCesiumDateLabel(nowMs, timeZone);
      promptContext.modelName = resolveModelDisplayName(
        promptContext.modelName ?? this.callbacks.conversation.config.modelName,
        modelId
      );
      const compactedThisTurn = await this.compactHistoryIfNeeded(await this.readHistoryEvents());
      const previousSnapshot = await this.callbacks.readSnapshot().catch(() => null);
      const previousEvents = previousSnapshot?.events ?? [];
      const mcpCatalogRevision = await getMcpCatalogRevision(this.callbacks.workspace.id);
      const currentMcpSnapshot = mcpReminderSnapshot({
        revision: mcpCatalogRevision,
        dateLabel: promptContext.dateLabel,
        dateMs: nowMs,
        timeZone,
        modelId,
        modelName: promptContext.modelName,
        summaries,
      });
      const mcpChangeNotice = mcpReminderChangeNotice(
        previousSnapshot ? latestMcpReminderSnapshot(previousEvents) : null,
        currentMcpSnapshot
      );
      const baseEnvironmentChangeNotice = cesiumEnvironmentChangeNotice({
        previous: previousSnapshot
          ? latestCesiumEnvironmentReminderSnapshot(previousEvents)
          : null,
        current: {
          dateLabel: promptContext.dateLabel,
          dateMs: nowMs,
          timeZone,
          modelId,
          modelName: promptContext.modelName,
        },
        previousUserMessageAt: previousUserMessageCreatedAt(
          previousEvents,
          input.userMessageId
        ),
      });
      // One-shot relocation notice: the conversation was moved to a different
      // workspace/branch since the previous turn. Delivered once, then cleared.
      const pendingRelocation =
        previousSnapshot?.conversation.pendingRelocation ??
        this.callbacks.conversation.pendingRelocation ??
        null;
      const relocationNotice = cesiumRelocationChangeNotice(pendingRelocation);
      const environmentChangeNotice =
        [baseEnvironmentChangeNotice, relocationNotice].filter(Boolean).join("\n") || null;
      if (pendingRelocation) {
        await this.callbacks
          .updateConversation((current) => ({ ...current, pendingRelocation: null }))
          .catch(() => undefined);
      }
      const memorySnapshot = orchestratorProjectId ? null : await this.resolveMemorySnapshot();
      const reminderInput = {
        modelName: promptContext.modelName,
        memorySnapshot,
        workspaceRoot: promptContext.workspaceRoot ?? this.callbacks.workspace.root,
        dateLabel: promptContext.dateLabel ?? formatCesiumDateLabel(nowMs, timeZone),
        gitSummary: promptContext.gitSummary ?? "not a git repository",
        agentsMarkdown: promptContext.agentsMarkdown,
        skillsList: skillsMirror.skillsList,
        mcpSummaries: summaries,
        mcpChangeNotice,
        environmentChangeNotice,
        orchestrationBoard: board,
        handoffPlanPath: input.planHandoff?.planPath,
        goalSummary: goalState
          ? compactedThisTurn
            ? goalCompactionRecoveryContext(goalState)
            : formatGoalForModel(goalState)
          : null,
        workflowRunSummary: workflowState ? formatWorkflowRunForModel(workflowState) : null,
        conversationTitle: this.callbacks.conversation.title,
        conversationTitleFollow: this.callbacks.conversation.config.titleFollow,
        sideChat: sideChatTurn
          ? {
              parentConversationId: sideChatTurn.origin.parentConversationId,
              parentTitle:
                sideChatTurn.parent?.title ?? sideChatTurn.origin.parentTitle ?? "Primary chat",
            }
          : null,
        harnessFeatures: harnessFeatureReminder(this.harness),
      };
      const contextSections = buildCesiumContextSections(reminderInput);
      const contextSectionHashes = hashCesiumReminderSections(contextSections);
      const contextBaseline = orchestratorProjectId
        ? null
        : latestContextReminderBaseline(selectHistoryWindow(await this.readHistoryEvents()).events);
      const reminderText = orchestratorProjectId
        ? await this.projectOrchestratorReminderText(orchestratorProjectId, {
            dateLabel: promptContext.dateLabel ?? formatCesiumDateLabel(nowMs, timeZone),
            modelName: promptContext.modelName ?? modelId,
          })
        : renderCesiumTurnReminder({
            facts: buildCesiumTurnFacts(reminderInput),
            sections: changedCesiumReminderSections(contextSections, contextBaseline),
          });
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system_reminder",
          reminderId: `${orchestratorProjectId ? "mode" : "context"}-${input.userMessageId}`,
          targetMessageId: input.userMessageId,
          reason: orchestratorProjectId ? "mode" : CESIUM_TURN_CONTEXT_REMINDER_REASON,
          text: reminderText,
          raw: {
            ...(orchestratorProjectId
              ? {}
              : {
                  contextReminder: contextBaseline ? "delta" : "full",
                  contextSectionHashes,
                }),
            planHandoff: input.planHandoff,
            modelId,
            modelName: promptContext.modelName,
            mcpServerCount: summaries.length,
            mcpReminderSnapshot: currentMcpSnapshot,
            environmentReminderSnapshot: {
              dateLabel: promptContext.dateLabel,
              dateMs: nowMs,
              timeZone,
              modelId,
              modelName: promptContext.modelName,
            },
          },
        },
        // Side chats: everything the primary did since the last delivered
        // cursor rides on this user message too (tail position, so the prefix
        // above it is untouched). Persisted once; rebuilds replay it verbatim.
        ...(sideChatTurn?.payload
          ? [
              sideChatTurnStartReminderEvent({
                sideChatId: this.callbacks.conversation.id,
                userMessageId: input.userMessageId,
                payload: sideChatTurn.payload,
              }),
            ]
          : []),
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Cesium is connecting to ${modelProviderId}…`,
        },
      ]);
      const { messages: history, currentUserContent } = await this.buildHistory(
        input.userMessageId
      );
      const promptImages = (input.attachments ?? [])
        .filter(
          (attachment) =>
            attachment.mimeType.startsWith("image/") && attachment.data.length > 0
        )
        .map((attachment) => ({
          mimeType: attachment.mimeType,
          data: attachment.data,
          name: attachment.name,
        }));
      // The stored user message already carries what the user typed; only a
      // provider-side wrapper (handoff, fork, session recovery) adds a message.
      const wrappedPrompt = currentUserContent?.trim() !== input.text.trim();
      if (wrappedPrompt) {
        history.push({
          role: "user",
          content: input.text,
          ...(promptImages.length > 0 ? { images: promptImages } : {}),
        });
      }
      const catalog = await getCesiumModelCatalog();
      const catalogEntry = findCesiumModelCatalogEntry(modelId, catalog);
      const modelSupportsImages = catalogEntry?.supportsImages === true;
      this.turnSupportsImages = modelSupportsImages;
      this.pendingToolImages = [];
      this.messageUsage = { responses: 0 };
      const historyImageCount = history.reduce(
        (count, message) => count + (message.images?.length ?? 0),
        0
      );
      if (historyImageCount > 0 && !modelSupportsImages) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text:
              `Model ${modelId} does not advertise image/multimodal support. ` +
              `Image attachments were dropped for this turn. Use a vision model such as kimi-k3.`,
          },
        ]);
      }
      const forModel = (messages: CesiumHistoryMessage[]) =>
        modelSupportsImages
          ? messages
          : messages.map((message) =>
              message.images?.length ? { ...message, images: undefined } : message
            );
      let modelHistory = forModel(history);
      const toolResultMessages: CesiumHistoryMessage[] = [];
      let completedToolCallCount = 0;
      const contextWindow = await resolveCesiumModelContextWindow(String(modelId)).catch(() => 100_000);
      const toolSchemaTokens = Math.ceil(JSON.stringify(this.advertisedTools()).length / 4);
      // The newest response's reported context size, and how many messages the
      // turn has appended since; without one the whole request is estimated.
      let usageAnchor: { tokens: number; messageCount: number } | null = null;
      const contextTokensNow = () =>
        usageAnchor
          ? usageAnchor.tokens + estimateHistoryTokens(toolResultMessages.slice(usageAnchor.messageCount))
          : toolSchemaTokens + estimateHistoryTokens([...modelHistory, ...toolResultMessages]);
      let pruneBlockedBelow = 0;
      const raisedMaxOutputTokens = adapterHonorsMaxOutputTokens(auth)
        ? Math.min(2 * DEFAULT_MAX_OUTPUT_TOKENS, catalogEntry?.outputLimit ?? Number.POSITIVE_INFINITY)
        : undefined;
      for (let iteration = 0; ; iteration += 1) {
        if (this.cancelled) {
          return;
        }
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
        }
        const assistantStream = this.createAssistantStreamSink(assistantMessageId, iteration);
        let modelRequest = {
          modelId: String(modelId),
          iteration,
          messages: [...modelHistory, ...toolResultMessages],
          tools: this.advertisedTools(),
        };
        modelRequest =
          (await this.pluginRuntime?.beforeModel(modelRequest)) ?? modelRequest;
        modelRequest = {
          ...modelRequest,
          messages:
            (await this.pluginRuntime?.transformMessages(modelRequest.messages)) ??
            modelRequest.messages,
        };
        let result: CesiumAdapterResult | null = null;
        try {
          result = await this.runAdapterWithWarning(
            {
              apiKind: auth.apiKind,
              apiKey: auth.apiKey,
              baseUrl: auth.baseUrl,
              providerId: auth.providerId,
              oauth: auth.oauth,
              modelId: modelRequest.modelId,
              messages: modelRequest.messages,
              tools: modelRequest.tools,
              promptCacheKey: this.callbacks.conversation.id,
              signal: this.turnAbort.signal,
            },
            iteration,
            {
              onTextDelta: (text) => assistantStream.pushText(text),
              onReasoningDelta: (text) => assistantStream.pushReasoning(text),
              onDiscardAttempt: () => assistantStream.discardAttempt(),
            },
            raisedMaxOutputTokens
          );
        } finally {
          await assistantStream.flush();
          assistantMessageId = assistantStream.messageId;
        }
        if (!result) {
          throw new Error("Cesium streaming adapter did not produce a result.");
        }
        await this.recordModelUsage(result.usage, modelRequest.modelId);
        result = (await this.pluginRuntime?.afterModel(result)) ?? result;
        result = { ...result, toolRequests: result.toolRequests.map((request) => this.withUniqueToolCallId(request)) };
        if (result.toolRequests.length === 0) {
          if (isEmptyCesiumAdapterResult(result)) {
            throw emptyModelResponseError(`${modelProviderId}/${modelPart(modelId)}`, result.raw);
          }
          this.acceptingSteers = false;
          const steers = await this.takeDeliverableSteers();
          if (steers.length > 0) {
            // A steer arrived while the model was writing its answer: keep the
            // answer in context, hand the model the steer, and keep going.
            this.acceptingSteers = true;
            if (result.text.trim()) {
              toolResultMessages.push({ role: "assistant", content: result.text.trim() });
            }
            assistantMessageId = await this.injectSteers(
              toolResultMessages,
              assistantMessageId,
              steers
            );
            continue;
          }
          history.push({ role: "assistant", content: result.text });
          await this.finishAssistant(assistantMessageId, result.raw);
          pluginOutcome = { status: "completed" };
          return;
        }
        toolResultMessages.push({
          role: "assistant",
          content: result.text.trim(),
          toolCalls: result.toolRequests.map((request) => ({
            id: request.id,
            name: request.name,
            arguments: JSON.stringify(request.arguments),
          })),
        });
        if (result.usage) {
          usageAnchor = {
            tokens: contextTokensAfterResponse(result.usage),
            messageCount: toolResultMessages.length,
          };
        }
        this.currentResponseId = `${assistantMessageId}:${iteration}`;
        const batchImages: Array<{ mimeType: string; data: string; source: string }> = [];
        for (const request of result.toolRequests) {
          if (this.cancelled) {
            return;
          }
          this.nextToolResultBudget = toolResultBudgetForHeadroom(
            contextWindow - DEFAULT_MAX_OUTPUT_TOKENS - contextTokensNow()
          );
          const toolResult = await this.executeTool(
            request,
            request.unparsedArgumentChars === undefined
              ? undefined
              : unparsedToolArgumentsResult(
                  request,
                  result.stopReason === "length" ? { outputTokens: result.usage?.outputTokens } : null
                )
          );
          const shape = this.toolResultShapes.get(request.id);
          this.toolResultShapes.delete(request.id);
          toolResultMessages.push({
            role: "tool",
            toolCallId: request.id,
            name: request.name,
            content: normalizeCesiumToolResultForModel({
              toolName: request.name,
              result: toolResult,
              budget: shape?.modelBudget,
              spillPath: shape?.spillPath,
            }).content,
          });
          batchImages.push(...this.pendingToolImages.splice(0, 4));
          this.pendingToolImages = [];
          completedToolCallCount += 1;
          if (completedToolCallCount % 8 === 0) {
            await this.emitConversationStatus(
              "running",
              `Cesium is continuing after ${completedToolCallCount} tool calls…`
            );
          }
        }
        if (batchImages.length > 0) {
          await this.attachToolImages(toolResultMessages, batchImages);
        }
        // Side chats: anything the primary did while those tools ran lands
        // here, after the tool results and before the next model call - the
        // only slot where appending keeps every earlier byte of the prompt
        // identical for the provider's prefix cache.
        await this.injectSideChatDeltas(toolResultMessages);
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
        }
        if (this.endTurnAfterTools) {
          this.endTurnAfterTools = false;
          this.acceptingSteers = false;
          const steers = await this.takeDeliverableSteers();
          if (steers.length === 0) {
            await this.finishAssistant(assistantMessageId, result.raw);
            pluginOutcome = { status: "completed" };
            return;
          }
          // The user wrote meanwhile: answer them instead of ending the turn.
          this.acceptingSteers = true;
          assistantMessageId = await this.injectSteers(toolResultMessages, assistantMessageId, steers);
          continue;
        }
        if (this.pendingSteers.length > 0) {
          assistantMessageId = await this.injectSteers(
            toolResultMessages,
            assistantMessageId,
            await this.takeDeliverableSteers()
          );
        }
        // A wrapped prompt is not in the log, so a rebuilt request would lose it.
        const contextTokens = contextTokensNow();
        if (
          !wrappedPrompt &&
          contextTokens >= pruneTriggerTokens(contextWindow) &&
          contextTokens >= pruneBlockedBelow
        ) {
          if (await this.pruneToolResultsAtBoundary(contextTokens, contextWindow)) {
            modelHistory = forModel(this.renderHistory(await this.readHistoryEvents()));
            toolResultMessages.length = 0;
            usageAnchor = null;
          } else {
            pruneBlockedBelow = contextTokens + contextWindow * 0.05;
          }
        }
      }
    } catch (error) {
      if (this.cancelled || error instanceof CesiumTurnCancelledError) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      pluginOutcome = { status: "failed", error: message };
      console.warn("[cesium-agent] turn failed:", message);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: message,
        pendingPermission: null,
        pendingQuestion: null,
      }));
    } finally {
      if (this.cancelled) {
        pluginOutcome = { status: "cancelled" };
      }
      this.acceptingSteers = false;
      await this.requeueUndeliveredSteers();
      this.endSideChatTurn();
      await this.pluginRuntime?.turnEnd(pluginOutcome);
      this.activeUserMessageId = null;
    }
  }

  /**
   * A coordinator that checks on its agents three times in a row is polling:
   * their reports only arrive after its turn, so the turn ends after this
   * batch of tools and the reports start the next one.
   */
  private afterCoordinatorTool(toolName: string, output: string): string {
    if (toolName !== "project_list_agents") {
      this.rosterChecksInARow = 0;
      return output;
    }
    this.rosterChecksInARow += 1;
    if (this.rosterChecksInARow < COORDINATOR_ROSTER_CHECKS_BEFORE_TURN_ENDS) {
      return output;
    }
    this.rosterChecksInARow = 0;
    this.endTurnAfterTools = true;
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return JSON.stringify({ ...parsed, turnEnds: COORDINATOR_TURN_ENDS_NOTE }, null, 2);
      }
    } catch {
      // Not JSON: the note goes after it.
    }
    return `${output}\n\n${COORDINATOR_TURN_ENDS_NOTE}`;
  }

  /** The model's id, or `<id>~2`, `<id>~3`… when this conversation already used it. */
  private withUniqueToolCallId(request: CesiumToolRequest): CesiumToolRequest {
    let id = request.id;
    for (let copy = 2; this.usedToolCallIds.has(id); copy += 1) {
      id = `${request.id}~${copy}`;
    }
    this.usedToolCallIds.add(id);
    return id === request.id ? request : { ...request, id };
  }

  /** A Project agent may also read and write its Project's context folder with the file tools. */
  private projectContextRoots(): string[] {
    const contextDir = projectAgentContextDir(this.callbacks.conversation.origin);
    return contextDir ? [contextDir] : [];
  }

  async steer(input: { text: string; userMessageId: string; queuedPromptId?: string }): Promise<boolean> {
    const text = input.text.trim();
    if (!text || this.disposed || this.cancelled || !this.acceptingSteers) {
      return false;
    }
    this.pendingSteers.push({
      text,
      userMessageId: input.userMessageId,
      ...(input.queuedPromptId ? { queuedPromptId: input.queuedPromptId } : {}),
    });
    return true;
  }

  /**
   * Takes the pending steers that can be delivered now. One that mirrors a
   * queued prompt leaves the queue here, with the entry's current text; if
   * the entry is gone (the user removed it) the steer is dropped.
   */
  private async takeDeliverableSteers(): Promise<PendingSteer[]> {
    const steers = this.pendingSteers.splice(0);
    if (!steers.some((steer) => steer.queuedPromptId)) {
      return steers;
    }
    const claimed = new Map<string, string>();
    await this.callbacks
      .updateConversation((current) => {
        const queued = current.queuedPrompts ?? [];
        for (const steer of steers) {
          const entry = steer.queuedPromptId ? queued.find((item) => item.id === steer.queuedPromptId) : undefined;
          if (entry) {
            claimed.set(entry.id, entry.text);
          }
        }
        return claimed.size === 0
          ? current
          : { ...current, queuedPrompts: queued.filter((item) => !claimed.has(item.id)) };
      })
      .catch(() => undefined);
    return steers.flatMap((steer) => {
      if (!steer.queuedPromptId) {
        return [steer];
      }
      const text = claimed.get(steer.queuedPromptId)?.trim();
      return text ? [{ ...steer, text }] : [];
    });
  }

  /**
   * Hand these steers to the model at the current position: close the
   * assistant message streamed so far, persist each steer as a visible user
   * message right here (so rebuilt history matches what the model saw), and
   * return a fresh assistant message id for the rest of the turn.
   */
  private async injectSteers(
    toolResultMessages: CesiumHistoryMessage[],
    assistantMessageId: string,
    steers: PendingSteer[]
  ): Promise<string> {
    if (steers.length === 0) {
      return assistantMessageId;
    }
    const conversationId = this.callbacks.conversation.id;
    const events: AgentEventInput[] = [
      {
        eventId: randomUUID(),
        conversationId,
        kind: "assistant_message_end",
        messageId: assistantMessageId,
        stopReason: "steered",
        ...this.takeMessageUsage(),
      },
    ];
    for (const steer of steers) {
      const content = formatMidTurnSteer(steer.text);
      events.push({
        eventId: randomUUID(),
        conversationId,
        kind: "user_message",
        messageId: steer.userMessageId,
        content,
        // A queued message the user typed shows as typed; an explicit steer says so.
        displayContent: steer.queuedPromptId ? steer.text : `Steer: ${steer.text}`,
      });
      toolResultMessages.push({ role: "user", content });
    }
    await this.callbacks.appendEvents(events);
    return `cesium-assistant-${randomUUID()}`;
  }

  /**
   * Steers accepted but never shown to the model because the turn failed go
   * back on the queue with steer framing. A stop drops them along with the
   * rest of the queue, matching `cancelConversation`.
   */
  private async requeueUndeliveredSteers(): Promise<void> {
    // A steer mirroring a queued prompt never left the queue.
    const leftover = this.pendingSteers.splice(0).filter((steer) => !steer.queuedPromptId);
    if (leftover.length === 0 || this.cancelled || this.disposed) {
      return;
    }
    await this.callbacks
      .updateConversation((current) => ({
        ...current,
        queuedPrompts: [
          ...leftover.map((steer) => ({
            id: randomUUID(),
            text: steer.text,
            delivery: "steer" as const,
          })),
          ...(current.queuedPrompts ?? []),
        ],
      }))
      .catch(() => undefined);
  }

  /**
   * Side chats: start tailing the parent before reading the idle delta so no
   * parent event can slip between the read and the subscription, then drop
   * whatever the delta already covered. Returns the turn-start payload (if
   * any) for the caller to persist next to the mode reminder.
   */
  private async beginSideChatTurn(): Promise<{
    origin: SideChatOrigin;
    parent: AgentConversationRecord | null;
    payload: SideChatReminderPayload | null;
  } | null> {
    const origin = sideChatOriginOf(this.callbacks.conversation);
    if (!origin) {
      return null;
    }
    this.endSideChatTurn();
    const tail = new SideChatTail({
      workspaceId: this.callbacks.workspace.id,
      parentConversationId: origin.parentConversationId,
      sinceSeq: 0,
    });
    tail.attach();
    this.sideChatTail = tail;
    try {
      const resolution = await resolveSideChatDelta({
        workspaceId: this.callbacks.workspace.id,
        sideChat: this.callbacks.conversation,
        limits: this.harness.settings.limits,
      });
      if (!resolution) {
        return null;
      }
      this.sideChatCursor = resolution.throughSeq;
      this.sideChatParentUnavailableNoticed = resolution.parent === null;
      tail.discardThrough(resolution.throughSeq);
      return { origin, parent: resolution.parent, payload: resolution.payload };
    } catch (error) {
      console.warn(
        "[cesium-agent] side chat: failed to resolve primary-chat context at turn start:",
        error instanceof Error ? error.message : error
      );
      return { origin, parent: null, payload: null };
    }
  }

  /**
   * Side chats: deliver parent activity buffered during the last tool batch as
   * one inline block. Appended to the in-memory tail and persisted in the same
   * position so the next history rebuild is byte-identical to what the model
   * sees now. Noise-only slices advance the cursor without emitting anything.
   */
  /**
   * Vision attachments cannot ride on tool-role messages in the
   * OpenAI-compatible protocol, so a batch's tool images follow its tool
   * results as one user message. It is persisted as an inline reminder with
   * the image data so later turns rebuild the exact message the model saw.
   */
  private async attachToolImages(
    toolResultMessages: CesiumHistoryMessage[],
    images: Array<{ mimeType: string; data: string; source: string }>
  ): Promise<void> {
    const content = `[Attached ${images.length} image(s) captured by ${images
      .map((image) => image.source)
      .join(", ")} for your review.]`;
    const stored = images.map((image) => ({ mimeType: image.mimeType, data: image.data }));
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system_reminder",
        reminderId: `tool-images-${randomUUID()}`,
        reason: "attachments",
        placement: "inline",
        text: content,
        images: stored,
      },
    ]);
    toolResultMessages.push({ role: "user", content, images: stored });
  }

  private async injectSideChatDeltas(toolResultMessages: CesiumHistoryMessage[]): Promise<void> {
    const tail = this.sideChatTail;
    const origin = sideChatOriginOf(this.callbacks.conversation);
    if (!tail || !origin || this.cancelled) {
      return;
    }
    let payload: SideChatReminderPayload | null = null;
    try {
      if (tail.parentDeleted) {
        tail.drain();
        payload = unavailablePayloadFor({
          origin,
          cursor: this.sideChatCursor,
          alreadyNoticed: this.sideChatParentUnavailableNoticed,
        });
        this.sideChatParentUnavailableNoticed = true;
      } else if (tail.hasPending()) {
        const parentEvents = tail.drain();
        const parent = await readConversationRecord(
          this.callbacks.workspace.id,
          origin.parentConversationId
        ).catch(() => null);
        if (parent) {
          payload = deltaPayloadFor({
            parent,
            parentEvents,
            fromSeq: this.sideChatCursor,
            limits: this.harness.settings.limits,
          });
        } else {
          payload = unavailablePayloadFor({
            origin,
            cursor: this.sideChatCursor,
            alreadyNoticed: this.sideChatParentUnavailableNoticed,
          });
          this.sideChatParentUnavailableNoticed = true;
        }
        this.sideChatCursor = Math.max(this.sideChatCursor, tail.throughSeq);
      }
      if (!payload) {
        return;
      }
      await this.callbacks.appendEvents([
        sideChatInlineReminderEvent({
          sideChatId: this.callbacks.conversation.id,
          payload,
        }),
      ]);
      toolResultMessages.push({ role: "user", content: payload.text });
    } catch (error) {
      console.warn(
        "[cesium-agent] side chat: failed to inject primary-chat delta:",
        error instanceof Error ? error.message : error
      );
    }
  }

  private endSideChatTurn(): void {
    this.sideChatTail?.detach();
    this.sideChatTail = null;
  }

  /**
   * Runs one model call with transient-failure retries. A reply cut off at the
   * output-token limit is retried once at `raisedMaxOutputTokens`, outside the
   * transient retry budget.
   */
  private async runAdapterWithWarning(
    input: RunAdapterInput,
    iteration: number,
    handlers: CesiumAdapterStreamHandlers = {},
    raisedMaxOutputTokens?: number
  ): Promise<CesiumAdapterResult> {
    const providerId = providerPart(input.modelId);
    const timer = setTimeout(() => {
      void this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text:
            `Still waiting for ${providerId} to return a response after ` +
            `${Math.round(CESIUM_RESPONSE_WARNING_MS / 60_000)} minutes. ` +
            "Cesium is not cancelling the request.",
          raw: { modelId: input.modelId, iteration },
        },
      ]).catch(() => undefined);
    }, CESIUM_RESPONSE_WARNING_MS);
    // Projects turns also retry a reply that comes back empty, reasoning-only,
    // or as an error payload inside an HTTP 200, instead of failing the turn.
    const retryEmptyReplies = await isProjectsEnabled();
    const model = `${providerId}/${modelPart(input.modelId)}`;
    let request = input;
    try {
      for (let retryIndex = 0; ; ) {
        if (this.cancelled) {
          throw new CesiumTurnCancelledError();
        }
        const attempts = retryIndex + 1;
        const progress = { emittedText: false, emittedToolCall: false };
        let failure: unknown;
        let failureMessage: string;
        let retryable: boolean;
        try {
          const result = await this.streamAdapterAttempt(
            request,
            handlers,
            progress,
            retryEmptyReplies
          );
          if (
            result.stopReason === "length" &&
            raisedMaxOutputTokens !== undefined &&
            raisedMaxOutputTokens > (request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)
          ) {
            console.warn(
              `[cesium-agent] ${model} hit the ${request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS}-token output limit, retrying with ${raisedMaxOutputTokens}`
            );
            await handlers.onDiscardAttempt?.();
            await this.emitConversationStatus(
              "running",
              "The reply hit the output limit, so Cesium is asking again with more room…"
            );
            request = { ...request, maxOutputTokens: raisedMaxOutputTokens };
            continue;
          }
          if (!retryEmptyReplies || !isEmptyCesiumAdapterResult(result)) {
            return result;
          }
          const upstream = findUpstreamErrorPayload(result.raw);
          if (upstream) {
            failureMessage = upstream.message;
            retryable = upstream.retryable;
            failure = new Error(
              `${model} returned an error instead of a reply` +
                `${attempts > 1 ? ` after ${attempts} attempts` : ""}: ${upstream.message}`
            );
          } else {
            failureMessage = "empty model response";
            retryable = true;
            failure = emptyModelResponseError(model, result.raw, attempts);
          }
        } catch (error) {
          if (error instanceof CesiumTurnCancelledError || this.cancelled || this.disposed) {
            throw new CesiumTurnCancelledError();
          }
          failure = error;
          failureMessage = providerFailureMessage(error);
          retryable = isTransientProviderCompletionError(failureMessage);
        }
        if (retryIndex >= COMPLETION_AUTO_RETRY_MAX_ATTEMPTS || progress.emittedToolCall || !retryable) {
          throw failure;
        }
        const delayMs = completionRetryDelayMs(retryIndex);
        retryIndex += 1;
        console.warn(
          `[cesium-agent] provider attempt ${attempts} failed, retrying (${attempts}/${COMPLETION_AUTO_RETRY_MAX_ATTEMPTS}) in ${delayMs}ms:`,
          truncate(failureMessage, 500)
        );
        await handlers.onDiscardAttempt?.();
        await this.emitConversationStatus(
          "running",
          formatTakingLongerStatusDetail(attempts, COMPLETION_AUTO_RETRY_MAX_ATTEMPTS)
        );
        await sleepMs(delayMs, request.signal);
        if (this.cancelled) {
          throw new CesiumTurnCancelledError();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Streams one model attempt into `handlers`. With `holdBlankText`, text
   * deltas wait until the reply has visible text, so an attempt that turns out
   * empty persists nothing and can be retried cleanly.
   */
  private async streamAdapterAttempt(
    input: RunAdapterInput,
    handlers: CesiumAdapterStreamHandlers,
    progress: { emittedText: boolean; emittedToolCall: boolean },
    holdBlankText: boolean
  ): Promise<CesiumAdapterResult> {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolRequests: CesiumToolRequest[] = [];
    const rawEvents: unknown[] = [];
    let finalRaw: unknown;
    let heldText = "";
    let usage: CesiumAdapterResult["usage"];
    let stopReason: CesiumAdapterResult["stopReason"];
    for await (const event of streamAdapter(input)) {
      if (this.cancelled) {
        throw new CesiumTurnCancelledError();
      }
      if ("raw" in event && event.raw !== undefined) {
        finalRaw = event.raw;
        rawEvents.push(event.raw);
      }
      switch (event.kind) {
        case "text_delta": {
          textParts.push(event.text);
          if (holdBlankText && !progress.emittedText) {
            heldText += event.text;
            if (!heldText.trim()) {
              break;
            }
          }
          const text = heldText || event.text;
          heldText = "";
          progress.emittedText = progress.emittedText || text.trim().length > 0;
          await handlers.onTextDelta?.(text);
          break;
        }
        case "reasoning_delta":
          reasoningParts.push(event.text);
          await handlers.onReasoningDelta?.(event.text);
          break;
        case "tool_request":
          toolRequests.push(event.request);
          progress.emittedToolCall = true;
          break;
        case "usage":
          usage = event.usage;
          break;
        case "done":
          stopReason = event.stopReason ?? stopReason;
          break;
        case "raw":
          break;
      }
    }
    return {
      text: textParts.join(""),
      reasoning: reasoningParts.join("") || undefined,
      toolRequests,
      ...(usage ? { usage } : {}),
      ...(stopReason ? { stopReason } : {}),
      raw: rawEvents.length > 1 ? rawEvents : finalRaw,
    };
  }

  async pause(): Promise<void> {
    if (this.disposed || this.cancelled) {
      return;
    }
    if (
      this.pausePhase === "pause_requested" ||
      this.pausePhase === "pausing" ||
      this.pausePhase === "paused"
    ) {
      return;
    }
    this.pausePhase = "pause_requested";
    await this.emitConversationStatus("pause_requested", "Pause requested…");
  }

  async resume(): Promise<void> {
    if (this.pausePhase !== "paused") {
      return;
    }
    await new Promise<void>((resolve) => {
      this.resumeAck = resolve;
      this.resumeWaiter?.();
    });
  }

  private releaseResumeAck(): void {
    this.resumeAck?.();
    this.resumeAck = null;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.turnAbort.abort(new CesiumTurnCancelledError());
    this.acceptingSteers = false;
    this.pendingSteers = [];
    this.pausePhase = "none";
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.releaseResumeAck();
    for (const permission of this.pendingPermissions.values()) {
      permission.reject(new Error("Cesium turn cancelled."));
    }
    this.pendingPermissions.clear();
    for (const question of this.pendingQuestions.values()) {
      question.reject(new Error("Cesium turn cancelled."));
    }
    this.pendingQuestions.clear();
    this.killTerminalRuns();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Cesium turn cancelled.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "cancelled",
      providerSessionId: null,
      pendingPermission: null,
      pendingQuestion: null,
    }));
  }

  private async emitConversationStatus(
    status: AgentConversationStatus,
    detail: string
  ): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status,
        detail,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status,
    }));
  }

  private async waitAtPauseCheckpoint(): Promise<void> {
    if (this.pausePhase !== "pause_requested") {
      return;
    }
    this.pausePhase = "pausing";
    await this.emitConversationStatus("pausing", "Finishing current step…");
    if (this.cancelled || this.disposed || this.pausePhase !== "pausing") {
      this.releaseResumeAck();
      return;
    }
    this.pausePhase = "paused";
    await this.emitConversationStatus("paused", "Cesium is paused.");
    if (this.cancelled || this.disposed || this.pausePhase !== "paused") {
      this.releaseResumeAck();
      return;
    }
    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve;
    });
    this.resumeWaiter = null;
    if (this.cancelled || this.disposed) {
      this.releaseResumeAck();
      return;
    }
    this.pausePhase = "none";
    await this.emitConversationStatus("running", "Cesium resumed.");
    this.releaseResumeAck();
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
    const modelOption = this.configOptions.find((option) => option.id === "model");
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
      config: {
        ...current.config,
        modelId: modelOption?.currentValue ?? current.config.modelId,
        modelName:
          modelOption?.options.find((option) => option.value === modelOption.currentValue)?.name ??
          current.config.modelName,
      },
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const pending = this.pendingPermissions.get(input.requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(input.requestId);
    if (input.cancelled) {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId: input.requestId,
          outcome: "cancelled",
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: "Permission cancelled.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "running",
        pendingPermission: null,
      }));
      pending.resolve("reject");
      return;
    }
    const decision = permissionDecisionFromOption(input.optionId);
    const optionId = input.optionId;
    if (isPersistentPermissionOptionId(optionId)) {
      await saveRememberedAgentPermissionRule({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: pending.toolKey,
        toolLabel: pending.toolLabel,
        decision,
        optionId,
        optionKind: optionId,
        permissionCategory: pending.permissionCategory,
        matchStyle: "exact",
      }).catch(() => undefined);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: "selected",
        optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: decision === "allow" ? "Permission allowed." : "Permission rejected.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
    pending.resolve(decision === "allow" ? "allow" : "reject");
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const pending = this.pendingQuestions.get(input.questionId);
    if (!pending) {
      return;
    }
    this.pendingQuestions.delete(input.questionId);
    const answer = input.answer.trim();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: pending.prompt,
        options: pending.options,
        questions: pending.questions,
        allowMultiple: pending.allowMultiple,
        status: "answered",
        answer,
        raw: pending.raw,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "Question answered.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
    pending.resolve(answer);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.turnAbort.abort(new CesiumTurnCancelledError());
    this.pausePhase = "none";
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.releaseResumeAck();
    this.endSideChatTurn();
    this.subagentsV2?.dispose();
    this.subagentsV2 = null;
    await this.pluginRuntime?.dispose();
    this.pluginRuntime = null;
    for (const permission of this.pendingPermissions.values()) {
      permission.reject(new Error("Cesium session disposed."));
    }
    this.pendingPermissions.clear();
    for (const question of this.pendingQuestions.values()) {
      question.reject(new Error("Cesium session disposed."));
    }
    this.pendingQuestions.clear();
    // Background terminal runs would otherwise outlive the session as zombies.
    this.killTerminalRuns();
  }

  private async refreshHarnessFromSettings(): Promise<void> {
    await loadCesiumHarnessPluginModulesFromEnv(
      CESIUM_FEATURE_REGISTRY,
      this.callbacks.workspace.root
    );
    const settings = await getCesiumAgentSettings();
    const signature = JSON.stringify({
      harness: settings.harness,
      registryRevision: CESIUM_FEATURE_REGISTRY.revision(),
    });
    if (signature !== this.harnessSignature) {
      await this.pluginRuntime?.dispose();
      this.harness = resolveCesiumTools(settings.harness);
      this.harnessSignature = signature;
      this.pluginRuntime = new CesiumHarnessPluginRuntime({
        modules: this.harness.modules,
        hookTimeoutMs: this.harness.settings.limits.pluginHookTimeoutMs,
        context: () => ({
          sessionId: this.sessionId,
          conversationId: this.callbacks.conversation.id,
          workspaceId: this.callbacks.workspace.id,
          workspaceRoot: this.callbacks.workspace.root,
          modelId: String(
            optionValue(
              this.configOptions,
              "model",
              this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
            )
          ),
        }),
        onDiagnostic: async (diagnostic) => {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "system",
              level: "warning",
              text:
                `Harness plugin ${diagnostic.pluginId}@${diagnostic.pluginVersion} ` +
                `failed in ${diagnostic.hook}: ${diagnostic.message}`,
              raw: { harnessPluginDiagnostic: diagnostic },
            },
          ]);
        },
      });
      await this.pluginRuntime.start();
    }
    await this.refreshModelRoster();
    this.activeSystemPrompt =
      (await this.pluginRuntime?.transformSystemPrompt(this.baseSystemPrompt())) ??
      this.baseSystemPrompt();
    if (this.harness.subagentsVersion === 2) {
      const runtime = this.ensureSubagentsV2();
      runtime.updateLimits(this.harness.settings.limits);
    } else if (this.subagentsV2) {
      this.subagentsV2.dispose();
      this.subagentsV2 = null;
    }
  }

  private ensureSubagentsV2(): SubagentsV2Runtime {
    if (this.harness.subagentsVersion !== 2) {
      throw new Error(
        "Subagents V2 tools require harness.features.subagents.version = 2. Enable Subagents V2 in Settings → Agents → Cesium Agent."
      );
    }
    if (!this.subagentsV2) {
      const modelId =
        resolvedModelId(this.callbacks.conversation.config.modelId, this.configOptions) ||
        this.callbacks.conversation.config.modelId ||
        "openai/gpt-5.1";
      this.subagentsV2 = new SubagentsV2Runtime({
        conversationId: this.callbacks.conversation.id,
        limits: this.harness.settings.limits,
        defaultModelId: modelId,
        // Children inherit the parent's live model (mid-conversation switches
        // included) and overrides must clear the user's Model access filter.
        resolveDefaultModelId: () => this.currentModelId(),
        resolveSpawnModel: (requested, defaultModelId) =>
          resolveCesiumSpawnModelId({ requested, defaultModelId }),
        modelRoster: () => this.modelRosterText,
        defaultApiKind: optionValue(
          this.configOptions,
          "api_kind",
          "openai-responses"
        ) as CesiumProviderKind,
        appendEvents: async (events) => {
          await this.callbacks.appendEvents(events as Parameters<typeof this.callbacks.appendEvents>[0]);
        },
        getParentHistory: async () => {
          const snapshot = await this.callbacks.readSnapshot();
          return normalizeEventsToHistory(snapshot?.events ?? []).filter(
            (message) => message.role !== "system"
          );
        },
        isCancelled: () => this.cancelled || this.disposed,
        toolsetForAgent: (agentPath) => this.buildSubagentToolset(agentPath),
        readPersistedTranscript: (subagentId) =>
          this.readPersistedSubagentTranscript(subagentId),
      });
    }
    return this.subagentsV2;
  }

  /**
   * Tool surface for spawned subagents. Codex MultiAgentV2 parity: children
   * share the parent's workspace tools (files, terminal, MCP, browser) and -
   * for V2 collaborative children - the collaboration tools themselves, with
   * spawn depth enforced by the runtime. Every gated call flows through the
   * same permission cascade as the parent agent.
   *
   * `agentPath` is the child's canonical path for V2 children, or null for
   * the legacy single-shot `subagent` tool (no collaboration surface).
   */
  private buildSubagentToolset(agentPath: string | null): CesiumSubagentToolset {
    const includeCollaboration = agentPath != null && this.harness.subagentsVersion === 2;
    const definitions = subagentToolDefinitions({
      hostTools: this.advertisedTools(),
      includeCollaboration,
    });
    return createSubagentToolset({
      definitions,
      execute: (name, args) => this.executeSubagentTool(agentPath, name, args, definitions),
    });
  }

  private async executeSubagentTool(
    agentPath: string | null,
    name: string,
    args: Record<string, unknown>,
    definitions: CesiumToolDefinition[]
  ): Promise<string> {
    const callerPath = agentPath ?? "/root (ephemeral subagent)";
    if (this.isReadOnlyHelper() && !READ_ONLY_HELPER_TOOLS.has(name)) {
      throw new Error(`${name} is not available to a read-only explorer's subagents.`);
    }
    const isBrowserTool = name.startsWith("browser_");
    // Direct browser tools are permission-equivalent to calling the built-in
    // browser MCP server through call_mcp_tool.
    const permissionCategory = isBrowserTool
      ? resolveCesiumToolPermissionCategory(this.harness.tools, "call_mcp_tool")
      : resolveCesiumToolPermissionCategory(definitions, name);
    if (permissionCategory) {
      const permissionArgs = isBrowserTool
        ? { serverId: BROWSER_MCP_SERVER_ID, toolName: name, arguments: args }
        : permissionCategory === "mcpCall"
          ? (() => {
              const normalized = normalizeCallMcpToolArgs(args);
              return {
                serverId: normalized.serverId,
                toolName: normalized.toolName,
                arguments: normalized.arguments,
              };
            })()
          : args;
      const title = `Subagent ${callerPath} · ${toolTitle(
        isBrowserTool ? "call_mcp_tool" : name,
        isBrowserTool ? { serverId: BROWSER_MCP_SERVER_ID, toolName: name } : args
      )}`;
      await this.requirePermission({
        toolCallId: randomUUID(),
        title,
        detail: this.buildPermissionDetail(permissionCategory, permissionArgs),
        permission: permissionCategory,
        toolKey: cesiumPermissionToolKey(permissionCategory, permissionArgs),
        toolLabel: title,
      });
    }
    if (isBrowserTool) {
      return await callBuiltInBrowserTool({
        workspaceId: this.callbacks.workspace.id,
        workspaceRoot: this.callbacks.workspace.root,
        toolName: name,
        arguments: args,
      });
    }
    switch (name) {
      case "read_file":
        return await this.toolReadFile(args);
      case "grep":
        return await this.toolGrep(args);
      case "write_file":
        return await this.toolWriteFile(args, randomUUID());
      case "edit_file":
        return await this.toolEditFile(args, randomUUID(), toolTitle(name, args));
      case "terminal":
        return await this.toolTerminal(args);
      case "wait":
        return await this.toolWait(args);
      case "call_mcp_tool":
        return await this.toolCallMcp(args);
      default:
        break;
    }
    if (agentPath != null && this.harness.subagentsVersion === 2) {
      const runtime = this.ensureSubagentsV2();
      switch (name) {
        case "spawn_agent":
          return await runtime.spawnAgent(args, agentPath);
        case "send_message":
          return await runtime.sendMessage(args, agentPath);
        case "followup_task":
          return await runtime.followupTask(args, agentPath);
        case "wait_agent":
          return await runtime.waitAgent(args, agentPath);
        case "interrupt_agent":
          return await runtime.interruptAgent(args, agentPath);
        case "list_agents":
          return JSON.stringify(runtime.listAgents(asString(args.path_prefix)));
        case "read_subagent_transcript":
          return await runtime.readTranscript(args, agentPath);
        default:
          break;
      }
    }
    throw new Error(`Tool ${name} is not available to subagents.`);
  }

  private async executeSubagentsV2Tool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (!isSubagentsV2ToolName(name) && name !== "list_agents") {
      throw new Error(`Unknown Subagents V2 tool: ${name}`);
    }
    const runtime = this.ensureSubagentsV2();
    switch (name) {
      case "spawn_agent":
        return runtime.spawnAgent(args);
      case "send_message":
        return runtime.sendMessage(args);
      case "followup_task":
        return runtime.followupTask(args);
      case "wait_agent":
        return runtime.waitAgent(args);
      case "interrupt_agent":
        return runtime.interruptAgent(args);
      case "list_agents":
        return JSON.stringify({ agents: runtime.listAgents(asString(args.path_prefix) ?? asString(args.pathPrefix)) });
      default:
        throw new Error(`Unknown Subagents V2 tool: ${name}`);
    }
  }

  private killTerminalRuns(): void {
    for (const run of this.terminalRuns.values()) {
      if (run.exitCode === undefined) {
        run.process.kill();
      }
    }
    this.terminalRuns.clear();
  }

  /** Adds one model response's usage to the current message and to the conversation's Goal. */
  private async recordModelUsage(
    usage: AgentTokenUsage | undefined,
    modelId: string
  ): Promise<void> {
    if (!usage) {
      return;
    }
    this.messageUsage = {
      last: { ...usage, modelId },
      total: addTokenUsage(this.messageUsage.total, usage),
      responses: this.messageUsage.responses + 1,
    };
    const goal = await readGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    }).catch(() => null);
    if (goal && !["complete", "cancelled"].includes(goal.status)) {
      await updateGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch: { tokensUsed: goal.tokensUsed + usage.inputTokens + usage.outputTokens },
      }).catch(() => undefined);
    }
  }

  /** The usage fields for an `assistant_message_end`; the next message starts counting from zero. */
  private takeMessageUsage(): Pick<
    Extract<AgentEventInput, { kind: "assistant_message_end" }>,
    "usage" | "turnUsage"
  > {
    const { last, total, responses } = this.messageUsage;
    this.messageUsage = { responses: 0 };
    return last && total ? { usage: last, turnUsage: { ...total, responses } } : {};
  }

  private async finishAssistant(messageId: string, raw?: unknown): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId,
        stopReason: "end_turn",
        ...this.takeMessageUsage(),
        raw,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "idle",
        detail: "Cesium turn complete.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      providerSessionId: this.sessionId,
      configOptions: this.configOptions,
    }));
  }

  /** Every stored event of this conversation (the snapshot head can be truncated). */
  private async readHistoryEvents(): Promise<AgentStoredEvent[]> {
    const snapshot = await this.callbacks.readSnapshot();
    const snapshotEvents = snapshot?.events ?? [];
    const fullEvents = await readConversationEvents(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => snapshotEvents);
    const events = fullEvents.length > snapshotEvents.length ? fullEvents : snapshotEvents;
    for (const event of events) {
      if (event.kind === "tool_call") {
        this.usedToolCallIds.add(event.toolCallId);
      }
    }
    return events;
  }

  /**
   * The model's view of the log: system prompt, the newest compaction summary
   * (if any), then every visible event after it. Nothing inside the window is
   * dropped or reordered between turns, so each request extends the last.
   */
  private renderHistory(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
    const window = selectHistoryWindow(events);
    const visible = window.events.filter(
      (event) => event.kind !== "user_message" || !event.hidden
    );
    return [
      { role: "system", content: this.activeSystemPrompt },
      ...(window.summary
        ? [{ role: "user" as const, content: `[Compressed earlier conversation]\n${window.summary.summary}` }]
        : []),
      ...normalizeEventsToHistory(visible, CESIUM_SYSTEM_PROMPT, prunedToolCallIds(window)).slice(1),
    ];
  }

  /**
   * Mid-turn, when the context nears the window: stubs the oldest tool
   * outputs in one persisted step. The request after it starts a new prefix;
   * every request after that, and the next turn's rebuild, extends it.
   */
  private async pruneToolResultsAtBoundary(contextTokens: number, contextWindow: number): Promise<boolean> {
    const events = await this.readHistoryEvents();
    const window = selectHistoryWindow(events);
    const plan = planToolResultPruning({
      windowEvents: window.events,
      alreadyPruned: prunedToolCallIds(window),
      excessTokens: contextTokens - contextWindow * CONTEXT_PRUNE_TARGET_RATIO,
    });
    if (plan.toolCallIds.length === 0) {
      return false;
    }
    await this.emitConversationStatus(
      "running",
      `Pruning ${plan.toolCallIds.length} older tool output${plan.toolCallIds.length === 1 ? "" : "s"} to free context…`
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "compression_summary",
        messageId: `cesium-prune-${randomUUID()}`,
        summary: "",
        retainedTurnCount: window.events.filter(
          (event) => event.kind === "user_message" && !event.hidden
        ).length,
        compressedTurnCount: 0,
        prunedToolCallIds: plan.toolCallIds,
        estimatedTokensBefore: contextTokens,
        estimatedTokensAfter: Math.max(0, contextTokens - plan.freedTokens),
        generation: window.summary?.generation ?? 0,
      },
    ]);
    return true;
  }

  /**
   * Compacts once the window outgrows its turn or token budget: the newest
   * turns stay verbatim and a summary replaces the rest. The window then stays
   * fixed until it outgrows the budget again, instead of sliding every turn.
   */
  private async compactHistoryIfNeeded(events: AgentStoredEvent[]): Promise<boolean> {
    const window = selectHistoryWindow(events);
    const visibleUsers = window.events.filter(
      (event) => event.kind === "user_message" && !event.hidden
    );
    const modelId = optionValue(
      this.configOptions,
      "model",
      this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
    );
    const contextWindow = await resolveCesiumModelContextWindow(modelId).catch(() => 100_000);
    const estimated = estimateHistoryTokens(this.renderHistory(events));
    const estimatedTokensBefore = reportedContextTokens(window.events, modelId) ?? estimated;
    if (
      visibleUsers.length <= HISTORY_TURN_LIMIT &&
      estimatedTokensBefore < contextWindow * HISTORY_COMPACTION_THRESHOLD_RATIO
    ) {
      return false;
    }
    // Keep the newest turns that fit the target, sized in reported tokens
    // where the provider counted them, so the kept window does not start out
    // over the threshold and re-compact on the next turn.
    const scale = estimated > 0 ? Math.max(1, estimatedTokensBefore / estimated) : 1;
    const target = contextWindow * HISTORY_COMPACTION_TARGET_RATIO;
    const pruned = prunedToolCallIds(window);
    let retainedTokens = 0;
    let splitSeq = visibleUsers.at(-1)?.seq ?? Number.POSITIVE_INFINITY;
    let retainedUsers = 0;
    for (let index = visibleUsers.length - 1; index >= 0; index -= 1) {
      const turnStart = visibleUsers[index]!.seq;
      const turnEnd = visibleUsers[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
      const turnEvents = window.events.filter((event) => event.seq >= turnStart && event.seq < turnEnd);
      const turnTokens = Math.ceil(
        estimateHistoryTokens(normalizeEventsToHistory(turnEvents, CESIUM_SYSTEM_PROMPT, pruned).slice(1)) * scale
      );
      if (
        retainedUsers > 0 &&
        (retainedUsers >= HISTORY_COMPACTION_TARGET_TURNS || retainedTokens + turnTokens > target)
      ) {
        break;
      }
      retainedTokens += turnTokens;
      retainedUsers += 1;
      splitSeq = turnStart;
    }
    const retainedWindow = window.events.filter((event) => event.seq >= splitSeq);
    const prune = planToolResultPruning({
      windowEvents: retainedWindow,
      alreadyPruned: pruned,
      excessTokens: retainedTokens - target,
    });
    const compacts = window.events.some(
      (event) => event.seq < splitSeq && event.kind === "user_message" && !event.hidden
    );
    if (!compacts && prune.toolCallIds.length === 0) {
      return false;
    }
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const compressed = compacts
      ? sorted.filter((event) => event.seq < splitSeq && event.kind !== "compression_summary")
      : [];
    await this.emitConversationStatus("running", formatCompressingContextStatusDetail());
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "compression_summary",
        messageId: `cesium-compression-${randomUUID()}`,
        summary: compacts ? summarizeForCompression(compressed) : "",
        retainedTurnCount: retainedUsers,
        compressedTurnCount: compressed.filter(
          (event) => event.kind === "user_message" && !event.hidden
        ).length,
        ...(compacts
          ? {
              sourceRange: {
                fromSeq: compressed[0]?.seq ?? 0,
                toSeq: Math.max(...window.events.filter((event) => event.seq < splitSeq).map((event) => event.seq)),
              },
            }
          : {}),
        ...(prune.toolCallIds.length > 0 ? { prunedToolCallIds: prune.toolCallIds } : {}),
        estimatedTokensBefore,
        estimatedTokensAfter: Math.max(0, retainedTokens - prune.freedTokens),
        generation: (window.summary?.generation ?? 0) + (compacts ? 1 : 0),
      },
    ]);
    return true;
  }


  private async buildHistory(currentUserMessageId: string): Promise<{
    messages: CesiumHistoryMessage[];
    /** The current turn's stored user text, when it is part of the rendered window. */
    currentUserContent: string | null;
  }> {
    const events = await this.readHistoryEvents();
    const current = selectHistoryWindow(events).events.find(
      (event): event is Extract<AgentStoredEvent, { kind: "user_message" }> =>
        event.kind === "user_message" && event.messageId === currentUserMessageId && !event.hidden
    );
    return { messages: this.renderHistory(events), currentUserContent: current?.content ?? null };
  }

  private async requirePermission(input: {
    toolCallId: string;
    title: string;
    detail: string;
    permission: AgentPermissionCategory;
    toolKey: string;
    toolLabel: string;
  }): Promise<void> {
    const assignment = await findOrchestrationAssignmentForConversation(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => null);
    // Only edit/terminal/mcp are orchestration-policy-controlled. Other categories
    // (e.g. switchMode) fall through to the normal Cesium/global cascade.
    if (assignment && isOrchestrationPermissionCategory(input.permission)) {
      const orchestrationPolicy =
        assignment.config.permissionPolicy?.[input.permission] ?? "allow";
      if (orchestrationPolicy === "allow") {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Allowed ${input.title} by orchestration assignment policy.`,
          },
        ]);
        return;
      }
      if (orchestrationPolicy === "deny") {
        throw new Error(`${input.title} blocked by orchestration assignment policy.`);
      }
    }

    const [settings, globalSettings] = await Promise.all([
      getCesiumAgentSettings(),
      getGlobalSettings().catch(() => null),
    ]);
    let policy =
      settings.toolPermissions[input.permission as CesiumToolPermissionCategory] ?? "ask";
    if (input.permission === "mcpCall" && globalSettings?.agents.mcpProt) {
      policy = "ask";
    }
    if (policy === "deny") {
      throw new Error(`${input.title} blocked by Cesium permission settings.`);
    }

    const remembered = findMatchingRememberedPermissionRule(
      globalSettings?.agents.rememberedPermissions ?? [],
      {
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: input.toolKey,
        permissionCategory: input.permission,
      }
    );
    if (remembered) {
      if (remembered.decision === "reject") {
        throw new Error(
          `${input.title} rejected by remembered permission for ${remembered.toolLabel}.`
        );
      }
      const requestId = randomUUID();
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome: "selected",
          optionId: remembered.optionId,
          raw: {
            rememberedPermission: {
              id: remembered.id,
              decision: remembered.decision,
              toolLabel: remembered.toolLabel,
              permissionCategory: remembered.permissionCategory ?? input.permission,
              matchStyle: remembered.matchStyle ?? "exact",
            },
          },
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Used remembered permission for ${remembered.toolLabel}.`,
        },
      ]);
      return;
    }

    if (projectAgentActsWithoutAsking(this.callbacks.conversation.origin)) {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Allowed ${input.title}: this Project's agents act without asking.`,
        },
      ]);
      return;
    }

    if (globalSettings?.agents.autoAcceptAllAgentPermissions) {
      const requestId = randomUUID();
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome: "selected",
          optionId: "allow_once",
          raw: {
            autoAcceptedAll: true,
            permissionCategory: input.permission,
            toolKey: input.toolKey,
          },
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Auto-accepted ${input.title} (auto-accept all permissions).`,
        },
      ]);
      return;
    }

    if (policy === "allow") {
      return;
    }

    const requestId = randomUUID();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_request",
        requestId,
        toolCallId: input.toolCallId,
        title: input.title,
        detail: input.detail,
        options: STANDARD_PERMISSION_OPTIONS,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: {
        requestId,
        requestedAt: Date.now(),
        toolCallId: input.toolCallId,
        permission: input.permission,
        title: input.title,
        detail: input.detail,
        options: STANDARD_PERMISSION_OPTIONS,
      },
    }));
    const decision = await new Promise<"allow" | "reject">((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        toolKey: input.toolKey,
        toolLabel: input.toolLabel,
        permissionCategory: input.permission,
      });
    });
    if (decision !== "allow") {
      throw new PermissionRefusedToolCallError();
    }
  }

  /** Runs the plugin `afterTool` hook and records the successful tool result. */
  private async completeToolCall(
    request: CesiumToolRequest,
    title: string,
    toolDefinition: CesiumToolDefinition | undefined,
    output: string
  ): Promise<string> {
    const result = (await this.pluginRuntime?.afterTool(request, output)) ?? output;
    const refinedTitle = this.refinedToolTitles.get(request.id);
    this.refinedToolTitles.delete(request.id);
    const budget = this.nextToolResultBudget;
    this.nextToolResultBudget = CESIUM_TOOL_RESULT_MODEL_MAX_CHARS;
    const shape =
      result.length > budget
        ? { modelBudget: budget, ...(await this.spillToolOutput(request.id, result)) }
        : {};
    this.toolResultShapes.set(request.id, shape);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId: request.id,
        title: refinedTitle ?? title,
        toolKind: toolKind(request.name, toolDefinition),
        status: "completed",
        detail: result,
        raw: { request, result, ...shape },
      },
    ]);
    return result;
  }

  /** Read-only home of this conversation's spilled tool outputs. */
  private toolOutputDir(): string {
    return path.join(DATA_DIR, "tool-output", this.callbacks.conversation.id);
  }

  /** Saves an output the model only sees part of, so `read_file` can page through the rest. */
  private async spillToolOutput(toolCallId: string, output: string): Promise<{ spillPath?: string }> {
    const spillPath = path.join(this.toolOutputDir(), `${toolCallId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
    try {
      await fs.mkdir(path.dirname(spillPath), { recursive: true });
      await fs.writeFile(spillPath, output, "utf8");
      return { spillPath };
    } catch {
      return {};
    }
  }

  /** With `rejection`, the call is recorded and fails with that result instead of running. */
  private async executeTool(request: CesiumToolRequest, rejection?: string): Promise<string> {
    request = (await this.pluginRuntime?.beforeTool(request)) ?? request;
    const effectiveRequest =
      request.name === "call_mcp_tool"
        ? {
            ...request,
            arguments: normalizeCesiumToolRequestArguments(request.name, request.arguments),
          }
        : request;
    const orchestratorProjectId = this.projectOrchestratorProjectId();
    const toolDefinition =
      (orchestratorProjectId
        ? PROJECT_ORCHESTRATOR_TOOLS.find((tool) => tool.name === effectiveRequest.name)
        : undefined) ??
      this.harness.tools.find((tool) => tool.name === effectiveRequest.name);
    const title = toolTitle(
      effectiveRequest.name,
      effectiveRequest.arguments,
      toolDefinition
    );
    const mcpServerForTool =
      effectiveRequest.name === "call_mcp_tool"
        ? await getMcpServer(
            this.callbacks.workspace.id,
            normalizeCallMcpToolArgs(effectiveRequest.arguments).serverId ?? ""
          )
        : null;
    const callEvent: AgentEventInput = {
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "tool_call",
      toolCallId: effectiveRequest.id,
      title,
      toolKind: toolKind(effectiveRequest.name, toolDefinition),
      status: "in_progress",
      detail: safeJson(effectiveRequest.arguments),
      pluginId: mcpServerForTool?.pluginId,
      pluginName: mcpServerForTool?.displayName,
      pluginIconUrl: mcpServerForTool?.iconUrl,
      raw: this.currentResponseId
        ? { ...effectiveRequest, responseId: this.currentResponseId }
        : effectiveRequest,
    };
    await this.callbacks.appendEvents([callEvent]);
    try {
      if (rejection) {
        throw new Error(rejection);
      }
      if (orchestratorProjectId) {
        if (PROJECT_ORCHESTRATOR_TOOL_NAMES.has(effectiveRequest.name)) {
          const { executeProjectOrchestratorTool } = await import(
            "../projects/orchestrator-tools.js"
          );
          const output = await executeProjectOrchestratorTool(
            orchestratorProjectId,
            effectiveRequest.name,
            effectiveRequest.arguments
          );
          return await this.completeToolCall(
            effectiveRequest,
            title,
            toolDefinition,
            this.afterCoordinatorTool(effectiveRequest.name, output)
          );
        }
        if (
          !(PROJECT_ORCHESTRATOR_BORROWED_TOOLS as readonly string[]).includes(
            effectiveRequest.name
          )
        ) {
          throw new Error(
            `${effectiveRequest.name} is not available to a Project orchestrator. Delegate the work to a Project agent with project_create_agent or project_queue_agent.`
          );
        }
      }
      if (this.isReadOnlyHelper() && !READ_ONLY_HELPER_TOOLS.has(effectiveRequest.name)) {
        throw new Error(
          `${effectiveRequest.name} is not available to a read-only explorer. Read and search, then answer the question.`
        );
      }
      let result: string;
      const permissionCategory = resolveCesiumToolPermissionCategory(
        this.harness.tools,
        effectiveRequest.name
      );
      if (permissionCategory) {
        const permissionArgs =
          permissionCategory === "mcpCall"
            ? (() => {
                const normalized = normalizeCallMcpToolArgs(effectiveRequest.arguments);
                return {
                  serverId: normalized.serverId,
                  toolName: normalized.toolName,
                  arguments: normalized.arguments,
                };
              })()
            : effectiveRequest.arguments;
        await this.requirePermission({
          toolCallId: effectiveRequest.id,
          title,
          detail: this.buildPermissionDetail(permissionCategory, permissionArgs),
          permission: permissionCategory,
          toolKey: cesiumPermissionToolKey(permissionCategory, permissionArgs),
          toolLabel: title,
        });
      }
      const featureExecutor = this.harness.modules.find(
        (featureModule) =>
          featureModule.executeTool &&
          featureModule.toolNames.includes(effectiveRequest.name)
      );
      if (featureExecutor?.executeTool) {
        result = await featureExecutor.executeTool(
          effectiveRequest.name,
          effectiveRequest.arguments
        );
      } else {
        const toolName = normalizeCesiumToolName(request.name);
        switch (toolName) {
        case "read_file":
          result = await this.toolReadFile(request.arguments);
          break;
        case "grep":
          result = await this.toolGrep(request.arguments);
          break;
        case "glob":
          result = await this.toolGlob(request.arguments);
          break;
        case "edit_file":
          result = await this.toolEditFile(request.arguments, request.id, title);
          break;
        case "write_file":
          result = await this.toolWriteFile(request.arguments, request.id);
          break;
        case "terminal":
          result = await this.toolTerminal(request.arguments);
          break;
        case "wait":
          result = await this.toolWait(request.arguments);
          break;
        case "todo":
          result = await this.toolTodo(request.arguments);
          break;
        case "create_plan":
          result = await this.toolCreatePlan(request.arguments);
          break;
        case "update_plan":
          result = await this.toolUpdatePlan(request.arguments);
          break;
        case "read_plan":
          result = await this.toolReadPlan(request.arguments);
          break;
        case "finalize_plan":
          result = await this.toolFinalizePlan(request.arguments);
          break;
        case "goal_set":
          result = await this.toolGoalSet(request.arguments);
          break;
        case "goal_pause":
          result = await this.toolGoalPause(request.arguments);
          break;
        case "goal_block":
          result = await this.toolGoalBlock(request.arguments);
          break;
        case "goal_summarize":
          result = await this.toolGoalSummarize(request.arguments);
          break;
        case "goal_complete":
          result = await this.toolGoalComplete();
          break;
        case "goal_get":
          result = await this.toolGoalGet();
          break;
        case "goal_update_plan":
          result = await this.toolGoalUpdatePlan(request.arguments);
          break;
        case "goal_update_progress":
          result = await this.toolGoalUpdateProgress(request.arguments);
          break;
        case "goal_summarize_state":
          result = await this.toolGoalSummarize(request.arguments);
          break;
        case "goal_resume":
          result = await this.toolGoalResume();
          break;
        case "workflow_run":
          result = await this.toolWorkflowRun(request.arguments);
          break;
        case "workflow_status":
          result = await this.toolWorkflowStatus(request.arguments);
          break;
        case "workflow_await":
          result = await this.toolWorkflowAwait(request.arguments);
          break;
        case "ask_question":
          result = await this.toolAskQuestion(request.arguments);
          break;
        case "subagent":
          if (this.harness.subagentsVersion !== 1) {
            throw new Error(
              "Legacy `subagent` tool is only available when harness subagents version is 1. Switch Subagents to V1 in Settings → Agents → Cesium Agent, or use spawn_agent (V2)."
            );
          }
          result = await this.toolSubagent(request.arguments, request.id);
          break;
        case "read_subagent_transcript":
          result =
            this.harness.subagentsVersion === 2
              ? await this.ensureSubagentsV2().readTranscript(request.arguments)
              : await this.toolReadSubagentTranscript(request.arguments);
          break;
        case "spawn_agent":
        case "send_message":
        case "followup_task":
        case "wait_agent":
        case "interrupt_agent":
        case "list_agents":
          result = await this.executeSubagentsV2Tool(request.name, request.arguments);
          break;
        case "search_history":
          result = await this.toolSearchHistory(request.arguments);
          break;
        case "read_history_page":
          result = await this.toolReadHistoryPage(request.arguments);
          break;
        case "list_conversations":
          result = await this.toolListConversations(request.arguments);
          break;
        case "read_conversation":
          result = await this.toolReadConversation(request.arguments);
          break;
        case "search_conversations":
          result = await this.toolSearchConversations(request.arguments);
          break;
        case "conversation_title":
          result = await this.toolConversationTitle(request.arguments);
          break;
        case "memory":
          result = await this.toolMemory(request.arguments);
          break;
        case "skill":
          result = await this.toolSkill(request.arguments);
          break;
        case "schedule":
          result = await this.toolSchedule(request.arguments);
          break;
        case "switch_branch":
          result = await this.toolSwitchBranch(request.arguments);
          break;
        case "create_worktree":
          result = await this.toolCreateWorktree(request.arguments);
          break;
        case "call_mcp_tool":
          result = await this.toolCallMcp(effectiveRequest.arguments);
          break;
        case "refresh_mcp_servers":
          result = await this.toolRefreshMcpServers();
          break;
        case "orchestration_board_snapshot":
          result = await this.toolOrchestrationBoardSnapshot(request.arguments);
          break;
        case "orchestration_create_issue":
          result = await this.toolOrchestrationCreateIssue(request.arguments);
          break;
        case "orchestration_update_issue":
          result = await this.toolOrchestrationUpdateIssue(request.arguments);
          break;
        case "orchestration_comment_issue":
          result = await this.toolOrchestrationCommentIssue(request.arguments);
          break;
        case "orchestration_delete_issue":
          result = await this.toolOrchestrationDeleteIssue(request.arguments);
          break;
        case "orchestration_assign_agent":
          result = await this.toolOrchestrationAssignAgent(request.arguments);
          break;
        case "orchestration_update_agent_permissions":
          result = await this.toolOrchestrationUpdateAgentPermissions(request.arguments);
          break;
        case "orchestration_control_agent":
          result = await this.toolOrchestrationControlAgent(request.arguments);
          break;
        case "orchestration_read_agent_transcript":
          result = await this.toolOrchestrationReadAgentTranscript(request.arguments);
          break;
        case "orchestration_wait":
          result = await this.toolOrchestrationWait(request.arguments);
          break;
        default:
          throw new Error(`Unknown Cesium tool: ${request.name}`);
        }
      }
      return await this.completeToolCall(effectiveRequest, title, toolDefinition, result);
    } catch (error) {
      await this.pluginRuntime?.toolError(effectiveRequest, error);
      this.refinedToolTitles.delete(effectiveRequest.id);
      if (error instanceof PermissionRefusedToolCallError) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: effectiveRequest.id,
            title,
            toolKind: toolKind(effectiveRequest.name, toolDefinition),
            status: "completed",
            detail: error.message,
            raw: { request: effectiveRequest, result: error.message, permissionRefused: true },
          },
        ]);
        return error.message;
      }
      const failed = statusFromError(error);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: effectiveRequest.id,
          title,
          toolKind: toolKind(effectiveRequest.name, toolDefinition),
          status: failed.status,
          detail: failed.detail,
          raw: { request: effectiveRequest, error: failed.detail },
        },
      ]);
      return failed.detail;
    }
  }

  private async toolReadFile(args: Record<string, unknown>): Promise<string> {
    const inputPath = asString(args.path);
    if (!inputPath) throw new Error("read_file.path is required.");
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, inputPath, [
      ...this.projectContextRoots(),
      this.toolOutputDir(),
    ]);
    const imageMime = imageMimeTypeForPath(resolved);
    if (imageMime) {
      const buffer = await fs.readFile(resolved);
      if (buffer.length > MAX_READ_IMAGE_BYTES) {
        return `${inputPath} is a ${imageMime} image of ${buffer.length} bytes, which exceeds the ${MAX_READ_IMAGE_BYTES}-byte attachment limit.`;
      }
      if (!this.turnSupportsImages) {
        return `${inputPath} is a ${imageMime} image (${buffer.length} bytes). The current model does not advertise image support, so the pixels cannot be attached; switch to a vision model such as kimi-k3 to view it.`;
      }
      this.pendingToolImages.push({
        mimeType: imageMime,
        data: buffer.toString("base64"),
        source: `read_file(${inputPath})`,
      });
      return `${inputPath} is a ${imageMime} image (${buffer.length} bytes). The image is attached to this turn for your review.`;
    }
    const raw = await fs.readFile(resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    const offset = Math.max(1, Math.floor(asNumber(args.offset) ?? 1));
    const requestedLimit = Math.floor(asNumber(args.limit) ?? Math.min(lines.length, MAX_READ_LINES));
    const limit = Math.min(Math.max(1, requestedLimit), MAX_READ_LINES);
    if (lines.length > LARGE_FILE_LINE_LIMIT && !args.offset && !args.limit) {
      return [
        `${inputPath} has ${lines.length} lines, which exceeds ${LARGE_FILE_LINE_LIMIT}.`,
        `Start:\n${lines.slice(0, 80).map((line, index) => `${index + 1}|${line}`).join("\n")}`,
        `End:\n${lines.slice(-80).map((line, index) => `${lines.length - 79 + index}|${line}`).join("\n")}`,
        `Use offset and limit to read up to ${MAX_READ_LINES} lines.`,
      ].join("\n\n");
    }
    return lines
      .slice(offset - 1, offset - 1 + limit)
      .map((line, index) => `${offset + index}|${line}`)
      .join("\n");
  }

  private async toolGrep(args: Record<string, unknown>): Promise<string> {
    const pattern = asString(args.pattern);
    if (!pattern) throw new Error("grep.pattern is required.");
    const root = resolveWorkspacePath(this.callbacks.workspace.root, asString(args.path) ?? ".", this.projectContextRoots());
    const regex = new RegExp(pattern, "i");
    const context = Math.max(0, Math.min(20, Math.floor(asNumber(args.context) ?? 0)));
    const maxResults = Math.max(1, Math.min(MAX_GREP_RESULTS, Math.floor(asNumber(args.maxResults) ?? DEFAULT_GREP_RESULTS)));
    const results: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (results.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".docker" || entry.name === ".next") {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const text = await fs.readFile(full, "utf8").catch(() => null);
        if (text == null) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          if (!regex.test(lines[index] ?? "")) continue;
          const start = Math.max(0, index - context);
          const end = Math.min(lines.length, index + context + 1);
          const rel = path.relative(this.callbacks.workspace.root, full);
          results.push(`${rel}:${index + 1}\n${lines.slice(start, end).map((line, i) => `${start + i + 1}|${line}`).join("\n")}`);
        }
      }
    };
    await visit(root);
    return results.length ? results.join("\n\n") : "No matches.";
  }

  private async toolGlob(args: Record<string, unknown>): Promise<string> {
    const pattern = asString(args.pattern);
    if (!pattern) throw new Error("glob.pattern is required.");
    const searchPath = asString(args.path) ?? ".";
    const searchRoot = resolveWorkspacePath(this.callbacks.workspace.root, searchPath, this.projectContextRoots());
    const stat = await fs.stat(searchRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`glob.path must be an existing directory inside the workspace: ${searchPath}`);
    }
    const result = await globWorkspaceEntries({
      workspaceRoot: this.callbacks.workspace.root,
      searchRoot,
      pattern,
      maxResults: asNumber(args.maxResults),
    });
    return formatGlobResult(result, { pattern, searchPath });
  }

  private async toolEditFile(
    args: Record<string, unknown>,
    toolCallId: string,
    title: string
  ): Promise<string> {
    const parsed = parseCesiumEditFileArgs(args);
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, parsed.path, this.projectContextRoots());
    const before = await readWorkspaceFileIfExists(resolved);
    const outcome = applyCesiumFileEdit({
      path: parsed.path,
      before,
      oldString: parsed.oldString,
      newString: parsed.newString,
      replaceAll: parsed.replaceAll,
    });
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, outcome.after, "utf8");
    const editPreview = extractToolEditPreview(
      { path: parsed.path, oldString: parsed.oldString, newString: parsed.newString },
      { beforeFullFileContent: before ?? "", afterFullFileContent: outcome.after },
      parsed.path
    );
    const refinedTitle = outcome.created ? `Create ${parsed.path}` : title;
    if (outcome.created) {
      this.refinedToolTitles.set(toolCallId, refinedTitle);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        title: refinedTitle,
        toolKind: "edit",
        status: "in_progress",
        detail: outcome.created ? "Created file." : "Applied edit preview.",
        locations: [{ path: parsed.path }],
        editPreview,
      },
    ]);
    return outcome.resultMessage;
  }

  private async toolWriteFile(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const parsed = parseCesiumWriteFileArgs(args);
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, parsed.path, this.projectContextRoots());
    const before = await readWorkspaceFileIfExists(resolved);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, parsed.content, "utf8");
    const { created, resultMessage } = describeWriteFileOutcome({
      path: parsed.path,
      before,
      content: parsed.content,
    });
    const editPreview = extractToolEditPreview(
      { path: parsed.path },
      { beforeFullFileContent: before ?? "", afterFullFileContent: parsed.content },
      parsed.path
    );
    const refinedTitle = `${created ? "Create" : "Update"} ${parsed.path}`;
    this.refinedToolTitles.set(toolCallId, refinedTitle);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        title: refinedTitle,
        toolKind: "edit",
        status: "in_progress",
        detail: created ? "Created file." : "Overwrote file.",
        locations: [{ path: parsed.path }],
        editPreview,
      },
    ]);
    return resultMessage;
  }

  private async toolTerminal(args: Record<string, unknown>): Promise<string> {
    const command = asString(args.command);
    if (!command) throw new Error("terminal.command is required.");
    const waitUntil = asString(args.waitUntil) ?? "complete";
    const timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(asNumber(args.timeoutMs) ?? 30_000)));
    const child = spawn(command, {
      cwd: this.callbacks.workspace.root,
      shell: true,
      windowsHide: true,
    });
    const id = randomUUID();
    const run: TerminalRun = {
      id,
      process: child,
      output: new BoundedTerminalOutput(TERMINAL_OUTPUT_CAP),
      startedAt: Date.now(),
    };
    this.terminalRuns.set(id, run);
    const append = (chunk: Buffer) => {
      run.output.append(chunk.toString("utf8"));
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    // Nothing reads runs by id after completion; evict on exit or the map
    // retains every ChildProcess + up to 80KB of output for the session's life.
    child.on("exit", (code) => {
      run.exitCode = code;
      run.completedAt = Date.now();
      this.terminalRuns.delete(id);
    });
    child.on("error", (error: Error) => {
      run.output.append(`\n[spawn failed] ${error.message}`);
      run.exitCode = -1;
      run.completedAt = Date.now();
      this.terminalRuns.delete(id);
    });
    if (waitUntil === "background") {
      return `Started background command ${id}: ${command}`;
    }
    const pattern = asString(args.pattern);
    return await new Promise<string>((resolve) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (waitUntil === "pattern" && pattern && run.output.toString().includes(pattern)) {
          clearInterval(interval);
          resolve(`Pattern matched for ${command}.\n${run.output.toString()}`);
          return;
        }
        if (run.exitCode !== undefined) {
          clearInterval(interval);
          resolve(`Command exited ${run.exitCode ?? 0}.\n${run.output.toString()}`);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(interval);
          resolve(`Command still running after ${timeoutMs}ms as ${id}.\n${run.output.toString()}`);
        }
      }, 250);
    });
  }

  private async appendPlanFileEvents(plan: Awaited<ReturnType<typeof readCesiumPlanFile>>, raw: unknown): Promise<void> {
    const events: AgentEventInput[] = [
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "plan_file",
        path: plan.path,
        title: plan.title,
        previewMode: "preview",
        raw,
      },
    ];
    if (plan.entries.length > 0) {
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "plan",
        planId: `plan-file:${plan.path}`,
        entries: plan.entries,
        raw,
      });
    }
    await this.callbacks.appendEvents(events);
  }

  private async toolCreatePlan(args: Record<string, unknown>): Promise<string> {
    const title = asString(args.title);
    const content = asString(args.content);
    if (!title) throw new Error("create_plan.title is required.");
    if (!content) throw new Error("create_plan.content is required.");
    const plan = await writeCesiumPlanFile({
      workspaceRoot: this.callbacks.workspace.root,
      title,
      content,
      path: asString(args.path),
    });
    await this.appendPlanFileEvents(plan, args);
    return `Created plan ${plan.path} with ${plan.entries.length} checklist item${plan.entries.length === 1 ? "" : "s"}.`;
  }

  private async toolUpdatePlan(args: Record<string, unknown>): Promise<string> {
    const planPath = asString(args.path);
    const content = asString(args.content);
    if (!planPath) throw new Error("update_plan.path is required.");
    if (!content) throw new Error("update_plan.content is required.");
    const plan = await writeCesiumPlanFile({
      workspaceRoot: this.callbacks.workspace.root,
      title: asString(args.title) ?? "Plan",
      content,
      path: planPath,
    });
    await this.appendPlanFileEvents(plan, args);
    return `Updated plan ${plan.path} with ${plan.entries.length} checklist item${plan.entries.length === 1 ? "" : "s"}.`;
  }

  private async toolReadPlan(args: Record<string, unknown>): Promise<string> {
    const planPath = asString(args.path);
    if (!planPath) throw new Error("read_plan.path is required.");
    const plan = await readCesiumPlanFile({
      workspaceRoot: this.callbacks.workspace.root,
      path: planPath,
    });
    return [
      `Plan: ${plan.title}`,
      `Path: ${plan.path}`,
      `Checklist items: ${plan.entries.length}`,
      "",
      plan.content,
    ].join("\n");
  }

  private async toolFinalizePlan(args: Record<string, unknown>): Promise<string> {
    const planPath = asString(args.path);
    if (!planPath) throw new Error("finalize_plan.path is required.");
    const plan = await readCesiumPlanFile({
      workspaceRoot: this.callbacks.workspace.root,
      path: planPath,
    });
    await this.appendPlanFileEvents(plan, args);
    return `Finalized plan ${plan.path} for review.`;
  }

  private async toolGoalGet(): Promise<string> {
    const goal = await readGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return goal ? formatGoalForModel(goal) : "No Goal exists for this conversation.";
  }

  private async toolGoalSet(args: Record<string, unknown>): Promise<string> {
    const objective = asString(args.objective);
    let goal = await readGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    if (!goal) {
      if (!objective) {
        throw new Error("goal_set.objective is required when no Goal exists.");
      }
      goal = await ensureGoalForConversation({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        objective,
      });
    } else if (objective && objective !== goal.objective) {
      goal = await updateGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch: {
          objective,
          status: goal.status === "planning" || goal.status === "paused" ? "active" : goal.status,
          phase: goal.phase === "planning" ? "executing" : goal.phase,
        },
      });
    }

    const hasPlanState =
      asString(args.planSummary) != null ||
      Array.isArray(args.milestones) ||
      Array.isArray(args.todos);
    if (hasPlanState) {
      goal = await updateGoalPlan({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        planSummary: asString(args.planSummary),
        milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
        todos: Array.isArray(args.todos) ? args.todos : undefined,
      });
    }

    if (Array.isArray(args.verificationEvidence)) {
      goal = await updateGoalProgress({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        verificationEvidence: args.verificationEvidence,
      });
    }

    const progressPercent = asNumber(args.progressPercent);
    const headline = asString(args.headline);
    if (progressPercent != null || headline) {
      const patch: Parameters<typeof updateGoal>[0]["patch"] = {};
      if (progressPercent != null) {
        const rounded = Math.round(progressPercent);
        if (
          !Number.isFinite(progressPercent) ||
          rounded !== progressPercent ||
          rounded < 0 ||
          rounded > 100
        ) {
          throw new Error("goal_set.progressPercent must be an integer from 0 to 100.");
        }
        patch.progressPercent = rounded;
      }
      if (headline) {
        patch.headline = headline;
      }
      goal = await updateGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch,
      });
    }

    if (goal.status === "planning") {
      goal = await updateGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch: {
          status: "active",
          phase: goal.phase === "planning" ? "executing" : goal.phase,
        },
      });
    }

    return `Goal set.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalUpdatePlan(args: Record<string, unknown>): Promise<string> {
    const planSummary = asString(args.planSummary);
    if (!planSummary) {
      throw new Error("goal_update_plan.planSummary is required.");
    }
    const goal = await updateGoalPlan({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      planSummary,
      milestones: Array.isArray(args.milestones) ? args.milestones : [],
      todos: Array.isArray(args.todos) ? args.todos : [],
    });
    return `Goal plan recorded.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalUpdateProgress(args: Record<string, unknown>): Promise<string> {
    const goal = await updateGoalProgress({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
      todos: Array.isArray(args.todos) ? args.todos : undefined,
      verificationEvidence: Array.isArray(args.verificationEvidence)
        ? args.verificationEvidence
        : undefined,
    });
    return `Goal progress updated.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalSummarize(args: Record<string, unknown>): Promise<string> {
    const progressPercent = asNumber(args.progressPercent);
    const summary = asString(args.summary);
    if (progressPercent == null) {
      throw new Error("goal_summarize.progressPercent is required.");
    }
    if (!summary) {
      throw new Error("goal_summarize.summary is required.");
    }
    const goal = await appendGoalSnapshot({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      progressPercent,
      summary,
      headline: asString(args.headline),
    });
    return `Goal summarized.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalComplete(): Promise<string> {
    const goal = await completeGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return `Goal complete.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalBlock(args: Record<string, unknown>): Promise<string> {
    const reason = asString(args.reason);
    if (!reason) {
      throw new Error("goal_block.reason is required.");
    }
    const goal = await blockGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      reason,
      evidence: asString(args.evidence),
    });
    return goal.status === "blocked"
      ? `Goal blocked.\n\n${formatGoalForModel(goal)}`
      : `Blocker recorded but Goal remains active until the same blocker repeats across at least three Goal turns.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalPause(args: Record<string, unknown>): Promise<string> {
    const goal = await pauseGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      reason: asString(args.reason),
    });
    return `Goal paused.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolGoalResume(): Promise<string> {
    const goal = await resumeGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return `Goal resumed.\n\n${formatGoalForModel(goal)}`;
  }

  private async toolTodo(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action) ?? "list";
    const items = Array.isArray(args.items) ? args.items : [];
    if (action === "list") {
      const snapshot = await this.callbacks.readSnapshot();
      const latest = latestTodoEntries(snapshot?.events ?? []);
      return latest
        ? latest.map((entry) => `${entry.status}: ${entry.content}`).join("\n")
        : "No todos yet.";
    }
    const parsedItems = parseTodoItems(items);
    let entries: AgentPlanEntry[];
    if (action === "patch") {
      const snapshot = await this.callbacks.readSnapshot();
      entries = applyTodoPatch(latestTodoEntries(snapshot?.events ?? []) ?? [], parsedItems);
    } else {
      entries = todoEntriesFromReplace(parsedItems);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "plan",
        planId: CESIUM_TODO_PLAN_ID,
        entries,
        raw: args,
      },
    ]);
    return action === "patch"
      ? `Patched ${parsedItems.length} todo item${parsedItems.length === 1 ? "" : "s"}; the list now has ${entries.length}.`
      : `Stored ${entries.length} todo item${entries.length === 1 ? "" : "s"}.`;
  }

  private async toolAskQuestion(args: Record<string, unknown>): Promise<string> {
    const parsed = parseAskQuestionArgs(args);
    const prompt = parsed.prompt;
    const questions: CesiumQuestionStep[] = parsed.questions;
    const primaryOptions = questions[0]?.options ?? parsed.options;
    const primaryAllowMultiple = questions.length === 1 ? Boolean(questions[0]?.allowMultiple) : false;
    const questionId = randomUUID();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt,
        options: primaryOptions,
        questions,
        allowMultiple: primaryAllowMultiple,
        status: "pending",
        raw: args,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: prompt,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: {
        questionId,
        requestedAt: Date.now(),
      },
    }));
    const answer = await new Promise<string>((resolve, reject) => {
      this.pendingQuestions.set(questionId, {
        resolve,
        reject,
        prompt,
        options: primaryOptions,
        questions,
        allowMultiple: primaryAllowMultiple,
        raw: args,
      });
    });
    return `User answer:\n${answer}`;
  }

  private buildPermissionDetail(
    permission: AgentPermissionCategory,
    args: Record<string, unknown>
  ): string {
    if (permission === "mcpCall") {
      const serverId = asString(args.serverId) ?? "";
      const toolName = asString(args.toolName) ?? "";
      const toolArgs = asRecord(args.arguments) ?? {};
      return `${serverId} - ${toolName}\n${JSON.stringify(toolArgs)}`;
    }
    return safeJson(args);
  }

  private async toolCallMcp(args: Record<string, unknown>): Promise<string> {
    const normalized = normalizeCallMcpToolArgs(args);
    const serverId = normalized.serverId;
    const toolName = normalized.toolName;
    const toolArgs = normalized.arguments;
    if (!serverId || !toolName) {
      throw new Error("call_mcp_tool requires serverId and toolName.");
    }
    const rich = await callMcpToolRich({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      serverId,
      toolName,
      arguments: toolArgs,
    });
    if (rich.images?.length && this.turnSupportsImages) {
      for (const image of rich.images.slice(0, 4)) {
        this.pendingToolImages.push({
          mimeType: image.mimeType,
          data: image.data,
          source: `${serverId}/${toolName}`,
        });
      }
    }
    return rich.text;
  }

  private async toolRefreshMcpServers(): Promise<string> {
    await refreshWorkspaceMcpMirror({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
    });
    const summaries = await getMcpSummariesForPrompt(this.callbacks.workspace.id);
    this.activeSystemPrompt = this.baseSystemPrompt();
    return `Refreshed ${summaries.length} MCP server mirror(s) under mcp-servers/.`;
  }

  private async resolveOrchestrationBoardFromArgs(args: Record<string, unknown>) {
    const boardId = asString(args.boardId);
    if (boardId) {
      const snapshot = await readOrchestrationBoardSnapshot(boardId);
      if (!snapshot || snapshot.board.workspaceId !== this.callbacks.workspace.id) {
        throw new Error(`Unknown orchestration board: ${boardId}`);
      }
      return snapshot;
    }
    const snapshot = await this.resolveCurrentOrchestrationBoard();
    if (!snapshot) {
      throw new Error("No orchestration board is linked to this head conversation.");
    }
    return snapshot;
  }

  private async toolOrchestrationBoardSnapshot(
    args: Record<string, unknown>
  ): Promise<string> {
    const snapshot = await this.resolveOrchestrationBoardFromArgs(args);
    return safeJson({
      board: snapshot.board,
      issues: snapshot.issues,
      assignments: snapshot.assignments,
      recentEvents: snapshot.events.slice(-30),
    });
  }

  private async toolOrchestrationCreateIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const title = asString(args.title);
    if (!title) {
      throw new Error("orchestration_create_issue.title is required.");
    }
    const columnId = asOrchestrationColumnId(args.columnId);
    const blockerExplanation = asString(args.blockerExplanation);
    if (columnId === "blocked" && !blockerExplanation) {
      throw new Error(
        "orchestration_create_issue.blockerExplanation is required for blocked issues."
      );
    }
    const snapshot = await createOrchestrationIssue({
      boardId: current.board.id,
      title,
      description: asString(args.description),
      columnId,
      priority: asOrchestrationPriority(args.priority),
      acceptanceCriteria: asStringArray(args.acceptanceCriteria),
      blockedReason: blockerExplanation,
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
    });
    const issue = snapshot.issues[snapshot.issues.length - 1];
    return safeJson({ issue, boardId: snapshot.board.id });
  }

  private async toolOrchestrationUpdateIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    if (!issueId) {
      throw new Error("orchestration_update_issue.issueId is required.");
    }
    const columnId = asOrchestrationColumnId(args.columnId);
    const priority = asOrchestrationPriority(args.priority);
    const blockerExplanation =
      asString(args.blockerExplanation) ?? asString(args.blockedReason);
    const existingIssue = current.issues.find((issue) => issue.id === issueId);
    if (!existingIssue) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    if (columnId === "blocked" && !blockerExplanation && !existingIssue.blockedReason) {
      throw new Error(
        "orchestration_update_issue.blockerExplanation is required when moving an issue to blocked."
      );
    }
    const snapshot = await upsertOrchestrationIssue(
      current.board.id,
      {
        id: issueId,
        ...(asString(args.title) ? { title: asString(args.title)! } : {}),
        ...(typeof args.description === "string"
          ? { description: args.description }
          : {}),
        ...(columnId ? { columnId } : {}),
        ...(priority ? { priority } : {}),
        ...(Array.isArray(args.acceptanceCriteria)
          ? { acceptanceCriteria: asStringArray(args.acceptanceCriteria) }
          : {}),
        ...(blockerExplanation
          ? { blockedReason: blockerExplanation }
          : {}),
      },
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      issue: snapshot.issues.find((issue) => issue.id === issueId),
      boardId: snapshot.board.id,
    });
  }

  private async toolOrchestrationCommentIssue(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    const message = asString(args.message);
    if (!issueId || !message) {
      throw new Error("orchestration_comment_issue requires issueId and message.");
    }
    const snapshot = await addOrchestrationComment({
      boardId: current.board.id,
      issueId,
      message,
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
    });
    return safeJson({ boardId: snapshot.board.id, issueId, message });
  }

  private async toolOrchestrationDeleteIssue(args: Record<string, unknown>): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    if (!issueId) {
      throw new Error("orchestration_delete_issue.issueId is required.");
    }
    const issue = current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    const assignments = current.assignments.filter(
      (assignment) => assignment.issueId === issueId
    );
    const reason = asString(args.reason);
    const { agentRuntimeManager } = await import("./runtime-manager.js");
    await Promise.all(
      assignments.map((assignment) =>
        agentRuntimeManager
          .cancelConversation(this.callbacks.workspace, assignment.conversationId)
          .catch(() => undefined)
      )
    );
    const snapshot = await deleteOrchestrationIssue(
      current.board.id,
      issueId,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      boardId: snapshot.board.id,
      deletedIssue: issue,
      cancelledAssignments: assignments.map((assignment) => assignment.id),
      reason: reason ?? null,
    });
  }

  private async toolOrchestrationAssignAgent(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveOrchestrationBoardFromArgs(args);
    const issueId = asString(args.issueId);
    const instructions = asString(args.instructions);
    if (!issueId || !instructions) {
      throw new Error("orchestration_assign_agent requires issueId and instructions.");
    }
    const issue = current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    const backendId =
      (asString(args.backendId) as AgentBackendId | undefined) ??
      current.board.settings.defaultChildBackendId ??
      "cesium-agent";
    const modelId =
      asString(args.modelId) ??
      current.board.settings.defaultModelByBackend[backendId] ??
      (backendId === this.callbacks.conversation.config.backendId
        ? this.callbacks.conversation.config.modelId
        : undefined);
    const modelName =
      modelId === this.callbacks.conversation.config.modelId
        ? this.callbacks.conversation.config.modelName
        : undefined;
    const { agentRuntimeManager } = await import("./runtime-manager.js");
    const promptText = [
      `You are assigned to orchestration issue "${issue.title}".`,
      "",
      issue.description ? `Description:\n${issue.description}` : "",
      issue.acceptanceCriteria.length
        ? `Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
        : "",
      "",
      "Manager instructions:",
      instructions,
      "",
      "Work end-to-end, verify your result, and report blockers clearly.",
    ]
      .filter(Boolean)
      .join("\n");
    const childSnapshot = await agentRuntimeManager.createConversationWithPrompt(
      this.callbacks.workspace,
      {
        title: asString(args.title) ?? `Issue: ${issue.title}`,
        archived: true,
        backendId,
        mode: "agent",
        ...(modelId ? { modelId } : {}),
        ...(modelName ? { modelName } : {}),
      },
      { text: promptText }
    );
    const child = childSnapshot.conversation;
    const permissionPolicy = asOrchestrationPermissionPolicy(args.permissions);
    const assignment: OrchestrationAssignmentRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      boardId: current.board.id,
      issueId,
      conversationId: child.id,
      role: asString(args.role) ?? "implementation",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { ...child.config, permissionPolicy },
      lastKnownConversationStatus: child.status,
    };
    await upsertOrchestrationAssignment(
      current.board.id,
      assignment,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({ assignment, childConversation: child });
  }

  private async toolOrchestrationUpdateAgentPermissions(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveCurrentOrchestrationBoard();
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (!assignmentId && !conversationId) {
      throw new Error(
        "orchestration_update_agent_permissions requires assignmentId or conversationId."
      );
    }
    const assignment = current.assignments.find((candidate) =>
      assignmentId
        ? candidate.id === assignmentId
        : candidate.conversationId === conversationId
    );
    if (!assignment) {
      throw new Error(
        `Unknown orchestration assignment: ${assignmentId ?? conversationId}`
      );
    }
    const requestedPermissions = asRecord(args.permissions);
    const existingPolicy = assignment.config.permissionPolicy;
    const permissionPolicy: OrchestrationAssignmentPermissionPolicy = {
      editFile:
        asOrchestrationPermissionDecision(requestedPermissions?.editFile) ??
        existingPolicy?.editFile ??
        "allow",
      terminal:
        asOrchestrationPermissionDecision(requestedPermissions?.terminal) ??
        existingPolicy?.terminal ??
        "allow",
      mcpCall:
        asOrchestrationPermissionDecision(requestedPermissions?.mcpCall) ??
        existingPolicy?.mcpCall ??
        "allow",
    };
    const nextAssignment: OrchestrationAssignmentRecord = {
      ...assignment,
      config: {
        ...assignment.config,
        permissionPolicy,
      },
    };
    const snapshot = await upsertOrchestrationAssignment(
      current.board.id,
      nextAssignment,
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      assignment: snapshot.assignments.find(
        (candidate) => candidate.id === assignment.id
      ),
    });
  }

  private async toolOrchestrationControlAgent(args: Record<string, unknown>): Promise<string> {
    const current = await this.resolveCurrentOrchestrationBoard();
    const action = asOrchestrationControlAction(args.action);
    if (!action) {
      throw new Error("orchestration_control_agent requires action.");
    }
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (!assignmentId && !conversationId) {
      throw new Error("orchestration_control_agent requires assignmentId or conversationId.");
    }
    const assignment = current.assignments.find((candidate) =>
      assignmentId
        ? candidate.id === assignmentId
        : candidate.conversationId === conversationId
    );
    if (!assignment) {
      throw new Error(`Unknown orchestration assignment: ${assignmentId ?? conversationId}`);
    }
    const issue = current.issues.find((candidate) => candidate.id === assignment.issueId);
    const reason = asString(args.reason);
    const instructions = asString(args.instructions);
    const resumeAfterSteer = args.resumeAfterSteer === true;
    const { agentRuntimeManager } = await import("./runtime-manager.js");

    let nextAssignmentStatus: OrchestrationAssignmentStatus = assignment.status;
    let childConversationStatus: AgentConversationStatus | null =
      assignment.lastKnownConversationStatus;
    let message: string;

    switch (action) {
      case "pause": {
        const conversation = await agentRuntimeManager.pauseConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "waiting";
        childConversationStatus = conversation.status;
        message = `Paused child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "resume": {
        const conversation = await agentRuntimeManager.resumeConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "running";
        childConversationStatus = conversation.status;
        message = `Resumed child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "stop": {
        const conversation = await agentRuntimeManager.cancelConversation(
          this.callbacks.workspace,
          assignment.conversationId
        );
        nextAssignmentStatus = "cancelled";
        childConversationStatus = conversation.status;
        message = `Stopped child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
      case "steer": {
        if (!instructions) {
          throw new Error("orchestration_control_agent steer requires instructions.");
        }
        const steerText = [
          issue ? `Steering update for orchestration issue "${issue.title}".` : "Steering update.",
          reason ? `Reason: ${reason}` : "",
          "",
          instructions,
        ]
          .filter(Boolean)
          .join("\n");
        const snapshot = await agentRuntimeManager.promptConversation(
          this.callbacks.workspace,
          assignment.conversationId,
          steerText,
          undefined,
          { delivery: "steer" }
        );
        if (resumeAfterSteer) {
          try {
            const conversation = await agentRuntimeManager.resumeConversation(
              this.callbacks.workspace,
              assignment.conversationId
            );
            childConversationStatus = conversation.status;
            nextAssignmentStatus = "running";
          } catch {
            childConversationStatus = snapshot.conversation.status;
            nextAssignmentStatus =
              snapshot.conversation.status === "paused" ? "waiting" : "running";
          }
        } else {
          childConversationStatus = snapshot.conversation.status;
          nextAssignmentStatus =
            snapshot.conversation.status === "paused" ? "waiting" : "running";
        }
        message = `Steered child agent ${assignment.conversationId}${
          reason ? `: ${reason}` : "."
        }`;
        break;
      }
    }

    const commented = await addOrchestrationComment({
      boardId: current.board.id,
      issueId: assignment.issueId,
      actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
      message,
    });
    const updated = await upsertOrchestrationAssignment(
      current.board.id,
      {
        ...assignment,
        status: nextAssignmentStatus,
        lastKnownConversationStatus: childConversationStatus,
      },
      { type: "head_agent", conversationId: this.callbacks.conversation.id }
    );
    return safeJson({
      action,
      message,
      assignment:
        updated.assignments.find((candidate) => candidate.id === assignment.id) ??
        commented.assignments.find((candidate) => candidate.id === assignment.id) ??
        null,
    });
  }

  private async toolOrchestrationReadAgentTranscript(
    args: Record<string, unknown>
  ): Promise<string> {
    const current = await this.resolveCurrentOrchestrationBoard();
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (!assignmentId && !conversationId) {
      throw new Error(
        "orchestration_read_agent_transcript requires assignmentId or conversationId."
      );
    }
    const assignment = current.assignments.find((candidate) =>
      assignmentId
        ? candidate.id === assignmentId
        : candidate.conversationId === conversationId
    );
    if (!assignment) {
      throw new Error(`Unknown orchestration assignment: ${assignmentId ?? conversationId}`);
    }
    const issue = current.issues.find((candidate) => candidate.id === assignment.issueId);
    const { agentRuntimeManager } = await import("./runtime-manager.js");
    const limitEvents = Math.max(1, Math.min(200, Math.floor(asNumber(args.limitEvents) ?? 80)));
    const limitTurns = Math.max(1, Math.min(100, Math.floor(asNumber(args.limitTurns) ?? 25)));
    const beforeSeq = Math.floor(asNumber(args.beforeSeq) ?? Number.MAX_SAFE_INTEGER);
    const head = await agentRuntimeManager.getConversationSnapshotHead(
      this.callbacks.workspace,
      assignment.conversationId,
      { limitEvents, limitTurns }
    );
    if (!head) {
      return `No conversation found for child agent ${assignment.conversationId}.`;
    }
    const events = head.events.filter((event) => event.seq < beforeSeq);
    const header = [
      "Kanban child agent transcript",
      `Assignment: ${assignment.id}`,
      `Conversation: ${assignment.conversationId}`,
      issue ? `Issue: ${issue.title} (${issue.id})` : `Issue: ${assignment.issueId}`,
      `Assignment status: ${assignment.status}`,
      `Conversation status: ${head.conversation.status}`,
      head.conversation.lastError ? `Last error: ${head.conversation.lastError}` : null,
      head.window.hasOlder
        ? `Older events available before seq ${head.window.oldestSeq}. Pass beforeSeq=${head.window.oldestSeq} to load more.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    if (events.length === 0) {
      return `${header}\n\nNo transcript events in this page.`;
    }
    return `${header}\n\n${generateTranscriptFromEvents(events).trim()}`;
  }

  private async toolWait(args: Record<string, unknown>): Promise<string> {
    const parsed = parseWaitToolArgs(args, this.harness.settings.limits.waitMaxSeconds);
    let elapsedMs = 0;
    let statusElapsedMs = 0;
    while (elapsedMs < parsed.durationMs) {
      if (this.cancelled || this.disposed) {
        throw new Error("Wait interrupted.");
      }
      const chunkMs = Math.min(WAIT_POLL_MS, parsed.durationMs - elapsedMs);
      await sleepMs(chunkMs);
      elapsedMs += chunkMs;
      statusElapsedMs += chunkMs;
      if (statusElapsedMs >= WAIT_HEARTBEAT_MS || elapsedMs >= parsed.durationMs) {
        statusElapsedMs = 0;
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Waiting ${Math.round(elapsedMs / 1000)}s / ${Math.round(parsed.durationMs / 1000)}s: ${parsed.reason}`,
          },
        ]);
      }
    }
    return safeJson({
      waitedMs: elapsedMs,
      seconds: parsed.seconds,
      reason: parsed.reason,
      capped: parsed.capped,
      maxSeconds: this.harness.settings.limits.waitMaxSeconds,
    });
  }

  private async toolOrchestrationWait(args: Record<string, unknown>): Promise<string> {
    const timeoutMs = Math.max(1000, Math.floor(asNumber(args.timeoutMs) ?? ORCHESTRATION_WAIT_DEFAULT_MS));
    const pollMs = Math.max(
      1000,
      Math.min(
        ORCHESTRATION_WAIT_HEARTBEAT_MS,
        Math.floor(asNumber(args.pollMs) ?? 5000)
      )
    );
    const waitFor = asOrchestrationWaitFor(args.waitFor);
    const reason = asString(args.reason) ?? "No reason provided.";
    const issueId = asString(args.issueId);
    const assignmentId = asString(args.assignmentId);
    const conversationId = asString(args.conversationId);
    if (
      (waitFor === "issue_update" ||
        waitFor === "issue_comment" ||
        waitFor === "issue_done" ||
        waitFor === "all_issue_assignments_finished") &&
      !issueId
    ) {
      throw new Error(`orchestration_wait ${waitFor} requires issueId.`);
    }
    if (
      (waitFor === "assignment_update" ||
        waitFor === "assignment_status" ||
        waitFor === "assignment_finished") &&
      !assignmentId &&
      !conversationId
    ) {
      throw new Error(
        `orchestration_wait ${waitFor} requires assignmentId or conversationId.`
      );
    }
    const requestedStatuses = asOrchestrationAssignmentStatuses(args.statuses);
    const targetStatuses =
      requestedStatuses.length > 0
        ? requestedStatuses
        : ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES;
    const initialSnapshot = await this.resolveCurrentOrchestrationBoard();
    const initialEventIds = new Set(initialSnapshot.events.map((event) => event.id));
    const initialAssignmentStatusById = new Map(
      initialSnapshot.assignments.map((assignment) => [assignment.id, assignment.status])
    );
    const initialIssue = issueId
      ? initialSnapshot.issues.find((issue) => issue.id === issueId)
      : undefined;
    const initialAssignment = initialSnapshot.assignments.find((assignment) =>
      assignmentId
        ? assignment.id === assignmentId
        : conversationId
          ? assignment.conversationId === conversationId
          : false
    );

    const evaluate = (snapshot: OrchestrationBoardSnapshot) => {
      const newEvents = snapshot.events.filter((event) => !initialEventIds.has(event.id));
      const assignment = snapshot.assignments.find((candidate) =>
        assignmentId
          ? candidate.id === assignmentId
          : conversationId
            ? candidate.conversationId === conversationId
            : false
      );
      const issue = issueId
        ? snapshot.issues.find((candidate) => candidate.id === issueId)
        : assignment
          ? snapshot.issues.find((candidate) => candidate.id === assignment.issueId)
          : undefined;
      const assignmentsForIssue = issueId
        ? snapshot.assignments.filter((candidate) => candidate.issueId === issueId)
        : snapshot.assignments;
      const relatedEvents = newEvents.filter((event) => {
        if (assignment && event.assignmentId === assignment.id) {
          return true;
        }
        if (issue && event.issueId === issue.id) {
          return true;
        }
        return false;
      });

      switch (waitFor) {
        case "issue_update":
          return {
            matched:
              Boolean(issue && initialIssue && issue.updatedAt > initialIssue.updatedAt) ||
              relatedEvents.some((event) => event.issueId === issue?.id),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "issue_comment":
          return {
            matched: relatedEvents.some((event) => event.kind === "comment_added"),
            matchedEvents: relatedEvents.filter((event) => event.kind === "comment_added"),
            issue,
            assignment,
          };
        case "issue_done":
          return {
            matched: issue?.columnId === "done",
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_update":
          return {
            matched:
              Boolean(
                assignment &&
                  initialAssignment &&
                  (assignment.updatedAt > initialAssignment.updatedAt ||
                    assignment.status !== initialAssignment.status)
              ) || relatedEvents.some((event) => event.assignmentId === assignment?.id),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_status":
          return {
            matched: Boolean(assignment && targetStatuses.includes(assignment.status)),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "assignment_finished":
          return {
            matched: Boolean(
              assignment &&
                ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(assignment.status)
            ),
            matchedEvents: relatedEvents,
            issue,
            assignment,
          };
        case "any_assignment_finished": {
          const matchedAssignment = assignmentsForIssue.find((candidate) => {
            if (!ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(candidate.status)) {
              return false;
            }
            const initialStatus = initialAssignmentStatusById.get(candidate.id);
            return (
              !initialStatus ||
              !ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(initialStatus)
            );
          });
          return {
            matched: Boolean(matchedAssignment),
            matchedEvents: newEvents.filter(
              (event) => event.assignmentId === matchedAssignment?.id
            ),
            issue: matchedAssignment
              ? snapshot.issues.find((candidate) => candidate.id === matchedAssignment.issueId)
              : issue,
            assignment: matchedAssignment,
          };
        }
        case "all_issue_assignments_finished":
          return {
            matched:
              assignmentsForIssue.length > 0 &&
              assignmentsForIssue.every((candidate) =>
                ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES.includes(candidate.status)
              ),
            matchedEvents: newEvents.filter((event) => event.issueId === issueId),
            issue,
            assignment,
          };
        case "board_update":
        default:
          return {
            matched:
              snapshot.board.updatedAt > initialSnapshot.board.updatedAt ||
              newEvents.length > 0,
            matchedEvents: newEvents,
            issue,
            assignment,
          };
      }
    };

    let elapsedMs = 0;
    let statusElapsedMs = 0;
    let snapshot = initialSnapshot;
    while (elapsedMs < timeoutMs) {
      if (this.cancelled || this.disposed) {
        throw new Error("Orchestration wait interrupted.");
      }
      const immediate = evaluate(snapshot);
      if (immediate.matched) {
        return safeJson({
          conditionMet: true,
          waitedMs: elapsedMs,
          waitFor,
          reason,
          issue: immediate.issue ?? null,
          assignment: immediate.assignment ?? null,
          matchedEvents: immediate.matchedEvents.slice(-10),
          boardUpdatedAt: snapshot.board.updatedAt,
        });
      }
      const chunkMs = Math.min(pollMs, timeoutMs - elapsedMs);
      await new Promise((resolve) => setTimeout(resolve, chunkMs));
      elapsedMs += chunkMs;
      statusElapsedMs += chunkMs;
      snapshot = await this.resolveCurrentOrchestrationBoard();
      if (statusElapsedMs >= ORCHESTRATION_WAIT_HEARTBEAT_MS || elapsedMs >= timeoutMs) {
        statusElapsedMs = 0;
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Waiting for ${waitFor} (${Math.round(elapsedMs / 1000)}s / ${Math.round(timeoutMs / 1000)}s): ${reason}`,
          },
        ]);
      }
    }
    const final = evaluate(snapshot);
    return safeJson({
      conditionMet: final.matched,
      waitedMs: timeoutMs,
      waitFor,
      reason,
      issue: final.issue ?? null,
      assignment: final.assignment ?? null,
      matchedEvents: final.matchedEvents.slice(-10),
      boardUpdatedAt: snapshot.board.updatedAt,
      recentEvents: snapshot.events.slice(-10),
    });
  }

  private summarizeWorkflowRun(run: WorkflowRunRecord): string {
    const returnPreview =
      run.returnValue === undefined
        ? null
        : typeof run.returnValue === "string"
          ? run.returnValue.slice(0, 4000)
          : JSON.stringify(run.returnValue, null, 2)?.slice(0, 4000) ?? null;
    return safeJson({
      runId: run.runId,
      status: run.status,
      name: run.meta.name,
      description: run.meta.description,
      scriptPath: run.scriptPath,
      currentPhase: run.currentPhase,
      agentsUsed: run.agentsUsed,
      maxAgents: run.maxAgents,
      tokensUsed: run.tokensUsed,
      tokenBudget: run.tokenBudget,
      error: run.error,
      returnValue: run.returnValue,
      returnPreview,
      recentLogs: run.logs.slice(-12),
      agents: run.agents.slice(-20).map((agent) => ({
        id: agent.id,
        label: agent.label,
        phase: agent.phase,
        status: agent.status,
        error: agent.error,
        resultPreview: agent.resultPreview,
      })),
    });
  }

  private async spawnWorkflowAgent(request: WorkflowAgentSpawnRequest): Promise<{
    value: unknown;
    tokensUsed?: number;
  }> {
    const modelId =
      request.model ||
      resolvedModelId(this.callbacks.conversation.config.modelId, this.configOptions);
    const providerId = providerPart(modelId);
    const auth = await resolveCesiumAuth({
      modelId,
      configuredApiKind:
        providerId === "openai"
          ? (optionValue(this.configOptions, "api_kind", "openai-responses") as CesiumProviderKind)
          : undefined,
    });
    const schemaHint = request.schema
      ? `\n\nYou MUST respond with ONLY valid JSON matching this JSON Schema (no markdown fences):\n${JSON.stringify(request.schema, null, 2)}`
      : "\n\nYour final text response is returned verbatim to the orchestration script as the agent() result. Prefer concise structured text.";
    const system = [
      this.activeSystemPrompt,
      "You are a subagent spawned by a Cesium Workflow orchestration script.",
      "Complete the assigned task. Do not spawn additional workflows or subagents.",
      schemaHint,
    ].join("\n\n");

    let lastError: string | null = null;
    let tokensUsed = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runAdapter({
        apiKind: auth.apiKind,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        providerId: auth.providerId,
        oauth: auth.oauth,
        modelId,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              attempt === 0
                ? request.prompt
                : `${request.prompt}\n\nPrevious response failed validation: ${lastError}\nReturn corrected output only.`,
          },
        ],
      });
      tokensUsed += result.usage ? result.usage.inputTokens + result.usage.outputTokens : 0;
      const text = result.text.trim();
      if (!request.schema) {
        return {
          value:
            text ||
            (result.toolRequests.length > 0
              ? `Workflow agent requested unsupported tools: ${result.toolRequests
                  .map((tool) => tool.name)
                  .join(", ")}`
              : ""),
          ...(tokensUsed > 0 ? { tokensUsed } : {}),
        };
      }
      try {
        const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        return { value: JSON.parse(jsonText) as unknown, ...(tokensUsed > 0 ? { tokensUsed } : {}) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(lastError ?? "Workflow agent failed schema validation.");
  }

  private async toolWorkflowRun(args: Record<string, unknown>): Promise<string> {
    const scriptPathArg = asString(args.scriptPath);
    const scriptArg = asString(args.script);
    let script = scriptArg ?? "";
    if (scriptPathArg) {
      script = await readWorkflowScriptFile(scriptPathArg);
    }
    if (!script.trim()) {
      throw new Error("workflow_run requires script or scriptPath.");
    }

    const wait = args.wait !== false;
    const tokenBudget = asNumber(args.tokenBudget);
    const maxAgents = asNumber(args.maxAgents);
    const maxConcurrent = asNumber(args.maxConcurrent);
    const resumeFromRunId = asString(args.resumeFromRunId);

    const provisionalId = randomUUID();
    const scriptPath =
      scriptPathArg ??
      (await persistWorkflowScript({
        workspace: this.callbacks.workspace,
        runId: provisionalId,
        script,
      }));

    let run = createWorkflowRunRecord({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      script,
      scriptPath,
      args: args.args,
      tokenBudget: tokenBudget ?? null,
      maxAgents: maxAgents ?? undefined,
      maxConcurrent: maxConcurrent ?? undefined,
      resumeFromRunId: resumeFromRunId ?? undefined,
    });
    // Keep script filename aligned with the final run id when we generated the path.
    if (!scriptPathArg) {
      const rewritten = await persistWorkflowScript({
        workspace: this.callbacks.workspace,
        runId: run.runId,
        script,
      });
      run = { ...run, scriptPath: rewritten };
    }
    run = await upsertWorkflowRun(run);

    const journalSeed = resumeFromRunId
      ? await seedJournalFromPriorRun({
          workspaceId: this.callbacks.workspace.id,
          priorRunId: resumeFromRunId,
        })
      : [];

    if (!wait) {
      void executeWorkflowRun({
        run,
        journalSeed,
        spawnAgent: (request) => this.spawnWorkflowAgent(request),
      }).catch(() => undefined);
      return safeJson({
        status: "async_launched",
        runId: run.runId,
        scriptPath: run.scriptPath,
        summary: "Workflow started in the background. Use workflow_status or workflow_await.",
      });
    }

    const completed = await executeWorkflowRun({
      run,
      journalSeed,
      spawnAgent: (request) => this.spawnWorkflowAgent(request),
    });
    return this.summarizeWorkflowRun(completed);
  }

  private async toolWorkflowStatus(args: Record<string, unknown>): Promise<string> {
    const runId = asString(args.runId);
    const run = runId
      ? await readWorkflowRun({
          workspaceId: this.callbacks.workspace.id,
          runId,
        })
      : await readLatestWorkflowRunForConversation({
          workspaceId: this.callbacks.workspace.id,
          conversationId: this.callbacks.conversation.id,
        });
    if (!run) {
      return "No workflow run found for this conversation.";
    }
    return this.summarizeWorkflowRun(run);
  }

  private async toolWorkflowAwait(args: Record<string, unknown>): Promise<string> {
    const runId = asString(args.runId);
    const timeoutMs = Math.min(
      Math.max(asNumber(args.timeoutMs) ?? 120_000, 1_000),
      600_000
    );
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const run = runId
        ? await readWorkflowRun({
            workspaceId: this.callbacks.workspace.id,
            runId,
          })
        : await readLatestWorkflowRunForConversation({
            workspaceId: this.callbacks.workspace.id,
            conversationId: this.callbacks.conversation.id,
          });
      if (!run) {
        throw new Error("No workflow run found to await.");
      }
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "cancelled"
      ) {
        return this.summarizeWorkflowRun(run);
      }
      await sleepMs(500);
    }
    throw new Error(`Timed out waiting for workflow run${runId ? ` ${runId}` : ""}.`);
  }

  private async toolSubagent(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const instructions = asString(args.instructions);
    if (!instructions) throw new Error("subagent.instructions is required.");
    // Reuse the spawning tool call id so the projected tool card and the dedicated
    // subagent events merge into a single card instead of duplicating.
    const subagentId = toolCallId || randomUUID();
    const title = asString(args.title) ?? "Cesium subagent";
    // Same inherit-by-default + Model access validation as spawn_agent (V2).
    const modelId = await resolveCesiumSpawnModelId({
      requested: asString(args.modelId),
      defaultModelId: resolvedModelId(
        this.callbacks.conversation.config.modelId,
        this.configOptions
      ),
    });
    // Transcript events need distinct seqs: projection dedupes stored events by seq.
    const transcript: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "user_message",
        messageId: randomUUID(),
        content: instructions,
      },
    ];
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "subagent",
        subagentId,
        title,
        status: "running",
        transcript: [...transcript],
        recentActivity: instructions.slice(0, 240),
        raw: args,
      },
    ]);
    // Live progress: re-emit the running card (with the growing transcript) on
    // the parent event stream so an open subagent tab updates in real time
    // instead of freezing on "Working" until the terminal card lands.
    let finished = false;
    const progress = createSubagentProgressBroadcaster({
      emit: () => {
        if (finished) {
          return Promise.resolve();
        }
        return this.callbacks
          .appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "subagent",
              subagentId,
              title,
              status: "running",
              transcript: [...transcript],
              recentActivity:
                latestSubagentTranscriptActivity(transcript) ?? instructions.slice(0, 240),
              raw: args,
            },
          ])
          .then(() => undefined);
      },
    });
    let status: "completed" | "failed" = "completed";
    let resultText = "";
    try {
      const subagentProviderId = providerPart(modelId);
      const auth = await resolveCesiumAuth({
        modelId,
        configuredApiKind:
          subagentProviderId === "openai"
            ? (optionValue(this.configOptions, "api_kind", "openai-responses") as CesiumProviderKind)
            : undefined,
      });
      const toolset = this.buildSubagentToolset(null);
      const toolGuidance = subagentToolsetGuidance(toolset);
      const result = await runSubagentToolLoop({
        adapter: {
          apiKind: auth.apiKind,
          apiKey: auth.apiKey,
          baseUrl: auth.baseUrl,
          providerId: auth.providerId,
          oauth: auth.oauth,
          modelId,
        },
        messages: [
          {
            role: "system",
            content:
              `${this.activeSystemPrompt}\n\nYou are a child subagent. Do not spawn additional subagents.` +
              (toolGuidance ? `\n\n${toolGuidance}` : ""),
          },
          { role: "user", content: instructions },
        ],
        toolset,
        isAborted: () => this.cancelled || this.disposed,
        onToolCallStart: (event) => {
          pushRunningSubagentToolRow({
            transcript,
            conversationId: this.callbacks.conversation.id,
            toolCallId: event.toolCallId,
            name: event.name,
            arguments: event.arguments,
          });
          progress.notify();
        },
        onToolCall: (event) => {
          settleSubagentToolRow({
            transcript,
            conversationId: this.callbacks.conversation.id,
            toolCallId: event.toolCallId,
            name: event.name,
            result: event.result,
            ok: event.ok,
          });
          progress.notify();
        },
      });
      resultText =
        result.text.trim() ||
        (result.toolCallCount > 0
          ? `Subagent made ${result.toolCallCount} tool call(s) but returned no final text.`
          : "Subagent completed without visible text.");
    } catch (error) {
      status = "failed";
      resultText = error instanceof Error ? error.message : String(error);
    }
    // Stop live progress before the terminal card so a stale running card can
    // never land after (and re-open) the settled state.
    finished = true;
    progress.stop();
    transcript.push(
      {
        seq: transcript.length + 1,
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "assistant_message_chunk",
        messageId: randomUUID(),
        text: resultText,
      }
    );
    this.subagentTranscripts.set(subagentId, transcript);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "subagent",
        subagentId,
        title,
        status,
        transcript: [...transcript],
        recentActivity: resultText.slice(0, 240),
        raw: args,
      },
    ]);
    return `Subagent ${subagentId} ${status}: ${resultText}`;
  }

  /**
   * Transcript of a subagent from the parent's persisted `subagent` cards. The
   * in-memory maps only cover subagents this session handle ran itself; after
   * a restart (or in a re-ensured handle) the persisted copy is the only one.
   * Production readSnapshot() is a bounded head, so fall through to the full
   * event log the same way buildHistory does.
   */
  private async readPersistedSubagentTranscript(
    subagentId: string
  ): Promise<AgentStoredEvent[] | null> {
    const snapshot = await this.callbacks.readSnapshot().catch(() => null);
    const fromSnapshot = findPersistedSubagentTranscript(snapshot?.events ?? [], subagentId);
    if (fromSnapshot) {
      return fromSnapshot;
    }
    const fullEvents = await readConversationEvents(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => [] as AgentStoredEvent[]);
    return findPersistedSubagentTranscript(fullEvents, subagentId);
  }

  private async toolReadSubagentTranscript(args: Record<string, unknown>): Promise<string> {
    const subagentId = asString(args.subagentId);
    if (!subagentId) throw new Error("read_subagent_transcript.subagentId is required.");
    const transcript =
      this.subagentTranscripts.get(subagentId) ??
      (await this.readPersistedSubagentTranscript(subagentId));
    if (!transcript) {
      const current = await findOrchestrationBoardForHeadConversation(
        this.callbacks.workspace.id,
        this.callbacks.conversation.id
      ).catch(() => null);
      if (current) {
        const assignment = current.assignments.find(
          (candidate) =>
            candidate.id === subagentId || candidate.conversationId === subagentId
        );
        if (assignment) {
          throw new Error(
            `${subagentId} is a kanban child agent assignment, not an ephemeral subagent. Use orchestration_read_agent_transcript with assignmentId or conversationId instead.`
          );
        }
      }
      return `No ephemeral subagent transcript found for ${subagentId}. For kanban child agents assigned via orchestration_assign_agent, use orchestration_read_agent_transcript.`;
    }
    const offset = Math.max(0, Math.floor(asNumber(args.offset) ?? 0));
    const limit = Math.max(1, Math.min(200, Math.floor(asNumber(args.limit) ?? 50)));
    return transcript
      .slice(offset, offset + limit)
      .map((event) => `${event.kind}: ${safeJson(event)}`)
      .join("\n");
  }

  private async toolSearchHistory(args: Record<string, unknown>): Promise<string> {
    const query = asString(args.query);
    if (!query) throw new Error("search_history.query is required.");
    const maxResults = Math.max(1, Math.min(50, Math.floor(asNumber(args.maxResults) ?? 10)));
    const snapshot = await this.callbacks.readSnapshot();
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matches = (snapshot?.events ?? [])
      .filter((event) => regex.test(safeJson(event)))
      .slice(-maxResults);
    return matches.length ? matches.map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n\n") : "No history matches.";
  }

  private async toolReadHistoryPage(args: Record<string, unknown>): Promise<string> {
    const beforeSeq = Math.floor(asNumber(args.beforeSeq) ?? Number.MAX_SAFE_INTEGER);
    const limitTurns = Math.max(1, Math.min(250, Math.floor(asNumber(args.limitTurns) ?? 25)));
    const snapshot = await this.callbacks.readSnapshot();
    const events = (snapshot?.events ?? []).filter((event) => event.seq < beforeSeq);
    let users = 0;
    let start = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]!.kind === "user_message") {
        users += 1;
        start = index;
        if (users >= limitTurns) break;
      }
    }
    return events.slice(start).map((event) => `seq ${event.seq} ${event.kind}: ${safeJson(event)}`).join("\n");
  }

  private async toolListConversations(args: Record<string, unknown>): Promise<string> {
    return listConversationsForAgent({
      query: asString(args.query),
      workspaceId: asString(args.workspaceId),
      limit: asNumber(args.limit),
      currentConversationId: this.callbacks.conversation.id,
    });
  }

  private async toolReadConversation(args: Record<string, unknown>): Promise<string> {
    const conversationId = asString(args.conversationId);
    if (!conversationId) {
      throw new Error("read_conversation.conversationId is required.");
    }
    return readConversationTranscriptForAgent({
      conversationId,
      limitTurns: asNumber(args.limitTurns),
      maxChars: asNumber(args.maxChars),
    });
  }

  private async toolSearchConversations(args: Record<string, unknown>): Promise<string> {
    const query = asString(args.query);
    if (!query) {
      throw new Error("search_conversations.query is required.");
    }
    return searchConversationsForAgent({
      query,
      conversationId: asString(args.conversationId),
      maxResults: asNumber(args.maxResults),
    });
  }

  /** Read or rename this conversation's display title; optional follow flag. */
  private async toolConversationTitle(args: Record<string, unknown>): Promise<string> {
    const parsed = parseConversationTitleToolArgs(args);
    const current = this.callbacks.conversation;
    const applied = applyConversationTitleAction({
      currentTitle: current.title,
      currentFollow: Boolean(current.config.titleFollow),
      action: parsed.action,
      title: parsed.title,
      follow: parsed.follow,
    });
    if (applied.changed) {
      await this.callbacks.updateConversation((record) => ({
        ...record,
        title: applied.nextTitle,
        config: {
          ...record.config,
          titleFollow: applied.nextFollow,
        },
      }));
    }
    return applied.result;
  }

  /** Curated persistent memory: save/search/list/forget over bounded JSON stores. */
  private async toolMemory(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action)?.trim().toLowerCase();
    const workspaceId = this.callbacks.workspace.id;
    const rawScope = asString(args.scope)?.trim().toLowerCase();
    const scope: CesiumMemoryScope | undefined =
      rawScope === "user" || rawScope === "workspace" ? rawScope : undefined;
    switch (action) {
      case "save": {
        const content = asString(args.content)?.trim();
        if (!content) {
          throw new Error("memory.content is required for save.");
        }
        const rawCategory = asString(args.category)?.trim().toLowerCase();
        const category: CesiumMemoryCategory =
          rawCategory === "preference" ||
          rawCategory === "constraint" ||
          rawCategory === "decision"
            ? rawCategory
            : "fact";
        const entry = await saveCesiumMemoryEntry({
          workspaceId,
          scope: scope ?? "workspace",
          category,
          content,
          sourceConversationId: this.callbacks.conversation.id,
          id: asString(args.id)?.trim() || undefined,
        });
        return `Saved memory entry.\n${formatCesiumMemoryEntry(entry)}`;
      }
      case "search": {
        const query = asString(args.query)?.trim();
        if (!query) {
          throw new Error("memory.query is required for search.");
        }
        const entries = await searchCesiumMemoryEntries({
          workspaceId,
          query,
          scope,
          limit: asNumber(args.limit),
        });
        if (entries.length === 0) {
          return `No memory entries match "${query}".`;
        }
        return [
          `${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} match "${query}":`,
          ...entries.map((entry) => formatCesiumMemoryEntry(entry)),
        ].join("\n");
      }
      case "list": {
        const limit = Math.min(Math.max(asNumber(args.limit) ?? 10, 1), 50);
        const entries = (await listCesiumMemoryEntries({ workspaceId, scope })).slice(0, limit);
        if (entries.length === 0) {
          return scope
            ? `No memory entries saved in the ${scope} scope yet.`
            : "No memory entries saved yet.";
        }
        return [
          `${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} (most recent first):`,
          ...entries.map((entry) => formatCesiumMemoryEntry(entry)),
        ].join("\n");
      }
      case "forget": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("memory.id is required for forget.");
        }
        const removed = await forgetCesiumMemoryEntry({ workspaceId, id });
        if (!removed) {
          return `No memory entry with id ${id}. Use memory list to see current entries.`;
        }
        return `Forgot memory entry.\n${formatCesiumMemoryEntry(removed)}`;
      }
      default:
        throw new Error('memory.action must be one of "save", "search", "list", "forget".');
    }
  }

  /** Agent Skills authoring: create/update/list/read/delete SKILL.md documents. */
  private async toolSkill(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action)?.trim().toLowerCase();
    const workspaceRoot = this.callbacks.workspace.root;
    switch (action) {
      case "create": {
        const name = asString(args.name)?.trim();
        const description = asString(args.description)?.trim();
        const instructions = asString(args.instructions)?.trim();
        if (!name || !description || !instructions) {
          throw new Error("skill.create requires name, description, and instructions.");
        }
        const created = await createAuthoredSkill({
          workspaceRoot,
          name,
          description,
          instructions,
          id: asString(args.id)?.trim() || undefined,
        });
        return (
          `Created skill "${created.name}" (id: ${created.id}) at ${created.relativePath}. ` +
          "It is mirrored under agent-skills/ and will appear in the skills list from the next turn."
        );
      }
      case "update": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("skill.id is required for update.");
        }
        const updated = await updateAuthoredSkill({
          workspaceRoot,
          id,
          name: asString(args.name)?.trim() || undefined,
          description: asString(args.description)?.trim() || undefined,
          instructions: asString(args.instructions)?.trim() || undefined,
        });
        return `Updated skill "${updated.name}" (id: ${updated.id}) at ${updated.relativePath}.`;
      }
      case "list": {
        const skills = await listAuthorableSkills(workspaceRoot);
        if (skills.length === 0) {
          return "No skills discovered in this workspace yet. Use skill create to author one.";
        }
        return [
          `${skills.length} skill${skills.length === 1 ? "" : "s"} discovered:`,
          ...skills.map(
            (skill) =>
              `- ${skill.name} (id: ${slugifySkillId(skill.name)}) - ${skill.description} [${
                skill.authored ? "agent-authored" : `read-only: ${skill.source}`
              }]`
          ),
        ].join("\n");
      }
      case "read": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("skill.id is required for read.");
        }
        const { skill, markdown } = await readSkillById({ workspaceRoot, id });
        return `# ${skill.relativePath}\n\n${markdown}`;
      }
      case "delete": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("skill.id is required for delete.");
        }
        const removed = await deleteAuthoredSkill({ workspaceRoot, id });
        return `Deleted skill "${removed.name}" (id: ${removed.id}).`;
      }
      default:
        throw new Error(
          'skill.action must be one of "create", "update", "list", "read", "delete".'
        );
    }
  }

  /** Scheduled triggers: the agent's proactive wake-ups (cron/interval/once). */
  private async toolSchedule(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action)?.trim().toLowerCase();
    const workspaceId = this.callbacks.workspace.id;
    const parseScheduleArgs = (): CesiumTriggerSchedule => {
      const cron = asString(args.cron)?.trim();
      const everyMinutes = asNumber(args.everyMinutes);
      const atMs = asNumber(args.atMs);
      const provided = [cron, everyMinutes, atMs].filter(
        (value) => value !== undefined && value !== null && value !== ""
      );
      if (provided.length !== 1) {
        throw new Error(
          "Provide exactly one of schedule.cron, schedule.everyMinutes, or schedule.atMs."
        );
      }
      if (cron) {
        return normalizeTriggerSchedule({ kind: "cron", expression: cron });
      }
      if (everyMinutes != null) {
        return normalizeTriggerSchedule({ kind: "interval", everyMs: everyMinutes * 60_000 });
      }
      return normalizeTriggerSchedule({ kind: "once", atMs: atMs! });
    };
    switch (action) {
      case "create": {
        const name = asString(args.name)?.trim();
        const prompt = asString(args.prompt)?.trim();
        if (!name || !prompt) {
          throw new Error("schedule.create requires name and prompt.");
        }
        const trigger = await createCesiumTrigger({
          workspaceId,
          name,
          prompt,
          schedule: parseScheduleArgs(),
          mode: asString(args.mode)?.trim() || undefined,
          // Pin the creating conversation's model so scheduled fires never
          // fall back to an unconfigured provider default.
          modelId: this.callbacks.conversation.config.modelId || undefined,
          modelName: this.callbacks.conversation.config.modelName || undefined,
          maxRuns: asNumber(args.maxRuns) ?? undefined,
          sourceConversationId: this.callbacks.conversation.id,
        });
        return `Created trigger.\n${formatCesiumTrigger(trigger)}`;
      }
      case "list": {
        const triggers = await listCesiumTriggers(workspaceId);
        if (triggers.length === 0) {
          return "No scheduled triggers in this workspace. Use schedule create to add one.";
        }
        return [
          `${triggers.length} trigger${triggers.length === 1 ? "" : "s"}:`,
          ...triggers.map((trigger) => formatCesiumTrigger(trigger)),
        ].join("\n");
      }
      case "update": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("schedule.id is required for update.");
        }
        const hasScheduleInput =
          asString(args.cron)?.trim() || asNumber(args.everyMinutes) != null || asNumber(args.atMs) != null;
        const updated = await updateCesiumTrigger({
          workspaceId,
          id,
          patch: {
            ...(asString(args.name)?.trim() ? { name: asString(args.name)!.trim() } : {}),
            ...(asString(args.prompt)?.trim() ? { prompt: asString(args.prompt)!.trim() } : {}),
            ...(asString(args.mode) !== undefined ? { mode: asString(args.mode)?.trim() } : {}),
            ...(asNumber(args.maxRuns) != null ? { maxRuns: asNumber(args.maxRuns)! } : {}),
            ...(hasScheduleInput ? { schedule: parseScheduleArgs() } : {}),
          },
        });
        return `Updated trigger.\n${formatCesiumTrigger(updated)}`;
      }
      case "pause":
      case "resume": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error(`schedule.id is required for ${action}.`);
        }
        const updated = await updateCesiumTrigger({
          workspaceId,
          id,
          patch: { enabled: action === "resume" },
        });
        return `${action === "resume" ? "Resumed" : "Paused"} trigger.\n${formatCesiumTrigger(updated)}`;
      }
      case "delete": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("schedule.id is required for delete.");
        }
        const removed = await deleteCesiumTrigger({ workspaceId, id });
        if (!removed) {
          return `No trigger with id ${id}. Use schedule list to see current triggers.`;
        }
        return `Deleted trigger "${removed.name}" (id: ${removed.id}).`;
      }
      case "run": {
        const id = asString(args.id)?.trim();
        if (!id) {
          throw new Error("schedule.id is required for run.");
        }
        const triggers = await listCesiumTriggers(workspaceId);
        const trigger = triggers.find((entry) => entry.id === id);
        if (!trigger) {
          return `No trigger with id ${id}. Use schedule list to see current triggers.`;
        }
        const firedAt = Date.now();
        const marked = await markCesiumTriggerFired({ workspaceId, id, firedAt });
        const { agentRuntimeManager } = await import("./runtime-manager.js");
        const snapshot = await agentRuntimeManager.createConversationWithPrompt(
          this.callbacks.workspace,
          {
            backendId: "cesium-agent",
            ...(trigger.mode ? { mode: trigger.mode } : {}),
            ...(trigger.modelId ? { modelId: trigger.modelId } : {}),
            ...(trigger.modelName ? { modelName: trigger.modelName } : {}),
            title: `⏰ ${trigger.name}`,
            origin: {
              kind: "trigger",
              triggerId: trigger.id,
              triggerName: trigger.name,
              firedAt,
            },
          },
          { text: formatTriggerPromptPreamble(trigger, firedAt) }
        );
        await attachCesiumTriggerConversation({
          workspaceId,
          id,
          conversationId: snapshot.conversation.id,
        }).catch(() => null);
        return (
          `Fired trigger "${trigger.name}" now -> conversation ${snapshot.conversation.id}.` +
          (marked && !marked.enabled ? " The trigger is now disabled (run cap reached)." : "")
        );
      }
      default:
        throw new Error(
          'schedule.action must be one of "create", "list", "update", "pause", "resume", "delete", "run".'
        );
    }
  }

  /**
   * Self-relocation across git branches in the current workspace.
   *
   * NOTE(future): extend agent self-relocation beyond branches - the agent
   * could move this conversation to another repository, workspace, or
   * directory via `agentRuntimeManager.relocateConversation` with
   * `initiatedBy: "agent"`, letting it hop to a new project and keep working
   * there. Branch-only for now, on purpose.
   */
  private async toolSwitchBranch(args: Record<string, unknown>): Promise<string> {
    const branch = asString(args.branch)?.trim();
    if (!branch) {
      throw new Error("switch_branch.branch is required.");
    }
    const create = args.create === true;
    const workspaces = await listWorkspaces().catch(() => [this.callbacks.workspace]);
    const result = await switchWorkspaceBranch({
      workspace: this.callbacks.workspace,
      workspaces,
      branch,
      create,
    });
    if (result.checkedOutWorktree) {
      return (
        `Branch ${branch} is already checked out in worktree ${result.checkedOutWorktree.path}` +
        `${result.checkedOutWorktree.workspaceName ? ` (workspace "${result.checkedOutWorktree.workspaceName}")` : ""}. ` +
        "This checkout was left untouched - run terminal commands against that path, or ask the user to relocate this conversation there."
      );
    }
    return (
      `Switched ${this.callbacks.workspace.root} to branch ${result.status.currentBranch ?? branch}` +
      `${result.created ? " (newly created)" : ""}. ` +
      "Files may differ on this branch - re-verify paths and re-read key files before editing."
    );
  }

  private async toolCreateWorktree(args: Record<string, unknown>): Promise<string> {
    const branch = asString(args.branch)?.trim();
    if (!branch) {
      throw new Error("create_worktree.branch is required.");
    }
    const baseBranch = asString(args.baseBranch)?.trim();
    const workspaces = await listWorkspaces().catch(() => [this.callbacks.workspace]);
    const result = await createWorkspaceWorktree({
      workspace: this.callbacks.workspace,
      workspaces,
      branch,
      ...(baseBranch ? { baseBranch } : {}),
      newBranch: true,
    });
    if (result.existingWorktree) {
      return (
        `Branch ${branch} already has a worktree at ${result.path}. Reuse it via terminal commands ` +
        "against that path instead of creating another checkout."
      );
    }
    return (
      `Worktree ready at ${result.path} on branch ${result.branch}` +
      `${result.setup.ran ? ` (setup commands ran: ${result.setup.commands.join("; ")})` : ""}. ` +
      "Keep one workstream per worktree: run its commands via terminal against that path, and when the work " +
      "is verified, merge the branch back (git merge/rebase from the main checkout) and remove the worktree."
    );
  }
}

export async function createCesiumAgentProvider(input: {
  backend: AgentBackendInfo;
  configOptions?: AgentConfigOption[];
}): Promise<AgentProvider> {
  const configOptions = input.configOptions?.length
    ? input.configOptions
    : await createCesiumAgentConfigOptions();
  return {
    backend: input.backend,
    async startSession(callbacks: AgentRuntimeCallbacks) {
      const handle = new CesiumSessionHandle(input.backend, callbacks, configOptions);
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks: AgentRuntimeCallbacks, providerSessionId: string) {
      const handle = new CesiumSessionHandle(input.backend, callbacks, configOptions, providerSessionId);
      await handle.initialize();
      return handle;
    },
  };
}
