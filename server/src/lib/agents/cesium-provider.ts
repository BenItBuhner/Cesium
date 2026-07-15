import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatGitSummaryForPrompt,
  type BuildCesiumSystemPromptInput,
  type McpServerSummary,
} from "@cesium/core/mcp";
import { getGitWorkspaceStatus } from "../git-worktrees.js";
import {
  createCesiumAgentConfigOptions,
  getCesiumAgentSettings,
  resolveCesiumModelContextWindow,
  resolveCesiumAuth,
  type CesiumProviderKind,
} from "../cesium-agent-settings.js";
import {
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../global-settings-store.js";
import {
  callMcpTool,
  refreshWorkspaceMcpMirror,
} from "../mcp/connection-manager.js";
import { getMcpCatalogRevision, getMcpServer, getMcpSummariesForPrompt } from "../mcp/server-store.js";
import { resolveAgentPluginAttachments } from "../plugins/attachments.js";
import { BROWSER_MCP_SERVER_ID } from "../mcp/builtin-browser-tools.js";
import { generateTranscriptFromEvents } from "./event-log-read.js";
import { asNumber } from "./json-coerce.js";
import { readConversationEvents } from "./session-store.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import { buildCesiumModeReminder } from "./cesium-mode-reminders.js";
import { resolveCesiumModeToolPolicy } from "./cesium-mode-policy.js";
import {
  readCesiumPlanFile,
  writeCesiumPlanFile,
} from "./cesium-plan-files.js";
import { loadWorkspaceInstructionFiles } from "./instruction-files.js";
import { resolveWorkspaceSkillsList } from "./workspace-skills.js";
import {
  appendBurnGoalSnapshot,
  blockBurnGoal,
  completeBurnGoal,
  ensureBurnGoalForConversation,
  formatBurnGoalForModel,
  pauseBurnGoal,
  readBurnGoalForConversation,
  resumeBurnGoal,
  updateBurnGoal,
  updateBurnGoalPlan,
  updateBurnGoalProgress,
} from "./burn-goal-store.js";
import { burnCompactionRecoveryContext } from "./burn-goal-steering.js";
import {
  addOrchestrationComment,
  createOrchestrationIssue,
  deleteOrchestrationIssue,
  findOrchestrationAssignmentForConversation,
  readOrchestrationBoardSnapshot,
  resolveOrCreateOrchestrationBoardForHeadConversation,
  upsertOrchestrationAssignment,
  upsertOrchestrationIssue,
} from "../orchestration/store.js";
import type {
  OrchestrationAssignmentRecord,
  OrchestrationAssignmentPermissionPolicy,
  OrchestrationAssignmentStatus,
  OrchestrationBoardSnapshot,
  OrchestrationColumnId,
  OrchestrationIssuePriority,
  OrchestrationPermissionDecision,
} from "../orchestration/types.js";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  formatCompressingContextStatusDetail,
  formatTakingLongerStatusDetail,
  isTransientProviderCompletionError,
  sleepMs,
} from "./completion-retry.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationStatus,
  AgentEventInput,
  AgentQueuedChatPrompt,
  AgentPermissionOption,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
  AgentToolCallStatus,
} from "./types.js";
import {
  asRecord,
  asString,
  asStringArray,
  safeJson,
  truncate,
} from "./cesium/cesium-coerce.js";
import {
  CESIUM_MAX_TOOL_ITERATIONS,
  CESIUM_RESPONSE_WARNING_MS,
  CESIUM_SYSTEM_PROMPT,
  DEFAULT_GREP_RESULTS,
  HISTORY_COMPACTION_TARGET_TURNS,
  HISTORY_COMPACTION_THRESHOLD_RATIO,
  HISTORY_TURN_LIMIT,
  LARGE_FILE_LINE_LIMIT,
  MAX_GREP_RESULTS,
  MAX_READ_LINES,
  ORCHESTRATION_ASSIGNMENT_TERMINAL_STATUSES,
  ORCHESTRATION_WAIT_DEFAULT_MS,
  ORCHESTRATION_WAIT_HEARTBEAT_MS,
  PERMISSION_OPTIONS,
  TERMINAL_OUTPUT_CAP,
} from "./cesium/cesium-prompt.js";
import {
  cesiumPermissionToolKey,
  normalizeCallMcpToolArgs,
  normalizeCesiumToolRequestArguments,
  permissionDecisionFromOption,
  toolKind,
  toolTitle,
} from "./cesium/cesium-tools.js";
import {
  estimateHistoryTokens,
  isEmptyCesiumAdapterResult,
  latestMcpReminderSnapshot,
  mcpReminderChangeNotice,
  mcpReminderSnapshot,
  normalizeCesiumToolResultForModel,
  normalizeEventsToHistory,
  summarizeForCompression,
} from "./cesium/cesium-history.js";
import {
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
  sanitizeOpenAiCompatibleJsonSchema,
} from "./cesium/cesium-tools.js";
export type { NormalizedCallMcpToolArgs } from "./cesium/cesium-tools.js";
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
  output: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
};

function optionValue(options: AgentConfigOption[], id: string, fallback: string): string {
  return options.find((option) => option.id === id)?.currentValue || fallback;
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

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}

function statusFromError(error: unknown): { status: AgentToolCallStatus; detail: string } {
  return {
    status: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

const USER_REFUSED_TOOL_CALL_RESULT =
  "The user refused this tool call. Continue in a different fashion that is either less intrusive or destructive.";
const CESIUM_STREAM_CHUNK_FLUSH_MS = 120;
const CESIUM_STREAM_CHUNK_MIN_CHARS = 512;

class PermissionRefusedToolCallError extends Error {
  constructor() {
    super(USER_REFUSED_TOOL_CALL_RESULT);
    this.name = "PermissionRefusedToolCallError";
  }
}

type CesiumPausePhase = "none" | "pause_requested" | "pausing" | "paused";

class CesiumSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  readonly capabilities: AgentBackendInfo["capabilities"];

  private disposed = false;
  private cancelled = false;
  private pausePhase: CesiumPausePhase = "none";
  private resumeWaiter: (() => void) | null = null;
  private resumeAck: (() => void) | null = null;
  private pendingPermissions = new Map<string, ActivePermission>();
  private pendingQuestions = new Map<string, ActiveQuestion>();
  private terminalRuns = new Map<string, TerminalRun>();
  private subagentTranscripts = new Map<string, AgentStoredEvent[]>();
  private activeSystemPrompt = CESIUM_SYSTEM_PROMPT;

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
    const mode = this.callbacks.conversation.config.mode?.trim();
    if (mode) {
      this.configOptions = updateConfigOption(this.configOptions, "mode", mode);
    }
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
    mcpSummaries: McpServerSummary[]
  ): Promise<BuildCesiumSystemPromptInput> {
    const workspaceRoot = this.callbacks.workspace.root;
    let gitSummary = "not a git repository";
    try {
      const status = await getGitWorkspaceStatus(this.callbacks.workspace, []);
      gitSummary = formatGitSummaryForPrompt(status);
    } catch {
      gitSummary = "not a git repository";
    }
    const [agentsMarkdown, skillsList] = await Promise.all([
      loadWorkspaceInstructionFiles(workspaceRoot),
      resolveWorkspaceSkillsList(workspaceRoot),
    ]);
    return {
      mcpSummaries,
      modelName: this.callbacks.conversation.config.modelName ?? "configured model",
      workspaceRoot,
      dateLabel: new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short",
      }),
      gitSummary,
      agentsMarkdown,
      skillsList: skillsList || undefined,
    };
  }

  private isOrchestrationMode(): boolean {
    return this.currentMode() === "orchestration";
  }

  private isBurnMode(): boolean {
    return this.currentMode() === "burn";
  }

  private currentMode(): string {
    return optionValue(
      this.configOptions,
      "mode",
      this.callbacks.conversation.config.mode ?? "agent"
    );
  }

  private createAssistantChunkFlusher(messageId: string): {
    push: (text: string) => Promise<void>;
    flush: () => Promise<void>;
  } {
    let pending = "";
    let lastFlushAt = 0;
    const flush = async () => {
      if (!pending) {
        return;
      }
      const text = pending;
      pending = "";
      lastFlushAt = Date.now();
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId,
          text,
        },
      ]);
    };
    return {
      push: async (text: string) => {
        if (!text) {
          return;
        }
        pending += text;
        const now = Date.now();
        if (
          pending.length >= CESIUM_STREAM_CHUNK_MIN_CHARS ||
          now - lastFlushAt >= CESIUM_STREAM_CHUNK_FLUSH_MS
        ) {
          await flush();
        }
      },
      flush,
    };
  }

  private async resolveCurrentOrchestrationBoard() {
    return resolveOrCreateOrchestrationBoardForHeadConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      title: this.callbacks.conversation.title || "Orchestration Mode",
      allowedBackendIds: ["cesium-agent"],
    });
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
    isRetry?: boolean;
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Cesium session has been disposed.");
    }
    this.cancelled = false;
    this.pausePhase = "none";
    this.resumeWaiter = null;
    this.releaseResumeAck();
    const assistantMessageId = `cesium-assistant-${randomUUID()}`;
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
    try {
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
      const summaries = await getMcpSummariesForPrompt(this.callbacks.workspace.id);
      const pluginAttachments = await resolveAgentPluginAttachments({
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
      const currentMode = this.currentMode();
      const board = this.isOrchestrationMode()
        ? await this.resolveCurrentOrchestrationBoard()
        : null;
      const burnState = this.isBurnMode()
        ? await ensureBurnGoalForConversation({
            workspace: this.callbacks.workspace,
            conversationId: this.callbacks.conversation.id,
            objective: input.text,
          })
        : null;
      const promptContext = await this.resolveSystemPromptContext(summaries);
      this.activeSystemPrompt = CESIUM_SYSTEM_PROMPT;
      const previousSnapshot = await this.callbacks.readSnapshot().catch(() => null);
      const mcpCatalogRevision = await getMcpCatalogRevision(this.callbacks.workspace.id);
      const currentMcpSnapshot = mcpReminderSnapshot({
        revision: mcpCatalogRevision,
        dateLabel: promptContext.dateLabel,
        summaries,
      });
      const mcpChangeNotice = mcpReminderChangeNotice(
        previousSnapshot ? latestMcpReminderSnapshot(previousSnapshot.events) : null,
        currentMcpSnapshot
      );
      const reminderText = buildCesiumModeReminder({
        mode: currentMode,
        modelName: promptContext.modelName,
        workspaceRoot: promptContext.workspaceRoot ?? this.callbacks.workspace.root,
        dateLabel: promptContext.dateLabel ?? new Date().toLocaleString("en-US"),
        gitSummary: promptContext.gitSummary ?? "not a git repository",
        agentsMarkdown: promptContext.agentsMarkdown,
        skillsList: [promptContext.skillsList, pluginAttachments.skillsList]
          .filter((value) => value?.trim())
          .join("\n"),
        mcpSummaries: summaries,
        mcpChangeNotice,
        orchestrationBoard: board,
        handoffPlanPath: input.planHandoff?.planPath,
        burnGoalSummary: burnState ? formatBurnGoalForModel(burnState) : null,
      });
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system_reminder",
          reminderId: `mode-${input.userMessageId}`,
          targetMessageId: input.userMessageId,
          reason: input.planHandoff ? "plan_handoff" : "mode",
          text: reminderText,
          raw: {
            mode: currentMode,
            planHandoff: input.planHandoff,
            modelId,
            mcpServerCount: summaries.length,
            mcpReminderSnapshot: currentMcpSnapshot,
          },
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `Cesium is connecting to ${modelProviderId}…`,
        },
      ]);
      const history = await this.buildHistory(input.userMessageId);
      if (!history.some((message) => message.role === "user" && message.content === input.text)) {
        history.push({ role: "user", content: input.text });
      }
      const toolResultMessages: CesiumHistoryMessage[] = [];
      let usedToolResultChars = 0;
      let completedToolCallCount = 0;
      for (let iteration = 0; ; iteration += 1) {
        if (iteration >= CESIUM_MAX_TOOL_ITERATIONS) {
          throw new Error(
            `Cesium stopped after ${CESIUM_MAX_TOOL_ITERATIONS} tool-response iterations to avoid an infinite tool loop. ` +
              "Send a follow-up prompt to continue from the current state."
          );
        }
        if (this.cancelled) {
          return;
        }
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
        }
        const assistantChunks = this.createAssistantChunkFlusher(assistantMessageId);
        let result: CesiumAdapterResult | null = null;
        try {
          result = await this.runAdapterWithWarning(
            {
              apiKind: auth.apiKind,
              apiKey: auth.apiKey,
              baseUrl: auth.baseUrl,
              providerId: auth.providerId,
              modelId,
              messages: [...history, ...toolResultMessages],
            },
            iteration,
            {
              onTextDelta: (text) => assistantChunks.push(text),
            }
          );
        } finally {
          await assistantChunks.flush();
        }
        if (!result) {
          throw new Error("Cesium streaming adapter did not produce a result.");
        }
        if (result.reasoning) {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "reasoning",
              messageId: `${assistantMessageId}-reasoning-${iteration}`,
              text: result.reasoning,
              raw: result.raw,
            },
          ]);
        }
        if (result.toolRequests.length === 0) {
          if (isEmptyCesiumAdapterResult(result)) {
            throw new Error(
              `Cesium received an empty model response from ${modelProviderId}/${modelPart(modelId)} with no text and no tool calls. ` +
                "Treating this as an upstream provider failure instead of a completed turn. " +
                `Raw response: ${truncate(safeJson(result.raw), 2000)}`
            );
          }
          history.push({ role: "assistant", content: result.text });
          await this.finishAssistant(assistantMessageId, result.raw);
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
        for (const request of result.toolRequests) {
          if (this.cancelled) {
            return;
          }
          const toolResult = await this.executeTool(request);
          const normalizedToolResult = normalizeCesiumToolResultForModel({
            toolName: request.name,
            result: toolResult,
            usedToolResultChars,
          });
          usedToolResultChars = normalizedToolResult.usedToolResultChars;
          toolResultMessages.push({
            role: "tool",
            toolCallId: request.id,
            name: request.name,
            content: normalizedToolResult.content,
          });
          completedToolCallCount += 1;
          if (completedToolCallCount % 8 === 0) {
            await this.emitConversationStatus(
              "running",
              `Cesium is continuing after ${completedToolCallCount} tool calls…`
            );
          }
        }
        await this.waitAtPauseCheckpoint();
        if (this.cancelled) {
          return;
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
      console.warn("[cesium-agent] turn failed:", message);
      if (this.isBurnMode()) {
        await pauseBurnGoal({
          workspace: this.callbacks.workspace,
          conversationId: this.callbacks.conversation.id,
          reason: `Provider error: ${message}`,
        }).catch(() => undefined);
      }
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
    }
  }

  private async runAdapterWithWarning(
    input: RunAdapterInput,
    iteration: number,
    handlers: {
      onTextDelta?: (text: string) => Promise<void>;
    } = {}
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
    try {
      for (let retryIndex = 0; ; retryIndex += 1) {
        if (this.cancelled) {
          throw new CesiumTurnCancelledError();
        }
        let emittedDelta = false;
        try {
          const textParts: string[] = [];
          const reasoningParts: string[] = [];
          const toolRequests: CesiumToolRequest[] = [];
          const rawEvents: unknown[] = [];
          let finalRaw: unknown;
          for await (const event of streamAdapter(input)) {
            if (this.cancelled) {
              throw new CesiumTurnCancelledError();
            }
            if ("raw" in event && event.raw !== undefined) {
              finalRaw = event.raw;
              rawEvents.push(event.raw);
            }
            switch (event.kind) {
              case "text_delta":
                textParts.push(event.text);
                emittedDelta = emittedDelta || event.text.length > 0;
                await handlers.onTextDelta?.(event.text);
                break;
              case "reasoning_delta":
                reasoningParts.push(event.text);
                break;
              case "tool_request":
                toolRequests.push(event.request);
                break;
              case "raw":
              case "done":
                break;
            }
          }
          return {
            text: textParts.join(""),
            reasoning: reasoningParts.join("") || undefined,
            toolRequests,
            raw: rawEvents.length > 1 ? rawEvents : finalRaw,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const canRetry =
            retryIndex < COMPLETION_AUTO_RETRY_MAX_ATTEMPTS &&
            !emittedDelta &&
            isTransientProviderCompletionError(message);
          if (!canRetry) {
            throw error;
          }
          const delayMs =
            COMPLETION_RETRY_DELAYS_MS[
              Math.min(retryIndex, COMPLETION_RETRY_DELAYS_MS.length - 1)
            ] ?? COMPLETION_RETRY_DELAYS_MS[0]!;
          console.warn(
            `[cesium-agent] transient provider error (attempt ${retryIndex + 1}/${COMPLETION_AUTO_RETRY_MAX_ATTEMPTS}), retrying in ${delayMs}ms:`,
            message
          );
          await this.emitConversationStatus(
            "running",
            formatTakingLongerStatusDetail(retryIndex + 1, COMPLETION_AUTO_RETRY_MAX_ATTEMPTS)
          );
          await sleepMs(delayMs);
          if (this.cancelled) {
            throw new CesiumTurnCancelledError();
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
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
    const modeOption = this.configOptions.find((option) => option.id === "mode");
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
      config: {
        ...current.config,
        modelId: modelOption?.currentValue ?? current.config.modelId,
        modelName:
          modelOption?.options.find((option) => option.value === modelOption.currentValue)?.name ??
          current.config.modelName,
        mode:
          configId === "mode"
            ? value
            : (modeOption?.currentValue ?? current.config.mode),
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
    const decision = input.cancelled ? "reject" : permissionDecisionFromOption(input.optionId);
    const optionId = input.cancelled ? undefined : input.optionId;
    if (optionId === "allow_always" || optionId === "reject_always") {
      await saveRememberedAgentPermissionRule({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: pending.toolKey,
        toolLabel: pending.toolLabel,
        decision,
        optionId,
        optionKind: optionId,
      }).catch(() => undefined);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
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
    this.pausePhase = "none";
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.releaseResumeAck();
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

  private killTerminalRuns(): void {
    for (const run of this.terminalRuns.values()) {
      if (run.exitCode === undefined) {
        run.process.kill();
      }
    }
    this.terminalRuns.clear();
  }

  private async finishAssistant(messageId: string, raw?: unknown): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId,
        stopReason: "end_turn",
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

  private async buildHistory(currentUserMessageId: string): Promise<CesiumHistoryMessage[]> {
    const snapshot = await this.callbacks.readSnapshot();
    const snapshotEvents = snapshot?.events ?? [];
    const fullEvents = await readConversationEvents(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => snapshotEvents);
    const events = fullEvents.length > snapshotEvents.length ? fullEvents : snapshotEvents;
    const visibleUserTurns = events.filter(
      (event) => event.kind === "user_message" && !event.hidden
    ).length;
    const currentMessages = this.normalizeEventsToHistory(events);
    const contextWindow = await resolveCesiumModelContextWindow(
      optionValue(
        this.configOptions,
        "model",
        this.callbacks.conversation.config.modelId || "openai/gpt-5.1"
      )
    ).catch(() => 100_000);
    const estimatedTokensBefore = estimateHistoryTokens(currentMessages);
    const shouldCompact =
      visibleUserTurns > HISTORY_TURN_LIMIT ||
      estimatedTokensBefore >= contextWindow * HISTORY_COMPACTION_THRESHOLD_RATIO;
    if (shouldCompact) {
      const sorted = [...events].sort((a, b) => a.seq - b.seq);
      let retainedUsers = 0;
      let splitIndex = 0;
      for (let index = sorted.length - 1; index >= 0; index -= 1) {
        const event = sorted[index]!;
        if (event.kind === "user_message" && !event.hidden) {
          retainedUsers += 1;
          splitIndex = index;
          if (retainedUsers >= HISTORY_COMPACTION_TARGET_TURNS) {
            break;
          }
        }
      }
      const compressed = sorted.slice(0, splitIndex);
      const retained = sorted.slice(splitIndex);
      const compressedFromSeq = compressed[0]?.seq ?? 0;
      const compressedToSeq = compressed[compressed.length - 1]?.seq ?? 0;
      const latestSummary = [...sorted].reverse().find(
        (event): event is Extract<AgentStoredEvent, { kind: "compression_summary" }> =>
          event.kind === "compression_summary"
      );
      const latestSummaryToSeq = latestSummary?.sourceRange?.toSeq ?? 0;
      if (compressed.length > 0 && compressedToSeq > latestSummaryToSeq) {
        await this.emitConversationStatus("running", formatCompressingContextStatusDetail());
        const retainedMessages = this.normalizeEventsToHistory(retained);
        const estimatedTokensAfter = estimateHistoryTokens(retainedMessages);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "compression_summary",
            messageId: `cesium-compression-${randomUUID()}`,
            summary: summarizeForCompression(compressed),
            retainedTurnCount: retainedUsers,
            compressedTurnCount: compressed.filter(
              (event) => event.kind === "user_message" && !event.hidden
            ).length,
            sourceRange: { fromSeq: compressedFromSeq, toSeq: compressedToSeq },
            estimatedTokensBefore,
            estimatedTokensAfter,
            generation: (latestSummary?.generation ?? 0) + 1,
          },
        ]);
      }
      const visibleRetained = retained.filter(
        (event) => event.kind !== "user_message" || !event.hidden
      );
      const history = this.normalizeEventsToHistory(visibleRetained);
      if (this.isBurnMode()) {
        const burnGoal = await readBurnGoalForConversation({
          workspace: this.callbacks.workspace,
          conversationId: this.callbacks.conversation.id,
        });
        if (burnGoal) {
          history.push({ role: "user", content: burnCompactionRecoveryContext(burnGoal) });
        }
      }
      return history;
    }
    return this.normalizeEventsToHistory(
      events.filter((event) =>
        event.kind !== "user_message" ||
        (!event.hidden && (event.messageId !== currentUserMessageId || event.seq > 0))
      )
    );
  }

  private normalizeEventsToHistory(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
    const base = normalizeEventsToHistory(events);
    return [{ role: "system", content: this.activeSystemPrompt }, ...base.slice(1)];
  }

  private async requirePermission(input: {
    toolCallId: string;
    title: string;
    detail: string;
    permission: "editFile" | "terminal" | "mcpCall";
    toolKey: string;
    toolLabel: string;
  }): Promise<void> {
    const assignment = await findOrchestrationAssignmentForConversation(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id
    ).catch(() => null);
    const orchestrationPolicy = assignment
      ? assignment.config.permissionPolicy?.[input.permission] ?? "allow"
      : undefined;
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

    const [settings, globalSettings] = await Promise.all([
      getCesiumAgentSettings(),
      getGlobalSettings().catch(() => null),
    ]);
    let policy = settings.toolPermissions[input.permission];
    if (input.permission === "mcpCall" && globalSettings?.agents.mcpProt) {
      policy = "ask";
    }
    if (policy === "deny") {
      throw new Error(`${input.title} blocked by Cesium permission settings.`);
    }

    const remembered = globalSettings?.agents.rememberedPermissions.find(
      (rule) =>
        rule.workspaceId === this.callbacks.workspace.id &&
        rule.backendId === this.backend.id &&
        rule.toolKey === input.toolKey
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

    if (globalSettings?.agents.autoAcceptAllAgentPermissions) {
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
        options: PERMISSION_OPTIONS,
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
        options: PERMISSION_OPTIONS,
      },
    }));
    const decision = await new Promise<"allow" | "reject">((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        toolKey: input.toolKey,
        toolLabel: input.toolLabel,
      });
    });
    if (decision !== "allow") {
      throw new PermissionRefusedToolCallError();
    }
  }

  private async executeTool(request: CesiumToolRequest): Promise<string> {
    const effectiveRequest =
      request.name === "call_mcp_tool"
        ? {
            ...request,
            arguments: normalizeCesiumToolRequestArguments(request.name, request.arguments),
          }
        : request;
    const title = toolTitle(effectiveRequest.name, effectiveRequest.arguments);
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
      toolKind: toolKind(effectiveRequest.name),
      status: "in_progress",
      detail: safeJson(effectiveRequest.arguments),
      pluginId: mcpServerForTool?.pluginId,
      pluginName: mcpServerForTool?.displayName,
      pluginIconUrl: mcpServerForTool?.iconUrl,
      raw: effectiveRequest,
    };
    await this.callbacks.appendEvents([callEvent]);
    try {
      let result: string;
      const policy = resolveCesiumModeToolPolicy({
        mode: this.currentMode(),
        toolName: request.name,
      });
      if (!policy.allowed) {
        throw new Error(policy.reason ?? `Tool ${request.name} is blocked in the active mode.`);
      }
      if (request.name === "edit_file") {
        await this.requirePermission({
          toolCallId: request.id,
          title,
          detail: safeJson(request.arguments),
          permission: "editFile",
          toolKey: cesiumPermissionToolKey("editFile", request.arguments),
          toolLabel: title,
        });
      } else if (request.name === "terminal") {
        await this.requirePermission({
          toolCallId: request.id,
          title,
          detail: safeJson(request.arguments),
          permission: "terminal",
          toolKey: cesiumPermissionToolKey("terminal", request.arguments),
          toolLabel: title,
        });
      }
      switch (request.name) {
        case "read_file":
          result = await this.toolReadFile(request.arguments);
          break;
        case "grep":
          result = await this.toolGrep(request.arguments);
          break;
        case "edit_file":
          result = await this.toolEditFile(request.arguments, request.id, title);
          break;
        case "terminal":
          result = await this.toolTerminal(request.arguments);
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
        case "burn_goal_set":
          result = await this.toolBurnGoalSet(request.arguments);
          break;
        case "burn_goal_pause":
          result = await this.toolBurnGoalPause(request.arguments);
          break;
        case "burn_goal_block":
          result = await this.toolBurnGoalBlock(request.arguments);
          break;
        case "burn_goal_summarize":
          result = await this.toolBurnGoalSummarize(request.arguments);
          break;
        case "burn_goal_complete":
          result = await this.toolBurnGoalComplete();
          break;
        case "burn_goal_get":
          result = await this.toolBurnGoalGet();
          break;
        case "burn_goal_update_plan":
          result = await this.toolBurnGoalUpdatePlan(request.arguments);
          break;
        case "burn_goal_update_progress":
          result = await this.toolBurnGoalUpdateProgress(request.arguments);
          break;
        case "burn_goal_summarize_state":
          result = await this.toolBurnGoalSummarize(request.arguments);
          break;
        case "burn_goal_resume":
          result = await this.toolBurnGoalResume();
          break;
        case "ask_question":
          result = await this.toolAskQuestion(request.arguments);
          break;
        case "subagent":
          result = await this.toolSubagent(request.arguments);
          break;
        case "read_subagent_transcript":
          result = await this.toolReadSubagentTranscript(request.arguments);
          break;
        case "search_history":
          result = await this.toolSearchHistory(request.arguments);
          break;
        case "read_history_page":
          result = await this.toolReadHistoryPage(request.arguments);
          break;
        case "call_mcp_tool":
          result = await this.toolCallMcp(effectiveRequest.arguments, effectiveRequest.id, title);
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
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: request.id,
          title,
          toolKind: toolKind(request.name),
          status: "completed",
          detail: result,
          raw: { request: effectiveRequest, result },
        },
      ]);
      return result;
    } catch (error) {
      if (error instanceof PermissionRefusedToolCallError) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: request.id,
            title,
            toolKind: toolKind(request.name),
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
          toolCallId: request.id,
          title,
          toolKind: toolKind(request.name),
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
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, inputPath);
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
    const root = resolveWorkspacePath(this.callbacks.workspace.root, asString(args.path) ?? ".");
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

  private async toolEditFile(
    args: Record<string, unknown>,
    toolCallId: string,
    title: string
  ): Promise<string> {
    const inputPath = asString(args.path);
    const oldString = typeof args.oldString === "string" ? args.oldString : "";
    const newString = typeof args.newString === "string" ? args.newString : "";
    if (!inputPath) throw new Error("edit_file.path is required.");
    if (!oldString) throw new Error("edit_file.oldString is required.");
    const resolved = resolveWorkspacePath(this.callbacks.workspace.root, inputPath);
    const before = await fs.readFile(resolved, "utf8");
    const first = before.indexOf(oldString);
    if (first < 0) throw new Error("oldString was not found.");
    if (before.indexOf(oldString, first + oldString.length) >= 0) {
      throw new Error("oldString matches more than once; include more context.");
    }
    const after = `${before.slice(0, first)}${newString}${before.slice(first + oldString.length)}`;
    await fs.writeFile(resolved, after, "utf8");
    const editPreview = extractToolEditPreview(
      { path: inputPath, oldString, newString },
      { beforeFullFileContent: before, afterFullFileContent: after },
      inputPath
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        title,
        toolKind: "edit",
        status: "in_progress",
        detail: "Applied edit preview.",
        locations: [{ path: inputPath }],
        editPreview,
      },
    ]);
    return `Edited ${inputPath}.`;
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
      output: "",
      startedAt: Date.now(),
    };
    this.terminalRuns.set(id, run);
    const append = (chunk: Buffer) => {
      run.output = truncate(`${run.output}${chunk.toString("utf8")}`, TERMINAL_OUTPUT_CAP);
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
      run.output = truncate(`${run.output}\n[spawn failed] ${error.message}`, TERMINAL_OUTPUT_CAP);
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
        if (waitUntil === "pattern" && pattern && run.output.includes(pattern)) {
          clearInterval(interval);
          resolve(`Pattern matched for ${command}.\n${run.output}`);
          return;
        }
        if (run.exitCode !== undefined) {
          clearInterval(interval);
          resolve(`Command exited ${run.exitCode ?? 0}.\n${run.output}`);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(interval);
          resolve(`Command still running after ${timeoutMs}ms as ${id}.\n${run.output}`);
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

  private async toolBurnGoalGet(): Promise<string> {
    const goal = await readBurnGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return goal ? formatBurnGoalForModel(goal) : "No Burn goal exists for this conversation.";
  }

  private async toolBurnGoalSet(args: Record<string, unknown>): Promise<string> {
    const objective = asString(args.objective);
    let goal = await readBurnGoalForConversation({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    if (!goal) {
      if (!objective) {
        throw new Error("burn_goal_set.objective is required when no Burn goal exists.");
      }
      goal = await ensureBurnGoalForConversation({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        objective,
      });
    } else if (objective && objective !== goal.objective) {
      goal = await updateBurnGoal({
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
      goal = await updateBurnGoalPlan({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        planSummary: asString(args.planSummary),
        milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
        todos: Array.isArray(args.todos) ? args.todos : undefined,
      });
    }

    if (Array.isArray(args.verificationEvidence)) {
      goal = await updateBurnGoalProgress({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        verificationEvidence: args.verificationEvidence,
      });
    }

    const progressPercent = asNumber(args.progressPercent);
    const headline = asString(args.headline);
    if (progressPercent != null || headline) {
      const patch: Parameters<typeof updateBurnGoal>[0]["patch"] = {};
      if (progressPercent != null) {
        const rounded = Math.round(progressPercent);
        if (
          !Number.isFinite(progressPercent) ||
          rounded !== progressPercent ||
          rounded < 0 ||
          rounded > 100
        ) {
          throw new Error("burn_goal_set.progressPercent must be an integer from 0 to 100.");
        }
        patch.progressPercent = rounded;
      }
      if (headline) {
        patch.headline = headline;
      }
      goal = await updateBurnGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch,
      });
    }

    if (goal.status === "planning") {
      goal = await updateBurnGoal({
        workspace: this.callbacks.workspace,
        conversationId: this.callbacks.conversation.id,
        patch: {
          status: "active",
          phase: goal.phase === "planning" ? "executing" : goal.phase,
        },
      });
    }

    return `Burn goal set.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalUpdatePlan(args: Record<string, unknown>): Promise<string> {
    const planSummary = asString(args.planSummary);
    if (!planSummary) {
      throw new Error("burn_goal_update_plan.planSummary is required.");
    }
    const goal = await updateBurnGoalPlan({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      planSummary,
      milestones: Array.isArray(args.milestones) ? args.milestones : [],
      todos: Array.isArray(args.todos) ? args.todos : [],
    });
    return `Burn plan recorded.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalUpdateProgress(args: Record<string, unknown>): Promise<string> {
    const goal = await updateBurnGoalProgress({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      milestones: Array.isArray(args.milestones) ? args.milestones : undefined,
      todos: Array.isArray(args.todos) ? args.todos : undefined,
      verificationEvidence: Array.isArray(args.verificationEvidence)
        ? args.verificationEvidence
        : undefined,
    });
    return `Burn progress updated.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalSummarize(args: Record<string, unknown>): Promise<string> {
    const progressPercent = asNumber(args.progressPercent);
    const summary = asString(args.summary);
    if (progressPercent == null) {
      throw new Error("burn_goal_summarize.progressPercent is required.");
    }
    if (!summary) {
      throw new Error("burn_goal_summarize.summary is required.");
    }
    const goal = await appendBurnGoalSnapshot({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      progressPercent,
      summary,
      headline: asString(args.headline),
    });
    return `Burn goal summarized.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalComplete(): Promise<string> {
    const goal = await completeBurnGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return `Burn goal complete.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalBlock(args: Record<string, unknown>): Promise<string> {
    const reason = asString(args.reason);
    if (!reason) {
      throw new Error("burn_goal_block.reason is required.");
    }
    const goal = await blockBurnGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      reason,
      evidence: asString(args.evidence),
    });
    return goal.status === "blocked"
      ? `Burn goal blocked.\n\n${formatBurnGoalForModel(goal)}`
      : `Blocker recorded but Burn goal remains active until the same blocker repeats across at least three Burn turns.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalPause(args: Record<string, unknown>): Promise<string> {
    const goal = await pauseBurnGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
      reason: asString(args.reason),
    });
    return `Burn goal paused.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolBurnGoalResume(): Promise<string> {
    const goal = await resumeBurnGoal({
      workspace: this.callbacks.workspace,
      conversationId: this.callbacks.conversation.id,
    });
    return `Burn goal resumed.\n\n${formatBurnGoalForModel(goal)}`;
  }

  private async toolTodo(args: Record<string, unknown>): Promise<string> {
    const action = asString(args.action) ?? "list";
    const items = Array.isArray(args.items) ? args.items : [];
    if (this.isOrchestrationMode()) {
      const snapshot = await this.resolveCurrentOrchestrationBoard();
      if (action === "list") {
        const lines = snapshot.issues.map(
          (issue) =>
            `${issue.columnId}: ${issue.title}${
              issue.acceptanceCriteria.length
                ? ` (${issue.acceptanceCriteria.length} acceptance criteria)`
                : ""
            }`
        );
        return lines.length
          ? lines.join("\n")
          : "No orchestration issues yet. Use orchestration_create_issue or provide todo items to create board issues.";
      }

      const parsedItems = items.flatMap((item) => {
        const record = asRecord(item);
        const content =
          asString(record?.content) ??
          asString(record?.title) ??
          asString(record?.text) ??
          asString(record?.description) ??
          asString(item);
        if (!content) return [];
        const status = asString(record?.status)?.toLowerCase();
        const columnId: OrchestrationColumnId =
          status === "completed"
            ? "done"
            : status === "blocked"
              ? "blocked"
              : status === "in_progress" || status === "in-progress"
                ? "in_progress"
                : "backlog";
        return [{ content, columnId }];
      });
      let current = snapshot;
      const touchedIssues: string[] = [];
      for (const item of parsedItems) {
        const existing = current.issues.find(
          (issue) => issue.title.trim().toLowerCase() === item.content.trim().toLowerCase()
        );
        if (existing) {
          current = await upsertOrchestrationIssue(
            current.board.id,
            { id: existing.id, columnId: item.columnId },
            { type: "head_agent", conversationId: this.callbacks.conversation.id }
          );
          touchedIssues.push(existing.id);
          continue;
        }
        current = await createOrchestrationIssue({
          boardId: current.board.id,
          title: item.content,
          columnId: item.columnId,
          actor: { type: "head_agent", conversationId: this.callbacks.conversation.id },
        });
        const created = current.issues[current.issues.length - 1];
        if (created) {
          touchedIssues.push(created.id);
        }
      }
      return safeJson({
        boardId: current.board.id,
        message:
          "Mapped todo items onto orchestration board issues. Continue managing work with orchestration_* issue tools.",
        issueIds: touchedIssues,
      });
    }
    if (action === "list") {
      const snapshot = await this.callbacks.readSnapshot();
      const latest = [...(snapshot?.events ?? [])].reverse().find((event) => event.kind === "plan");
      return latest?.kind === "plan"
        ? latest.entries.map((entry) => `${entry.status}: ${entry.content}`).join("\n")
        : "No todos yet.";
    }
    const entries = items.flatMap((item, index) => {
      const record = asRecord(item);
      const content =
        asString(record?.content) ??
        asString(record?.title) ??
        asString(record?.text) ??
        asString(record?.description) ??
        asString(item);
      if (!content) return [];
      const rawStatus = asString(record?.status);
      const normalizedStatus = rawStatus?.toLowerCase();
      const status: "pending" | "in_progress" | "blocked" | "completed" =
        normalizedStatus === "completed" || normalizedStatus === "done"
          ? "completed"
          : normalizedStatus === "blocked" || normalizedStatus === "stuck"
            ? "blocked"
            : normalizedStatus === "in_progress" ||
                normalizedStatus === "in-progress" ||
                normalizedStatus === "in progress" ||
                normalizedStatus === "running"
              ? "in_progress"
              : "pending";
      return [
        {
          id: asString(record?.id) ?? asString(record?.title) ?? `todo-${index + 1}`,
          content,
          status,
        },
      ];
    });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "plan",
        planId: "cesium-todos",
        entries,
        raw: args,
      },
    ]);
    return `Stored ${entries.length} todo item${entries.length === 1 ? "" : "s"}.`;
  }

  private async toolAskQuestion(args: Record<string, unknown>): Promise<string> {
    const parseOptions = (value: unknown): Array<{ id: string; label: string }> =>
      Array.isArray(value)
        ? value.flatMap((option, index) => {
            const record = asRecord(option);
            const label = asString(record?.label) ?? asString(record?.text) ?? asString(option);
            if (!label) return [];
            return [{ id: asString(record?.id) ?? `option-${index + 1}`, label }];
          })
        : [];
    const questionsFromArgs = Array.isArray(args.questions)
      ? args.questions.flatMap((question, index): CesiumQuestionStep[] => {
          const record = asRecord(question);
          if (!record) return [];
          const prompt = asString(record.prompt) ?? asString(record.title);
          const options = parseOptions(record.options);
          if (!prompt || options.length === 0) return [];
          return [
            {
              id: asString(record.id) ?? `question-${index + 1}`,
              prompt,
              options,
              allowMultiple: record.allowMultiple === true || record.allow_multiple === true,
            },
          ];
        })
      : [];
    const prompt = asString(args.prompt) ?? (questionsFromArgs.length > 1 ? "Questions" : questionsFromArgs[0]?.prompt);
    const options = parseOptions(args.options);
    const allowMultiple = args.allowMultiple === true || args.allow_multiple === true;
    const questions =
      questionsFromArgs.length > 0
        ? questionsFromArgs
        : prompt && options.length > 0
          ? [{ id: "single", prompt, options, allowMultiple }]
          : [];
    if (!prompt || questions.length === 0) {
      throw new Error("ask_question requires either prompt/options or a non-empty questions array.");
    }
    const primaryOptions = questions[0]?.options ?? options;
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

  private async toolCallMcp(
    args: Record<string, unknown>,
    toolCallId: string,
    title: string
  ): Promise<string> {
    const normalized = normalizeCallMcpToolArgs(args);
    const serverId = normalized.serverId;
    const toolName = normalized.toolName;
    const toolArgs = normalized.arguments;
    if (!serverId || !toolName) {
      throw new Error("call_mcp_tool requires serverId and toolName.");
    }
    if (serverId === BROWSER_MCP_SERVER_ID && this.isOrchestrationMode()) {
      throw new Error("Browser MCP tools are only available to normal Cesium Agent conversations.");
    }
    await this.requirePermission({
      toolCallId,
      title,
      detail: `${serverId} - ${toolName}\n${JSON.stringify(toolArgs)}`,
      permission: "mcpCall",
      toolKey: cesiumPermissionToolKey("mcpCall", { serverId, toolName }),
      toolLabel: title,
    });
    return await callMcpTool({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      serverId,
      toolName,
      arguments: toolArgs,
    });
  }

  private async toolRefreshMcpServers(): Promise<string> {
    await refreshWorkspaceMcpMirror({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
    });
    const summaries = await getMcpSummariesForPrompt(this.callbacks.workspace.id);
    this.activeSystemPrompt = CESIUM_SYSTEM_PROMPT;
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
    const snapshot = await createOrchestrationIssue({
      boardId: current.board.id,
      title,
      description: asString(args.description),
      columnId: asOrchestrationColumnId(args.columnId),
      priority: asOrchestrationPriority(args.priority),
      acceptanceCriteria: asStringArray(args.acceptanceCriteria),
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
        ...(typeof args.blockedReason === "string" || args.blockedReason === null
          ? { blockedReason: args.blockedReason }
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
      `You are assigned to Orchestration Mode issue "${issue.title}".`,
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
          issue ? `Steering update for Orchestration Mode issue "${issue.title}".` : "Steering update.",
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

  private async toolSubagent(args: Record<string, unknown>): Promise<string> {
    const instructions = asString(args.instructions);
    if (!instructions) throw new Error("subagent.instructions is required.");
    const subagentId = randomUUID();
    const title = asString(args.title) ?? "Cesium subagent";
    const modelId =
      asString(args.modelId) ||
      resolvedModelId(this.callbacks.conversation.config.modelId, this.configOptions);
    const transcript: AgentStoredEvent[] = [
      {
        seq: 0,
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "user_message",
        messageId: randomUUID(),
        content: instructions,
      },
    ];
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
      const result = await runAdapter({
        apiKind: auth.apiKind,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        providerId: auth.providerId,
        modelId,
        messages: [
          { role: "system", content: `${CESIUM_SYSTEM_PROMPT}\n\nYou are a child subagent. Do not spawn additional subagents.` },
          { role: "user", content: instructions },
        ],
      });
      resultText =
        result.text.trim() ||
        (result.toolRequests.length > 0
          ? `Subagent requested unsupported child tools: ${result.toolRequests.map((tool) => tool.name).join(", ")}`
          : "Subagent completed without visible text.");
    } catch (error) {
      status = "failed";
      resultText = error instanceof Error ? error.message : String(error);
    }
    transcript.push(
      {
        seq: 0,
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
        transcript,
        recentActivity: resultText.slice(0, 240),
        raw: args,
      },
    ]);
    return `Subagent ${subagentId} ${status}: ${resultText}`;
  }

  private async toolReadSubagentTranscript(args: Record<string, unknown>): Promise<string> {
    const subagentId = asString(args.subagentId);
    if (!subagentId) throw new Error("read_subagent_transcript.subagentId is required.");
    const transcript = this.subagentTranscripts.get(subagentId);
    if (!transcript) {
      if (this.isOrchestrationMode()) {
        const current = await this.resolveCurrentOrchestrationBoard();
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
      return `No ephemeral subagent transcript found for ${subagentId}. In Orchestration Mode, use orchestration_read_agent_transcript for kanban child agents assigned via orchestration_assign_agent.`;
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
