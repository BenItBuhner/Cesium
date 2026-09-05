import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type OnElicitation,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  claudeCodeSdkModelAliasEnv,
  getClaudeCodeSdkPathToExecutable,
  getClaudeCodeSdkProxyApiKey,
  getClaudeCodeSdkProxyBaseUrl,
  getClaudeCodeSdkProxyModel,
  hasClaudeCodeSdkProxyConfig,
  hasClaudeCodeSdkUsableAuth,
  isThirdPartyClaudeCodeSdkProxy,
} from "../claude-code-sdk-credentials.js";
import {
  ClaudeStreamedTextReconciler,
  ClaudeTaskPlanTracker,
  blocksFromClaudeAssistantMessage,
  claudeAnswersFromSubmission,
  claudeElicitationContentFromSubmission,
  claudeSlashCommandsFromSdk,
  claudeToolUseToAgentEvent,
  classifyClaudeStreamEvent,
  describeClaudeAssistantError,
  describeClaudeResultFailure,
  describeClaudeSystemEvent,
  formatClaudeUsageDetail,
  isClaudePlaceholderText,
  isClaudeSubagentToolName,
  isClaudeTaskListToolName,
  isSyntheticClaudeAssistantMessage,
  parentToolUseIdFromClaudeMessage,
  parseClaudeAskUserQuestion,
  parseClaudeElicitationForm,
  parseClaudeTaskEvent,
  permissionCategoryForClaudeTool,
  permissionTitleForClaudeTool,
  textFromClaudeAssistantMessage,
  textFromClaudeToolResult,
  textFromClaudeUserMessage,
  toolResultFromClaudeUserMessage,
  usageFromClaudeAssistantMessage,
  usageFromClaudeResult,
  apiMessageIdFromClaudeMessage,
  type ClaudeQuestionStep,
  type ClaudeUsageSummary,
} from "./claude-code-sdk-normalize.js";
import {
  mapClaudeContextCategory,
  readClaudeCodeSdkConversationState,
  writeClaudeCodeSdkConversationState,
  type ClaudeCodeSdkContextUsage,
} from "./claude-code-sdk-session-state.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import { claudeSessionFileExistsForCwd } from "./import/sources/claude-code.js";
import {
  findPrimaryModeConfigOption,
  findPrimaryModelConfigOption,
} from "./config-option-utils.js";
import {
  persistRememberedPermissionChoice,
  resolveRememberedPermissionDecision,
} from "./remembered-permissions.js";
import {
  createSubagentProgressBroadcaster,
  latestSubagentTranscriptActivity,
  type SubagentProgressBroadcaster,
} from "./cesium/subagent-toolset.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentPermissionOptionKind,
  AgentPlanEntry,
  AgentPromptAttachment,
  AgentProvider,
  AgentQueuedChatPrompt,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentSlashCommand,
  AgentStoredEvent,
} from "./types.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";
import {
  providerPlanEvents,
  writeProviderPlanArtifact,
} from "./plan-artifacts.js";
import { harnessLog } from "./harness-diagnostics.js";
import { firstString } from "./json-coerce.js";

/** The SDK's `query` signature, injectable so lifecycle tests can drive a fake CLI. */
export type ClaudeCodeSdkQueryFn = typeof sdkQuery;

export type ClaudeCodeSdkProviderDeps = {
  query?: ClaudeCodeSdkQueryFn;
  /** Skip the on-disk transcript check before `resume` (tests). */
  sessionFileExists?: (sessionId: string, cwd: string) => Promise<boolean>;
  /** Disable the post-turn `getContextUsage()` probe (tests / third-party proxies). */
  contextProbe?: boolean;
  /** Timeouts, overridable for tests. */
  timings?: Partial<ClaudeCodeSdkTimings>;
};

export type ClaudeCodeSdkTimings = {
  /** How long `cancel()` waits for the CLI to acknowledge `interrupt()` with a result. */
  interruptGraceMs: number;
  /** How long to wait for the pump to finish after `close()`. */
  closeGraceMs: number;
  /** Minimum interval between persisted `tool_progress` updates per tool call. */
  toolProgressIntervalMs: number;
  /** Timeout for SDK control requests (models, commands, context usage). */
  controlRequestTimeoutMs: number;
};

const DEFAULT_TIMINGS: ClaudeCodeSdkTimings = {
  interruptGraceMs: 8_000,
  closeGraceMs: 4_000,
  toolProgressIntervalMs: 5_000,
  controlRequestTimeoutMs: 15_000,
};

type ClaudeCodeSdkHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  providerSessionId?: string | null;
  deps: ClaudeCodeSdkProviderDeps;
};

type PendingPermission = {
  kind: "permission";
  resolve: (result: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
  toolName: string;
  toolKey: string;
  toolLabel: string;
  toolUseId: string;
};

type PendingQuestion = {
  kind: "question";
  /** Receives the user's submission text, or `null` when the card was dismissed. */
  onAnswer: (submission: string | null) => void;
  steps: ClaudeQuestionStep[];
  prompt: string;
  /** Extra prompt text (question-tool header, MCP server message) for the answered event. */
  source: "ask_user_question" | "mcp_elicitation";
};

type TurnOutcome =
  | { kind: "success"; result: Record<string, unknown> | null }
  | { kind: "failed"; error: Error; result: Record<string, unknown> | null }
  | { kind: "cancelled"; result: Record<string, unknown> | null };

type TranscriptScope = {
  /** Cesium message id currently receiving assistant text chunks. */
  openMessageId: string | null;
  /** API message id backing `openMessageId` (partial + full messages share it). */
  openApiMessageId: string | null;
  /** `message_stop` already arrived for the open message. */
  stopSeen: boolean;
  /** The complete `assistant` message already arrived for the open message. */
  fullReceived: boolean;
  /** Any text/thinking delta was streamed for the open message. */
  streamedAny: boolean;
  /** At least one text chunk was persisted for the open message (tool-only messages get no end event). */
  emittedChunk: boolean;
  text: ClaudeStreamedTextReconciler;
  thinking: ClaudeStreamedTextReconciler;
  ended: Set<string>;
  counter: number;
};

type ActiveTurn = {
  id: string;
  userMessageId: string;
  startedAt: number;
  cancelRequested: boolean;
  emittedAssistantText: boolean;
  lastApiError: string | null;
  lastAssistantError: string | null;
  /** Most recent CLI note appended this turn, so echoed local-command output is not shown twice. */
  lastSystemText: string | null;
  settled: boolean;
  settle: (outcome: TurnOutcome) => void;
  done: Promise<TurnOutcome>;
  finalized: Promise<void>;
  markFinalized: () => void;
  scope: TranscriptScope;
  /** The process this turn was pushed into; a superseded pump must not settle it. */
  live: LiveQuery | null;
};

type LiveQuery = {
  query: Query;
  input: PushableInput;
  abortController: AbortController;
  fingerprint: string;
  pump: Promise<void>;
  initialized: boolean;
  initTools: string[];
  resumed: boolean;
  error: unknown;
  closed: boolean;
};

type SubagentState = {
  subagentId: string;
  toolUseId: string;
  taskId: string | null;
  title: string;
  meta: string | undefined;
  status: "running" | "completed" | "failed";
  transcript: AgentStoredEvent[];
  scope: TranscriptScope;
  broadcaster: SubagentProgressBroadcaster;
  toolPayloads: Map<string, { name?: string; input?: unknown }>;
  finished: boolean;
  background: boolean;
  lastActivity: string | null;
  /** Signature of the last persisted card, so back-to-back identical emissions collapse. */
  lastEmittedSignature: string | null;
};

const capabilities = AGENT_CAPABILITIES["claude-code-sdk"];

/**
 * Tool profiles. Names are validated against `init.tools`; legacy names
 * (`TodoWrite`, `MultiEdit`) are silently dropped by newer CLIs and newer
 * names by older CLIs, so both generations are listed where relevant.
 */
export const CLAUDE_STANDARD_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "AskUserQuestion",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
];

export const CLAUDE_READONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "TaskList",
  "TaskGet",
  "TaskOutput",
];

/**
 * Explicit "Plan Only" profile: strictly read-only research plus the task
 * list and plan approval. Subagents are deliberately excluded - a subagent
 * inherits this restricted tool set, so a model that needs to write would
 * otherwise delegate to a subagent that also cannot write, recursively.
 */
export const CLAUDE_PLAN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "EnterPlanMode",
  "ExitPlanMode",
];

/** Names that newer/older CLIs drop from `--tools`; never worth a warning. */
const OPTIONAL_TOOL_NAMES = new Set(["TodoWrite", "MultiEdit", "Agent", "Task"]);

const SEARCH_TOOL_NAMES = ["Grep", "Glob"];

const CESIUM_SYSTEM_APPEND = [
  "You are running inside Cesium, which renders your tool calls as structured cards and mirrors your task list into a plan panel.",
  "Prefer the dedicated Grep and Glob tools over shell grep/find for codebase searches.",
  "If a search must use Bash, use ripgrep (`rg`) and exclude node_modules, .git, .next, and .docker.",
  "Never run unbounded recursive `grep -r` over the workspace.",
  "Use AskUserQuestion whenever you need a decision from the user; it renders as an interactive card.",
].join(" ");

const MODE_REMINDERS: Record<string, string> = {
  ask: [
    "You are in Ask mode. Answer the user's questions by reading, searching, and inspecting the codebase.",
    "Do not modify files or run commands that change state; if the user asks for changes, explain what you would do and suggest switching to Agent mode.",
  ].join(" "),
  debug: [
    "You are in Debug mode. Work hypothesis-first: reproduce the problem, gather runtime evidence (logs, targeted instrumentation, failing tests) before changing code, fix the root cause rather than symptoms, and verify the fix the same way you reproduced the bug.",
    "Remove temporary instrumentation before you finish.",
  ].join(" "),
  plan: [
    "You are in Plan mode. Investigate first, then produce a concrete implementation plan and present it with ExitPlanMode.",
    "Do not implement changes until the user approves the plan.",
  ].join(" "),
};

const CANCEL_DENY_MESSAGE = "Cancelled by the user.";

class PushableInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(message: SDKUserMessage): boolean {
    if (this.closed) {
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
    return true;
  }

  end(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          const queued = this.queue.shift();
          if (queued) {
            resolve({ value: queued, done: false });
            return;
          }
          if (this.closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.waiters.push(resolve);
        }),
      return: async () => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

function optionValue(
  configOptions: AgentConfigOption[],
  id: string,
  fallback: string
): string {
  return configOptions.find((option) => option.id === id)?.currentValue || fallback;
}

function withCurrentConfig(
  configOptions: AgentConfigOption[],
  conversation: AgentConversationRecord
): AgentConfigOption[] {
  return configOptions.map((option) => {
    if (option.category === "model") {
      return { ...option, currentValue: conversation.config.modelId || option.currentValue };
    }
    if (option.category === "mode") {
      return { ...option, currentValue: conversation.config.mode || option.currentValue };
    }
    return option;
  });
}

function selectedModel(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): string | undefined {
  const modelOption = findPrimaryModelConfigOption(configOptions);
  const value = (conversation.config.modelId || modelOption?.currentValue || "").trim();
  if (!value || value === "auto" || value === "default") {
    return hasClaudeCodeSdkProxyConfig() ? getClaudeCodeSdkProxyModel() : undefined;
  }
  return value;
}

function optionDisplayName(configOptions: AgentConfigOption[], configId: string, value: string): string {
  return configOptions
    .find((option) => option.id === configId)
    ?.options.find((option) => option.value === value)?.name ?? value;
}

function modeForConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): string {
  const modeOption = findPrimaryModeConfigOption(configOptions);
  return modeOption?.currentValue || conversation.config.mode;
}

function permissionModeForConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): PermissionMode {
  const mode = modeForConfig(conversation, configOptions);
  if (mode === "plan") {
    return "plan";
  }
  const configured = optionValue(configOptions, "permission_mode", "default");
  if (
    configured === "acceptEdits" ||
    configured === "bypassPermissions" ||
    configured === "plan" ||
    configured === "dontAsk" ||
    configured === "auto"
  ) {
    return configured;
  }
  return "default";
}

function effortForConfig(configOptions: AgentConfigOption[]): Options["effort"] | undefined {
  const value = optionValue(configOptions, "effort", "medium");
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function maxTurnsForConfig(configOptions: AgentConfigOption[]): number | undefined {
  const raw = optionValue(configOptions, "max_turns", "unlimited").trim().toLowerCase();
  if (!raw || raw === "unlimited" || raw === "none" || raw === "0") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function maxBudgetForConfig(configOptions: AgentConfigOption[]): number | undefined {
  const raw = Number.parseFloat(optionValue(configOptions, "max_budget_usd", ""));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function toolProfileForConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): { tools: Options["tools"]; allowedTools?: string[] } {
  const mode = modeForConfig(conversation, configOptions);
  if (mode === "ask") {
    return { tools: CLAUDE_READONLY_TOOLS };
  }
  // Plan mode keeps the normal tool set: the CLI's `plan` permission mode is
  // what blocks writes (and lets the plan file through), and once the user
  // approves ExitPlanMode the same process implements the plan. Removing the
  // write tools instead makes the model delegate to subagents that inherit
  // the same restriction and loop forever.
  const profile = optionValue(configOptions, "tool_profile", "standard");
  if (profile === "plan") {
    return { tools: CLAUDE_PLAN_TOOLS };
  }
  if (profile === "safe-readonly") {
    return { tools: CLAUDE_READONLY_TOOLS };
  }
  if (profile === "full") {
    // Native builds serve search through Bash unless Grep/Glob are requested
    // explicitly; `allowedTools` is the documented way to add them to the preset.
    return { tools: { type: "preset", preset: "claude_code" }, allowedTools: SEARCH_TOOL_NAMES };
  }
  return { tools: CLAUDE_STANDARD_TOOLS };
}

function thinkingForConfig(configOptions: AgentConfigOption[]): Options["thinking"] | undefined {
  const value = optionValue(configOptions, "thinking", "adaptive");
  if (value === "disabled") {
    return { type: "disabled" };
  }
  if (value === "adaptive") {
    return { type: "adaptive" };
  }
  const budget = Number.parseInt(value, 10);
  if (Number.isFinite(budget) && budget > 0) {
    return { type: "enabled", budgetTokens: budget };
  }
  return undefined;
}

function settingSourcesForConfig(configOptions: AgentConfigOption[]): Options["settingSources"] {
  const value = optionValue(configOptions, "setting_sources", "all");
  if (value === "none") {
    return [];
  }
  if (value === "project") {
    return ["project", "local"];
  }
  return ["user", "project", "local"];
}

export function claudeCodeSdkEnv(model: string | undefined): NodeJS.ProcessEnv {
  const proxyApiKey = getClaudeCodeSdkProxyApiKey();
  const proxyBaseUrl = getClaudeCodeSdkProxyBaseUrl();
  const proxyMode = hasClaudeCodeSdkProxyConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(proxyApiKey ? { ANTHROPIC_API_KEY: proxyApiKey } : {}),
    ...(proxyBaseUrl ? { ANTHROPIC_BASE_URL: proxyBaseUrl, CLAUDE_CODE_API_BASE_URL: proxyBaseUrl } : {}),
    ...(proxyMode ? claudeCodeSdkModelAliasEnv(model) : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP:
      process.env.CLAUDE_AGENT_SDK_CLIENT_APP ?? "cesium/claude-code-sdk",
  };
  if (proxyMode) {
    // A stale OAuth token would take precedence over the proxy key.
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Third-party hosts have no update / telemetry / marketplace endpoints;
    // skipping that traffic avoids slow startup retries against the proxy.
    if (isThirdPartyClaudeCodeSdkProxy() && !env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    }
  }
  return env;
}

function permissionOptions(): Array<{
  optionId: string;
  name: string;
  kind: AgentPermissionOptionKind;
}> {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
  ];
}

function planApprovalOptions(): Array<{
  optionId: string;
  name: string;
  kind: AgentPermissionOptionKind;
}> {
  return [
    { optionId: "allow_once", name: "Approve and implement", kind: "allow_once" },
    { optionId: "reject_once", name: "Keep planning", kind: "reject_once" },
  ];
}

function permissionDecisionFromOption(optionId: string | undefined): "allow" | "reject" {
  return optionId === "allow_once" || optionId === "allow_always" ? "allow" : "reject";
}

export function permissionToolKey(toolName: string, input: Record<string, unknown>): string {
  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.notebook_path === "string"
          ? input.notebook_path
          : typeof input.command === "string"
            ? input.command
            : typeof input.url === "string"
              ? input.url
              : "";
  return `${toolName}:${path}`.slice(0, 260);
}

export function unsafeRecursiveGrepMessage(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName.toLowerCase() !== "bash") {
    return null;
  }
  const command = typeof input.command === "string" ? input.command : "";
  if (!/\bgrep\b/i.test(command) || !/(^|\s)(?:-[^\s]*r[^\s]*|--recursive)(?:\s|$)/i.test(command)) {
    return null;
  }
  if (/--exclude-dir|--exclude=|--include-dir/i.test(command)) {
    return null;
  }
  return [
    "Recursive grep without directory excludes is too expensive for this workspace.",
    "Use Grep if available, or run:",
    `rg "pattern" --glob "!node_modules/**" --glob "!.git/**" --glob "!.next/**" --glob "!.docker/**"`,
  ].join(" ");
}

function stripDataUrlPrefix(data: string): string {
  const match = data.match(/^data:[^;]+;base64,(.*)$/s);
  return match ? match[1]! : data;
}

function imageMediaType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const normalized = mimeType.toLowerCase().split(";")[0]!.trim();
  if (normalized === "image/jpg" || normalized === "image/jpeg") return "image/jpeg";
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/gif") return "image/gif";
  if (normalized === "image/webp") return "image/webp";
  return null;
}

/** Builds the streaming-input user message, attaching inline images as Anthropic image blocks. */
export function buildClaudeUserMessage(input: {
  text: string;
  attachments?: AgentPromptAttachment[];
  sessionId?: string;
}): { message: SDKUserMessage; imageCount: number; skipped: string[] } {
  const skipped: string[] = [];
  const imageBlocks: Array<Record<string, unknown>> = [];
  for (const attachment of input.attachments ?? []) {
    if (!attachment.mimeType.startsWith("image/") || !attachment.data) {
      continue;
    }
    const mediaType = imageMediaType(attachment.mimeType);
    if (!mediaType) {
      skipped.push(attachment.name ?? attachment.mimeType);
      continue;
    }
    imageBlocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: stripDataUrlPrefix(attachment.data) },
    });
  }
  const text = input.text.trim().length > 0 ? input.text : imageBlocks.length > 0 ? "See the attached image(s)." : input.text;
  const content =
    imageBlocks.length > 0
      ? ([...imageBlocks, { type: "text", text }] as unknown as SDKUserMessage["message"]["content"])
      : text;
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  };
  return { message, imageCount: imageBlocks.length, skipped };
}

function createScope(): TranscriptScope {
  return {
    openMessageId: null,
    openApiMessageId: null,
    stopSeen: false,
    fullReceived: false,
    streamedAny: false,
    emittedChunk: false,
    text: new ClaudeStreamedTextReconciler(),
    thinking: new ClaudeStreamedTextReconciler(),
    ended: new Set(),
    counter: 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

function planSignature(entries: AgentPlanEntry[]): string {
  return entries.map((entry) => `${entry.id}|${entry.status}|${entry.content}`).join("\n");
}

function transcriptSeq(transcript: AgentStoredEvent[]): number {
  return transcript.length + 1;
}

export class ClaudeCodeSdkSessionHandle implements AgentSessionHandle {
  readonly capabilities = capabilities;
  configOptions: AgentConfigOption[];
  sessionId: string;

  private live: LiveQuery | null = null;
  private turn: ActiveTurn | null = null;
  private disposed = false;
  private restartRequired = false;
  private turnCounter = 0;
  private readonly timings: ClaudeCodeSdkTimings;
  private readonly queryFn: ClaudeCodeSdkQueryFn;
  private readonly sessionFileExists: (sessionId: string, cwd: string) => Promise<boolean>;
  private readonly contextProbeEnabled: boolean;
  private readonly pendingInteractions = new Map<string, PendingPermission | PendingQuestion>();
  private readonly activeToolPayloads = new Map<string, { name?: string; input?: unknown }>();
  private readonly subagents = new Map<string, SubagentState>();
  private readonly tasksByToolUse = new Map<string, string>();
  private readonly toolProgressAt = new Map<string, number>();
  private readonly planTracker = new ClaudeTaskPlanTracker();
  private lastPlanSignature = "";
  private lastReminderMode: string | null = null;
  private lastCommandsSignature = "";
  private lastContextUsage: ClaudeCodeSdkContextUsage | null = null;
  private lastAssistantUsage: ReturnType<typeof usageFromClaudeAssistantMessage> = null;
  private lastResultUsage: ClaudeUsageSummary | null = null;
  /** Session id recovered from Cesium's own memory when the manager cleared it (post-cancel). */
  private recoveredSessionId: string | null = null;

  private constructor(
    private readonly callbacks: AgentRuntimeCallbacks,
    private readonly backend: AgentBackendInfo,
    configOptions: AgentConfigOption[],
    providerSessionId: string | null | undefined,
    deps: ClaudeCodeSdkProviderDeps
  ) {
    this.sessionId = providerSessionId || `claude-code-sdk-pending-${callbacks.conversation.id}`;
    this.configOptions = configOptions;
    this.queryFn = deps.query ?? sdkQuery;
    this.sessionFileExists = deps.sessionFileExists ?? claudeSessionFileExistsForCwd;
    this.timings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) };
    this.contextProbeEnabled =
      deps.contextProbe ??
      (process.env.OPENCURSOR_CLAUDE_CODE_SDK_CONTEXT_PROBE === "1" ||
        (!isThirdPartyClaudeCodeSdkProxy() &&
          process.env.OPENCURSOR_CLAUDE_CODE_SDK_CONTEXT_PROBE !== "0"));
  }

  static async create(input: ClaudeCodeSdkHandleInput): Promise<ClaudeCodeSdkSessionHandle> {
    if (!hasClaudeCodeSdkUsableAuth()) {
      throw new Error(
        "Claude Code is not configured. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, a proxy in Settings -> Agents, a supported provider env var, or log in with the claude CLI."
      );
    }
    const configOptions = withCurrentConfig(input.configOptions, input.callbacks.conversation);
    const handle = new ClaudeCodeSdkSessionHandle(
      input.callbacks,
      input.backend,
      configOptions,
      input.providerSessionId,
      input.deps
    );
    const workspaceRoot = input.callbacks.workspace.root;
    if (input.providerSessionId) {
      // The manager only calls loadSession for ids it believes are resumable.
      // Throwing here routes it to its transcript-recovery fallback instead of
      // letting the CLI fail later with "No conversation found".
      const exists = await handle.sessionFileExists(input.providerSessionId, workspaceRoot);
      if (!exists) {
        throw new Error(
          `Claude Code session ${input.providerSessionId} has no transcript under this workspace and cannot be resumed.`
        );
      }
    } else {
      const remembered = await readClaudeCodeSdkConversationState(
        input.callbacks.workspace.id,
        input.callbacks.conversation.id
      ).catch(() => null);
      if (
        remembered?.sessionId &&
        (!remembered.cwd || remembered.cwd === workspaceRoot) &&
        (await handle.sessionFileExists(remembered.sessionId, workspaceRoot))
      ) {
        handle.recoveredSessionId = remembered.sessionId;
        handle.sessionId = remembered.sessionId;
      }
    }
    await input.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId:
        input.providerSessionId ?? handle.recoveredSessionId ?? current.providerSessionId,
      configOptions,
      capabilities,
      // The manager marks the record `running` before it creates the runtime
      // for a prompt; downgrading that to idle here would arm the idle-dispose
      // timer and kill the process a few seconds into the turn. Only stale
      // terminal / waiting states from a previous runtime are reset.
      status: current.status === "running" ? "running" : "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: current.status === "running" ? current.lastError : null,
    }));
    return handle;
  }

  // ---------------------------------------------------------------------------
  // Prompt / turn lifecycle
  // ---------------------------------------------------------------------------

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: AgentPromptAttachment[];
    isRetry?: boolean;
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
    clientTimezone?: string;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Claude Code session has been disposed.");
    }
    if (this.turn) {
      throw new Error("A Claude Code turn is already in progress for this conversation.");
    }
    const turn = this.createTurn(input.userMessageId);
    this.turn = turn;
    try {
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "running",
        pendingPermission: null,
        pendingQuestion: null,
        lastError: null,
      }));
      const pluginAttachments = await resolveAgentPluginAttachments({
        workspaceId: this.callbacks.workspace.id,
        workspaceRoot: this.callbacks.workspace.root,
        backendId: "claude-code-sdk",
      });
      const live = await this.ensureLiveQuery(pluginAttachments);
      const reminders = await this.buildTurnReminders(input);
      if (reminders.length > 0) {
        await this.callbacks.appendEvents(
          reminders.map((reminder) => ({
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system_reminder" as const,
            reminderId: `claude-code-sdk-${reminder.reason === "plan_handoff" ? "plan-handoff" : "mode"}-${input.userMessageId}`,
            targetMessageId: input.userMessageId,
            reason: reminder.reason,
            text: reminder.text,
          }))
        );
      }
      // Only the plan handoff travels in the user turn (appended after the
      // user's words); mode guidance is already in the system prompt.
      const handoff = reminders.find((reminder) => reminder.reason === "plan_handoff");
      const promptText = appendAgentPluginPrompt(
        handoff ? `${input.text}\n\n<system-reminder>\n${handoff.text}\n</system-reminder>` : input.text,
        pluginAttachments
      );
      const built = buildClaudeUserMessage({
        text: promptText,
        attachments: input.attachments,
        sessionId: this.sessionId.startsWith("claude-code-sdk-pending-") ? undefined : this.sessionId,
      });
      if (built.skipped.length > 0) {
        await this.appendSystem(
          "warning",
          `Skipped ${built.skipped.length} attachment(s) with unsupported image type: ${built.skipped.join(", ")}.`
        );
      }
      turn.live = live;
      if (!live.input.push(built.message)) {
        throw new Error("Claude Code process input is closed; the session must be restarted.");
      }
      const outcome = await turn.done;
      await this.finalizeTurn(turn, outcome);
      if (outcome.kind === "failed") {
        throw outcome.error;
      }
    } catch (error) {
      if (!turn.settled) {
        turn.settle({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)), result: null });
        await this.finalizeTurn(turn, await turn.done);
      }
      if (this.turn === turn) {
        this.turn = null;
      }
      turn.markFinalized();
      throw error;
    }
    if (this.turn === turn) {
      this.turn = null;
    }
    turn.markFinalized();
  }

  private createTurn(userMessageId: string): ActiveTurn {
    this.turnCounter += 1;
    let settle!: (outcome: TurnOutcome) => void;
    let markFinalized!: () => void;
    const done = new Promise<TurnOutcome>((resolve) => {
      settle = resolve;
    });
    const finalized = new Promise<void>((resolve) => {
      markFinalized = resolve;
    });
    const turn: ActiveTurn = {
      id: `${this.callbacks.conversation.id}-${this.turnCounter}`,
      userMessageId,
      startedAt: Date.now(),
      cancelRequested: false,
      emittedAssistantText: false,
      lastApiError: null,
      lastAssistantError: null,
      lastSystemText: null,
      settled: false,
      settle: (outcome) => {
        if (turn.settled) {
          return;
        }
        turn.settled = true;
        settle(outcome);
      },
      done,
      finalized,
      markFinalized,
      scope: createScope(),
      live: null,
    };
    return turn;
  }

  private async buildTurnReminders(input: {
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
    isRetry?: boolean;
  }): Promise<Array<{ reason: "mode" | "plan_handoff"; text: string }>> {
    const reminders: Array<{ reason: "mode" | "plan_handoff"; text: string }> = [];
    const mode = modeForConfig(this.callbacks.conversation, this.configOptions);
    if (mode !== this.lastReminderMode) {
      const reminder = MODE_REMINDERS[mode];
      if (reminder) {
        reminders.push({ reason: "mode", text: reminder });
      }
      this.lastReminderMode = mode;
    }
    if (input.planHandoff) {
      const planPath = input.planHandoff.planPath;
      let planBody = "";
      try {
        const absolute = path.isAbsolute(planPath)
          ? planPath
          : path.join(this.callbacks.workspace.root, planPath);
        planBody = (await fs.readFile(absolute, "utf8")).trim();
      } catch {
        planBody = "";
      }
      reminders.push({
        reason: "plan_handoff",
        text: [
          `Implement the approved plan${input.planHandoff.planTitle ? ` "${input.planHandoff.planTitle}"` : ""} stored at ${planPath} end to end.`,
          "Work through every step, verify the result, and report what changed.",
          planBody
            ? `Plan contents:\n${planBody.length > 12_000 ? `${planBody.slice(0, 12_000)}\n…(truncated; read the file for the rest)` : planBody}`
            : "Read the plan file first.",
        ].join("\n"),
      });
    }
    return reminders;
  }

  private async finalizeTurn(turn: ActiveTurn, outcome: TurnOutcome): Promise<void> {
    await this.closeOpenMessage(turn.scope, null);
    const resultUsage = outcome.result ? usageFromClaudeResult(outcome.result) : null;
    if (resultUsage) {
      this.lastResultUsage = resultUsage;
    }
    await this.persistContextUsage();
    const providerSessionId = this.sessionId.startsWith("claude-code-sdk-pending-")
      ? null
      : this.sessionId;
    if (outcome.kind === "success") {
      const detail = resultUsage ? formatClaudeUsageDetail(resultUsage) : "";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: detail ? `Claude Code turn complete · ${detail}` : "Claude Code turn complete.",
          raw: outcome.result ?? undefined,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        pendingQuestion: null,
        lastError: null,
        ...(providerSessionId ? { providerSessionId } : {}),
      }));
      this.scheduleContextProbe();
      return;
    }
    if (outcome.kind === "cancelled") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: "Claude Code turn cancelled.",
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "cancelled",
          detail: "Cancelled by the client.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "cancelled",
        pendingPermission: null,
        pendingQuestion: null,
        lastError: null,
        ...(providerSessionId ? { providerSessionId } : {}),
      }));
      return;
    }
    const message = outcome.error.message || "Claude Code turn failed.";
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "error",
        text: message,
        raw: outcome.result ?? undefined,
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
      pendingPermission: null,
      pendingQuestion: null,
      lastError: message,
      ...(providerSessionId ? { providerSessionId } : {}),
    }));
  }

  // ---------------------------------------------------------------------------
  // Query (process) lifecycle
  // ---------------------------------------------------------------------------

  private optionsFingerprint(options: Options): string {
    return JSON.stringify({
      tools: options.tools,
      allowedTools: options.allowedTools,
      effort: options.effort,
      thinking: options.thinking,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      mcp: Object.keys(options.mcpServers ?? {}).sort(),
      settingSources: options.settingSources,
      persistSession: options.persistSession,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd,
    });
  }

  private async ensureLiveQuery(
    pluginAttachments: Awaited<ReturnType<typeof resolveAgentPluginAttachments>>
  ): Promise<LiveQuery> {
    const options = await this.buildQueryOptions(pluginAttachments);
    const fingerprint = this.optionsFingerprint(options);
    if (this.live && !this.live.closed) {
      if (!this.restartRequired && this.live.fingerprint === fingerprint) {
        return this.live;
      }
      await this.shutdownLiveQuery("configuration changed");
    }
    this.restartRequired = false;
    const abortController = new AbortController();
    const input = new PushableInput();
    const resumeId = this.sessionId.startsWith("claude-code-sdk-pending-") ? null : this.sessionId;
    const canResume = resumeId
      ? await this.sessionFileExists(resumeId, this.callbacks.workspace.root)
      : false;
    if (resumeId && !canResume) {
      await this.appendSystem(
        "warning",
        "The previous Claude Code transcript is no longer available; starting a fresh Claude session for this conversation."
      );
      this.sessionId = `claude-code-sdk-pending-${this.callbacks.conversation.id}`;
    }
    const spawnOptions: Options = {
      ...options,
      abortController,
      ...(canResume && resumeId ? { resume: resumeId } : {}),
    };
    const query = this.queryFn({ prompt: input, options: spawnOptions });
    const live: LiveQuery = {
      query,
      input,
      abortController,
      fingerprint,
      pump: Promise.resolve(),
      initialized: false,
      initTools: [],
      resumed: Boolean(canResume && resumeId),
      error: null,
      closed: false,
    };
    live.pump = this.runPump(live);
    this.live = live;
    if (this.recoveredSessionId && live.resumed) {
      await this.appendSystem(
        "info",
        "Resumed the previous Claude Code session for this conversation."
      );
      this.recoveredSessionId = null;
    }
    return live;
  }

  private async buildQueryOptions(
    pluginAttachments: Awaited<ReturnType<typeof resolveAgentPluginAttachments>>
  ): Promise<Options> {
    const permissionMode = permissionModeForConfig(this.callbacks.conversation, this.configOptions);
    const proxyMode = hasClaudeCodeSdkProxyConfig();
    const model = selectedModel(this.callbacks.conversation, this.configOptions);
    const mcpExport = pluginAttachments.sdkMcp;
    if (mcpExport.skipped.length > 0) {
      await this.appendSystem(
        "warning",
        `Claude Code skipped ${mcpExport.skipped.length} MCP server(s): ${mcpExport.skipped
          .map((server) => `${server.label}: ${server.reason}`)
          .join("; ")}`
      );
    }
    const profile = toolProfileForConfig(this.callbacks.conversation, this.configOptions);
    const persistSession =
      optionValue(this.configOptions, "session_persistence", "enabled") !== "disabled";
    return {
      cwd: this.callbacks.workspace.root,
      env: claudeCodeSdkEnv(model),
      pathToClaudeCodeExecutable: getClaudeCodeSdkPathToExecutable(),
      includePartialMessages: true,
      forwardSubagentText: true,
      persistSession,
      model,
      permissionMode,
      allowDangerouslySkipPermissions:
        permissionMode === "bypassPermissions" &&
        process.env.OPENCURSOR_CLAUDE_CODE_SDK_ALLOW_BYPASS === "1",
      tools: profile.tools,
      ...(profile.allowedTools ? { allowedTools: profile.allowedTools } : {}),
      ...(Object.keys(mcpExport.servers).length > 0 ? { mcpServers: mcpExport.servers } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // Mode guidance lives in the system prompt (a restart-level option)
        // rather than the user turn so Claude's derived session title and
        // plan-file slug come from the user's own words.
        append: [CESIUM_SYSTEM_APPEND, MODE_REMINDERS[modeForConfig(this.callbacks.conversation, this.configOptions)]]
          .filter(Boolean)
          .join("\n\n"),
      },
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      effort: effortForConfig(this.configOptions),
      thinking: thinkingForConfig(this.configOptions),
      maxTurns: maxTurnsForConfig(this.configOptions),
      maxBudgetUsd: maxBudgetForConfig(this.configOptions),
      settingSources: settingSourcesForConfig(this.configOptions),
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      stderr: (data: string) => {
        const line = data.trim();
        if (!line) {
          return;
        }
        harnessLog({
          level: "info",
          conversationId: this.callbacks.conversation.id,
          backendId: this.backend.id,
          event: "claude-code-sdk.stderr",
          detail: line.slice(0, 2_000),
        });
      },
    };
  }

  private async runPump(live: LiveQuery): Promise<void> {
    try {
      for await (const message of live.query) {
        if (this.disposed) {
          break;
        }
        try {
          await this.handleSdkMessage(message, live);
        } catch (error) {
          harnessLog({
            level: "error",
            conversationId: this.callbacks.conversation.id,
            backendId: this.backend.id,
            event: "claude-code-sdk.message_handler_failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      live.error = error;
    } finally {
      live.closed = true;
      if (this.live === live) {
        this.live = null;
      }
      const turn = this.turn;
      if (turn && !turn.settled && turn.live === live) {
        const error = live.error;
        const cancelled =
          turn.cancelRequested ||
          live.abortController.signal.aborted ||
          (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));
        if (cancelled) {
          turn.settle({ kind: "cancelled", result: null });
        } else {
          const detail = error instanceof Error ? error.message : error ? String(error) : "";
          turn.settle({
            kind: "failed",
            error: new Error(
              detail
                ? `Claude Code exited before the turn completed: ${detail}`
                : turn.lastApiError ??
                  turn.lastAssistantError ??
                  "Claude Code exited before the turn completed. Check the model route, API key, and base URL."
            ),
            result: null,
          });
        }
      }
      this.rejectPendingInteractions("Claude Code session ended before the request was answered.");
    }
  }

  private async shutdownLiveQuery(reason: string): Promise<void> {
    const live = this.live;
    if (!live) {
      return;
    }
    this.live = null;
    live.input.end();
    const exited = await withTimeout(live.pump, this.timings.closeGraceMs);
    if (exited === undefined && !live.closed) {
      live.query.close();
      await withTimeout(live.pump, this.timings.closeGraceMs);
    }
    harnessLog({
      level: "info",
      conversationId: this.callbacks.conversation.id,
      backendId: this.backend.id,
      event: "claude-code-sdk.restart",
      detail: `Claude Code process restarted: ${reason}.`,
    });
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleSdkMessage(message: unknown, live: LiveQuery): Promise<void> {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (sessionId && sessionId !== this.sessionId && record.type !== "user") {
      await this.adoptSessionId(sessionId);
    }
    const type = record.type;
    if (type === "system") {
      await this.handleSystemMessage(record, live);
      return;
    }
    if (type === "stream_event") {
      await this.handleStreamEvent(record);
      return;
    }
    if (type === "assistant") {
      await this.handleAssistantMessage(record);
      return;
    }
    if (type === "user") {
      await this.handleUserMessage(record);
      return;
    }
    if (type === "result") {
      await this.handleResultMessage(record);
      return;
    }
    if (type === "tool_progress") {
      await this.handleToolProgress(record);
      return;
    }
    if (type === "tool_use_summary") {
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (summary) {
        await this.appendSystem("info", summary, message);
      }
      return;
    }
    if (type === "rate_limit_event") {
      const info = record.rate_limit_info as Record<string, unknown> | undefined;
      if (info && info.status !== "allowed") {
        const description = describeClaudeSystemEvent({ ...record, subtype: "rate_limit_event" });
        await this.appendSystem(description.level, description.text, message);
      }
      return;
    }
    if (type === "auth_status") {
      const description = describeClaudeSystemEvent({ ...record, subtype: "auth_status" });
      if (description.visible) {
        await this.appendSystem(description.level, description.text, message);
      }
      return;
    }
    if (type === "conversation_reset") {
      const nextId = typeof record.new_conversation_id === "string" ? record.new_conversation_id : null;
      if (nextId) {
        await this.adoptSessionId(nextId);
      }
      await this.appendSystem("info", "Claude Code conversation history was cleared.", message);
      return;
    }
    if (type === "prompt_suggestion" || type === "active_goal" || type === "keep_alive") {
      return;
    }
    harnessLog({
      level: "warning",
      conversationId: this.callbacks.conversation.id,
      backendId: this.backend.id,
      event: "claude-code-sdk.unhandled_message",
      detail: typeof type === "string" ? type : "unknown",
    });
  }

  private async adoptSessionId(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: sessionId,
    }));
    await writeClaudeCodeSdkConversationState(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id,
      { sessionId, cwd: this.callbacks.workspace.root }
    ).catch(() => undefined);
  }

  private async handleSystemMessage(record: Record<string, unknown>, live: LiveQuery): Promise<void> {
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    if (subtype === "init") {
      await this.handleInit(record, live);
      return;
    }
    if (subtype === "api_retry") {
      const status = typeof record.error_status === "number" ? record.error_status : null;
      const error = typeof record.error === "string" ? record.error : "unknown";
      const attempt = typeof record.attempt === "number" ? record.attempt : null;
      const maxRetries = typeof record.max_retries === "number" ? record.max_retries : null;
      const delay = typeof record.retry_delay_ms === "number" ? record.retry_delay_ms : null;
      const described = describeClaudeAssistantError(error);
      const message = status ? `Claude API error ${status}: ${described}` : `Claude API request failed: ${described}`;
      if (this.turn) {
        this.turn.lastApiError = message;
      }
      await this.appendSystem(
        "warning",
        `${message}${attempt != null ? ` Retry ${attempt}${maxRetries ? `/${maxRetries}` : ""}` : ""}${
          delay != null ? ` in ${(delay / 1000).toFixed(1)}s` : ""
        }.`,
        record
      );
      return;
    }
    if (subtype === "status") {
      if (record.status === "compacting") {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: "Compacting context…",
            raw: record,
          },
        ]);
      } else if (record.compact_result === "failed") {
        await this.appendSystem(
          "warning",
          `Context compaction failed${typeof record.compact_error === "string" ? `: ${record.compact_error}` : "."}`,
          record
        );
      }
      if (typeof record.permissionMode === "string") {
        await this.syncPermissionModeFromCli(record.permissionMode);
      }
      return;
    }
    if (subtype === "commands_changed") {
      await this.publishSlashCommands(claudeSlashCommandsFromSdk(record.commands));
      return;
    }
    if (subtype === "compact_boundary") {
      const meta = (record.compact_metadata as Record<string, unknown> | undefined) ?? {};
      const description = describeClaudeSystemEvent(record);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "compression_summary",
          messageId: `claude-code-sdk-compact-${typeof record.uuid === "string" ? record.uuid : randomUUID()}`,
          summary: description.text,
          retainedTurnCount: 0,
          compressedTurnCount: 0,
          ...(typeof meta.pre_tokens === "number" ? { estimatedTokensBefore: meta.pre_tokens } : {}),
          ...(typeof meta.post_tokens === "number" ? { estimatedTokensAfter: meta.post_tokens } : {}),
          raw: record,
        },
      ]);
      return;
    }
    const task = parseClaudeTaskEvent(record);
    if (task) {
      await this.handleTaskEvent(task, record);
      return;
    }
    if (subtype === "permission_denied") {
      const description = describeClaudeSystemEvent(record);
      await this.appendSystem(description.level, description.text, record);
      const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : null;
      if (toolUseId) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: toolUseId,
            status: "failed",
            detail: typeof record.message === "string" ? record.message : "Denied by permission policy.",
            raw: record,
          },
        ]);
      }
      return;
    }
    const description = describeClaudeSystemEvent(record);
    if (description.visible && description.text) {
      await this.appendSystem(description.level, description.text, record);
    }
  }

  private async handleInit(record: Record<string, unknown>, live: LiveQuery): Promise<void> {
    const tools = Array.isArray(record.tools)
      ? (record.tools as unknown[]).filter((tool): tool is string => typeof tool === "string")
      : [];
    live.initTools = tools;
    const commands = claudeSlashCommandsFromSdk(record.slash_commands);
    if (!live.initialized) {
      live.initialized = true;
      const model = typeof record.model === "string" ? record.model : "Claude";
      const permissionMode = typeof record.permissionMode === "string" ? record.permissionMode : "default";
      const version = typeof record.claude_code_version === "string" ? record.claude_code_version : null;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: [
            model,
            permissionMode,
            `${tools.length} tools`,
            version ? `Claude Code ${version}` : null,
            live.resumed ? "resumed" : null,
          ]
            .filter(Boolean)
            .join(" · "),
          raw: record,
        },
      ]);
      await this.warnAboutMissingTools(tools);
      const mcpServers = Array.isArray(record.mcp_servers) ? (record.mcp_servers as unknown[]) : [];
      const failedServers = mcpServers
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
        .filter(
          (entry): entry is Record<string, unknown> =>
            entry != null && typeof entry.status === "string" && !["connected", "pending"].includes(entry.status)
        );
      if (failedServers.length > 0) {
        await this.appendSystem(
          "warning",
          `MCP server(s) not connected: ${failedServers
            .map((entry) => `${String(entry.name)} (${String(entry.status)})`)
            .join(", ")}.`,
          record
        );
      }
      void this.refreshSlashCommands(live, commands);
    } else if (commands.length > 0) {
      await this.publishSlashCommands(commands);
    }
  }

  private async warnAboutMissingTools(initTools: string[]): Promise<void> {
    const profile = toolProfileForConfig(this.callbacks.conversation, this.configOptions);
    if (!Array.isArray(profile.tools)) {
      return;
    }
    const available = new Set(initTools);
    const missing = profile.tools.filter(
      (tool) => !available.has(tool) && !OPTIONAL_TOOL_NAMES.has(tool)
    );
    // `Agent` is listed as `Task` by the CLI; treat either as satisfying both.
    const subagentMissing =
      profile.tools.some((tool) => isClaudeSubagentToolName(tool)) &&
      !available.has("Task") &&
      !available.has("Agent");
    if (missing.length === 0 && !subagentMissing) {
      return;
    }
    const names = [...missing, ...(subagentMissing ? ["Agent"] : [])];
    await this.appendSystem(
      "warning",
      `This Claude Code build does not expose ${names.join(", ")}; those tool(s) are unavailable for this session.`
    );
  }

  private async refreshSlashCommands(
    live: LiveQuery,
    fallback: Array<{ name: string; description?: string; inputHint?: string }>
  ): Promise<void> {
    const detailed = await withTimeout(
      live.query.supportedCommands().catch(() => null),
      this.timings.controlRequestTimeoutMs
    );
    const commands = detailed ? claudeSlashCommandsFromSdk(detailed) : fallback;
    await this.publishSlashCommands(commands.length > 0 ? commands : fallback);
  }

  private async publishSlashCommands(
    commands: Array<{ name: string; description?: string; inputHint?: string }>
  ): Promise<void> {
    const normalized: AgentSlashCommand[] = commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.inputHint ? { inputHint: command.inputHint } : {}),
    }));
    const signature = JSON.stringify(normalized);
    if (signature === this.lastCommandsSignature) {
      return;
    }
    this.lastCommandsSignature = signature;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      availableCommands: normalized,
    }));
  }

  private async syncPermissionModeFromCli(permissionMode: string): Promise<void> {
    // ExitPlanMode approval flips the CLI back to a non-plan mode; mirror that
    // into Cesium's conversation mode so the composer stops showing "Plan".
    const mode = modeForConfig(this.callbacks.conversation, this.configOptions);
    if (mode === "plan" && permissionMode !== "plan") {
      await this.applyModeChange("agent");
    }
  }

  private async applyModeChange(mode: string): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(this.configOptions);
    const modeId = modeOption?.id ?? "mode";
    this.configOptions = this.configOptions.map((option) =>
      option.id === modeId ? { ...option, currentValue: mode } : option
    );
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
      config: { ...current.config, mode },
    }));
    this.lastReminderMode = mode;
  }

  private async handleStreamEvent(record: Record<string, unknown>): Promise<void> {
    const parentToolUseId = parentToolUseIdFromClaudeMessage(record);
    const delta = classifyClaudeStreamEvent(record);
    const scope = parentToolUseId
      ? (await this.ensureSubagent(parentToolUseId, null)).scope
      : this.turn?.scope;
    if (!scope) {
      return;
    }
    const subagent = parentToolUseId ? this.subagents.get(parentToolUseId) ?? null : null;
    if (delta.kind === "message_start") {
      await this.openMessage(scope, delta.apiMessageId, subagent);
      return;
    }
    if (delta.kind === "text" && delta.text) {
      if (!scope.openMessageId) {
        await this.openMessage(scope, null, subagent);
      }
      scope.streamedAny = true;
      scope.text.append(delta.text);
      await this.emitAssistantChunk(scope, delta.text, subagent, record);
      return;
    }
    if (delta.kind === "thinking" && delta.text) {
      if (!scope.openMessageId) {
        await this.openMessage(scope, null, subagent);
      }
      scope.streamedAny = true;
      scope.thinking.append(delta.text);
      await this.emitReasoning(scope, delta.text, subagent, record);
      return;
    }
    if (delta.kind === "message_stop") {
      if (scope.fullReceived) {
        await this.closeOpenMessage(scope, subagent);
      } else {
        scope.stopSeen = true;
      }
    }
  }

  private nextMessageId(scope: TranscriptScope, apiMessageId: string | null, subagent: SubagentState | null): string {
    const base = subagent
      ? `claude-code-sdk-${subagent.subagentId}`
      : `claude-code-sdk-${this.turn?.id ?? this.callbacks.conversation.id}`;
    if (apiMessageId) {
      return `${base}-${apiMessageId}`;
    }
    scope.counter += 1;
    return `${base}-m${scope.counter}`;
  }

  private async openMessage(
    scope: TranscriptScope,
    apiMessageId: string | null,
    subagent: SubagentState | null
  ): Promise<void> {
    if (scope.openMessageId && apiMessageId && scope.openApiMessageId === apiMessageId) {
      return;
    }
    if (scope.openMessageId) {
      await this.closeOpenMessage(scope, subagent);
    }
    scope.openMessageId = this.nextMessageId(scope, apiMessageId, subagent);
    scope.openApiMessageId = apiMessageId;
    scope.stopSeen = false;
    scope.fullReceived = false;
    scope.streamedAny = false;
    scope.emittedChunk = false;
    scope.text.reset();
    scope.thinking.reset();
  }

  private async closeOpenMessage(scope: TranscriptScope, subagent: SubagentState | null): Promise<void> {
    const messageId = scope.openMessageId;
    if (!messageId) {
      return;
    }
    const emittedChunk = scope.emittedChunk;
    scope.openMessageId = null;
    scope.openApiMessageId = null;
    scope.stopSeen = false;
    scope.fullReceived = false;
    scope.streamedAny = false;
    scope.emittedChunk = false;
    scope.text.reset();
    scope.thinking.reset();
    if (scope.ended.has(messageId)) {
      return;
    }
    scope.ended.add(messageId);
    if (!emittedChunk) {
      return;
    }
    if (subagent) {
      subagent.transcript.push({
        seq: transcriptSeq(subagent.transcript),
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "assistant_message_end",
        messageId,
        stopReason: "complete",
      });
      subagent.broadcaster.notify();
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId,
        stopReason: "complete",
      },
    ]);
  }

  private async emitAssistantChunk(
    scope: TranscriptScope,
    text: string,
    subagent: SubagentState | null,
    raw?: unknown
  ): Promise<void> {
    const messageId = scope.openMessageId;
    if (!messageId || !text) {
      return;
    }
    scope.emittedChunk = true;
    if (subagent) {
      const last = subagent.transcript[subagent.transcript.length - 1];
      if (last?.kind === "assistant_message_chunk" && last.messageId === messageId) {
        subagent.transcript[subagent.transcript.length - 1] = { ...last, text: last.text + text };
      } else {
        subagent.transcript.push({
          seq: transcriptSeq(subagent.transcript),
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          createdAt: Date.now(),
          kind: "assistant_message_chunk",
          messageId,
          text,
        });
      }
      subagent.lastActivity = text.trim().slice(0, 240) || subagent.lastActivity;
      subagent.broadcaster.notify();
      return;
    }
    if (this.turn) {
      this.turn.emittedAssistantText = true;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_chunk",
        messageId,
        text,
        ...(raw !== undefined ? { raw } : {}),
      },
    ]);
  }

  private async emitReasoning(
    scope: TranscriptScope,
    text: string,
    subagent: SubagentState | null,
    raw?: unknown
  ): Promise<void> {
    const messageId = scope.openMessageId;
    if (!messageId || !text) {
      return;
    }
    if (subagent) {
      subagent.transcript.push({
        seq: transcriptSeq(subagent.transcript),
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        createdAt: Date.now(),
        kind: "reasoning",
        messageId: `${messageId}-thinking`,
        text,
      });
      subagent.broadcaster.notify();
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "reasoning",
        messageId: `${messageId}-thinking`,
        text,
        ...(raw !== undefined ? { raw } : {}),
      },
    ]);
  }

  private async handleAssistantMessage(record: Record<string, unknown>): Promise<void> {
    const parentToolUseId = parentToolUseIdFromClaudeMessage(record);
    const subagent = parentToolUseId ? await this.ensureSubagent(parentToolUseId, null) : null;
    const scope = subagent ? subagent.scope : this.turn?.scope;
    if (!scope) {
      return;
    }
    const apiMessageId = apiMessageIdFromClaudeMessage(record);
    const errorCode = typeof record.error === "string" ? record.error : null;
    const usage = usageFromClaudeAssistantMessage(record);
    if (usage && !subagent) {
      this.lastAssistantUsage = usage;
    }
    if (!subagent && !errorCode && isSyntheticClaudeAssistantMessage(record)) {
      // Echo of a local slash command (`/clear` -> "(no content)", `/compact`
      // -> "Not enough messages to compact."): CLI output, never a reply.
      const text = textFromClaudeAssistantMessage(record).trim();
      if (text && !isClaudePlaceholderText(text)) {
        await this.appendSystemOnce("info", text, record);
      }
      return;
    }
    if (apiMessageId ? scope.openApiMessageId !== apiMessageId : !scope.openMessageId) {
      await this.openMessage(scope, apiMessageId, subagent);
    }
    const streamedForMessage = scope.streamedAny;
    const blocks = blocksFromClaudeAssistantMessage(record);
    const events: AgentEventInput[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (errorCode && /^API Error/i.test(block.text.trim()) && !subagent) {
          const described = describeClaudeAssistantError(errorCode, block.text);
          if (this.turn) {
            this.turn.lastAssistantError = described;
          }
          continue;
        }
        const remainder = scope.text.reconcile(block.text);
        if (remainder) {
          await this.flushEvents(events);
          await this.emitAssistantChunk(scope, remainder, subagent, undefined);
        }
        continue;
      }
      if (block.type === "thinking") {
        const remainder = scope.thinking.reconcile(block.thinking);
        if (remainder) {
          await this.flushEvents(events);
          await this.emitReasoning(scope, remainder, subagent, undefined);
        }
        continue;
      }
      if (block.type === "tool_use") {
        await this.flushEvents(events);
        // Anthropic messages put text before tool_use blocks and never after,
        // so the text message is complete once a tool call starts.
        await this.closeOpenMessage(scope, subagent);
        await this.handleToolUse(block.tool, subagent);
      }
    }
    await this.flushEvents(events);
    if (errorCode && !subagent && this.turn) {
      this.turn.lastAssistantError =
        this.turn.lastAssistantError ?? describeClaudeAssistantError(errorCode);
      await this.appendSystem("warning", this.turn.lastAssistantError, record);
    }
    // A message that was never streamed arrived complete; one that was
    // streamed is complete once its message_stop landed.
    scope.fullReceived = true;
    if (!streamedForMessage || scope.stopSeen) {
      await this.closeOpenMessage(scope, subagent);
    }
  }

  private async flushEvents(events: AgentEventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const batch = events.splice(0, events.length);
    await this.callbacks.appendEvents(batch);
  }

  private async handleToolUse(
    tool: { id?: string; name?: string; input?: unknown },
    subagent: SubagentState | null
  ): Promise<void> {
    if (!tool.id) {
      return;
    }
    const payloads = subagent ? subagent.toolPayloads : this.activeToolPayloads;
    payloads.set(tool.id, { name: tool.name, input: tool.input });
    if (!subagent && isClaudeSubagentToolName(tool.name)) {
      await this.startSubagentFromToolUse(tool.id, tool.input);
      return;
    }
    const event = claudeToolUseToAgentEvent({
      tool,
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
      status: "in_progress",
    });
    if (subagent) {
      subagent.transcript.push({ ...event, seq: transcriptSeq(subagent.transcript), createdAt: Date.now() } as AgentStoredEvent);
      subagent.lastActivity = `Running ${event.kind === "tool_call" ? event.title : tool.name ?? "tool"}`;
      subagent.broadcaster.notify();
      return;
    }
    const events: AgentEventInput[] = [event];
    if (isClaudeTaskListToolName(tool.name) && this.planTracker.noteToolUse(tool)) {
      events.push(...(await this.planEvents(tool)));
    }
    await this.callbacks.appendEvents(events);
  }

  private async planEvents(raw: unknown): Promise<AgentEventInput[]> {
    const entries = this.planTracker.entries();
    const signature = planSignature(entries);
    if (entries.length === 0 || signature === this.lastPlanSignature) {
      return [];
    }
    this.lastPlanSignature = signature;
    try {
      const artifact = await writeProviderPlanArtifact({
        workspaceRoot: this.callbacks.workspace.root,
        backendId: "claude-code-sdk",
        title: "Claude tasks",
        entries,
      });
      return providerPlanEvents({
        conversationId: this.callbacks.conversation.id,
        planId: `${this.callbacks.conversation.id}-claude-code-sdk-todos`,
        artifact: { ...artifact, entries },
        raw,
      });
    } catch {
      return [
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "plan",
          planId: `${this.callbacks.conversation.id}-claude-code-sdk-todos`,
          entries,
          raw,
        },
      ];
    }
  }

  private async handleUserMessage(record: Record<string, unknown>): Promise<void> {
    if (record.isReplay === true) {
      return;
    }
    const parentToolUseId = parentToolUseIdFromClaudeMessage(record);
    const results = toolResultFromClaudeUserMessage(record);
    if (results.length === 0) {
      if (record.isSynthetic === true) {
        return;
      }
      const origin = record.origin as Record<string, unknown> | undefined;
      const text = textFromClaudeUserMessage(record).trim();
      if (!text || origin?.kind === "task-notification" || origin?.kind === "auto-continuation") {
        return;
      }
      if (origin && typeof origin.kind === "string") {
        await this.appendSystem(
          "info",
          `Message from ${origin.kind}${typeof origin.from === "string" ? ` ${origin.from}` : ""}: ${text.slice(0, 600)}`,
          record
        );
      }
      return;
    }
    const subagent = parentToolUseId ? await this.ensureSubagent(parentToolUseId, null) : null;
    const events: AgentEventInput[] = [];
    for (const result of results) {
      if (!result.id) {
        continue;
      }
      const payloads = subagent ? subagent.toolPayloads : this.activeToolPayloads;
      const active = payloads.get(result.id);
      const normalized = {
        ...result,
        name: result.name ?? active?.name,
        input: result.input ?? active?.input,
      };
      payloads.delete(result.id);
      if (!subagent) {
        const owner = this.subagents.get(result.id);
        if (owner) {
          await this.settleSubagentFromToolResult(owner, normalized);
          continue;
        }
      }
      const event = claudeToolUseToAgentEvent({
        tool: normalized,
        conversationId: this.callbacks.conversation.id,
        eventId: randomUUID(),
        status: result.isError ? "failed" : "completed",
      });
      if (subagent) {
        this.settleSubagentToolRow(subagent, event);
        continue;
      }
      events.push(event);
      if (isClaudeTaskListToolName(normalized.name) && this.planTracker.noteToolResult(normalized)) {
        events.push(...(await this.planEvents(normalized)));
      }
      if (normalized.name === "ExitPlanMode" && !result.isError) {
        events.push(...(await this.mirrorExitPlan(normalized.structuredResult ?? normalized.result)));
      }
    }
    if (events.length > 0) {
      await this.callbacks.appendEvents(events);
    }
  }

  private async mirrorExitPlan(result: unknown): Promise<AgentEventInput[]> {
    const record = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
    let plan = typeof record?.plan === "string" ? record.plan.trim() : "";
    const filePath = typeof record?.filePath === "string" ? record.filePath : null;
    if (!plan && filePath) {
      plan = await fs.readFile(filePath, "utf8").then((text) => text.trim()).catch(() => "");
    }
    if (!plan) {
      return [];
    }
    try {
      const title = plan.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Claude plan";
      const artifact = await writeProviderPlanArtifact({
        workspaceRoot: this.callbacks.workspace.root,
        backendId: "claude-code-sdk",
        title,
        markdown: plan,
      });
      return providerPlanEvents({
        conversationId: this.callbacks.conversation.id,
        planId: `${this.callbacks.conversation.id}-claude-code-sdk-plan`,
        artifact,
        raw: result,
      });
    } catch (error) {
      harnessLog({
        level: "warning",
        conversationId: this.callbacks.conversation.id,
        backendId: this.backend.id,
        event: "claude-code-sdk.plan_mirror_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async handleResultMessage(record: Record<string, unknown>): Promise<void> {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    const success = subtype === "success" && record.is_error !== true;
    // A tools-only turn (e.g. plan approval) legitimately has no text; only
    // fall back to `result` when nothing was rendered and it carries content.
    // Local slash commands (/clear, /compact) never ran the model
    // (`num_turns: 0`): their result text is CLI output, shown as a note, and
    // "(no content)" placeholders are dropped.
    const resultText = typeof record.result === "string" ? record.result.trim() : "";
    const localCommand = record.num_turns === 0;
    if (success && !turn.emittedAssistantText && resultText && !isClaudePlaceholderText(resultText)) {
      if (localCommand) {
        await this.appendSystemOnce("info", resultText, record);
      } else {
        const scope = turn.scope;
        if (!scope.openMessageId) {
          await this.openMessage(scope, null, null);
        }
        await this.emitAssistantChunk(scope, resultText, null, record);
      }
    }
    if (turn.cancelRequested) {
      turn.settle({ kind: "cancelled", result: record });
      return;
    }
    if (success) {
      turn.settle({ kind: "success", result: record });
      return;
    }
    const detail =
      subtype === "success"
        ? turn.lastAssistantError ??
          turn.lastApiError ??
          (resultText ? describeClaudeAssistantError("unknown", resultText) : "Claude Code reported an error.")
        : describeClaudeResultFailure(record);
    turn.settle({ kind: "failed", error: new Error(detail), result: record });
  }

  private async handleToolProgress(record: Record<string, unknown>): Promise<void> {
    if (parentToolUseIdFromClaudeMessage(record)) {
      return;
    }
    const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : null;
    if (!toolUseId || this.subagents.has(toolUseId)) {
      return;
    }
    const now = Date.now();
    const last = this.toolProgressAt.get(toolUseId) ?? 0;
    if (now - last < this.timings.toolProgressIntervalMs) {
      return;
    }
    this.toolProgressAt.set(toolUseId, now);
    const elapsed = typeof record.elapsed_time_seconds === "number" ? record.elapsed_time_seconds : null;
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId: toolUseId,
        status: "in_progress",
        detail: elapsed != null ? `${elapsed.toFixed(0)}s elapsed` : undefined,
        raw: record,
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Subagents (Agent tool) and background tasks
  // ---------------------------------------------------------------------------

  private async startSubagentFromToolUse(toolUseId: string, input: unknown): Promise<void> {
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const subagentType = typeof record.subagent_type === "string" ? record.subagent_type : null;
    const model = typeof record.model === "string" ? record.model : null;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    const state = await this.ensureSubagent(toolUseId, {
      title: description || "Subagent task",
      meta: [subagentType, model].filter(Boolean).join(" · ") || undefined,
      prompt,
      background: record.run_in_background === true,
    });
    state.background = state.background || record.run_in_background === true;
    await this.emitSubagent(state);
  }

  private async ensureSubagent(
    toolUseId: string,
    seed: { title: string; meta?: string; prompt?: string; background?: boolean } | null
  ): Promise<SubagentState> {
    const existing = this.subagents.get(toolUseId);
    if (existing) {
      if (seed) {
        if (existing.title === "Subagent task" && seed.title) {
          existing.title = seed.title;
        }
        existing.meta = existing.meta ?? seed.meta;
      }
      return existing;
    }
    const payload = this.activeToolPayloads.get(toolUseId);
    const payloadInput =
      payload?.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : {};
    const title =
      seed?.title ||
      (typeof payloadInput.description === "string" && payloadInput.description.trim()) ||
      "Subagent task";
    const prompt =
      seed?.prompt ?? (typeof payloadInput.prompt === "string" ? payloadInput.prompt.trim() : "");
    const transcript: AgentStoredEvent[] = prompt
      ? [
          {
            seq: 1,
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            createdAt: Date.now(),
            kind: "user_message",
            messageId: randomUUID(),
            content: prompt,
          },
        ]
      : [];
    const state: SubagentState = {
      subagentId: toolUseId,
      toolUseId,
      taskId: null,
      title,
      meta: seed?.meta,
      status: "running",
      transcript,
      scope: createScope(),
      broadcaster: createSubagentProgressBroadcaster({
        emit: () => this.emitSubagent(state),
      }),
      toolPayloads: new Map(),
      finished: false,
      background: seed?.background ?? false,
      lastActivity: prompt ? prompt.slice(0, 240) : null,
      lastEmittedSignature: null,
    };
    this.subagents.set(toolUseId, state);
    return state;
  }

  private async emitSubagent(state: SubagentState): Promise<void> {
    if (state.finished && state.status === "running") {
      return;
    }
    const recentActivity =
      latestSubagentTranscriptActivity(state.transcript) ?? state.lastActivity ?? undefined;
    const lastRow = state.transcript[state.transcript.length - 1];
    const signature = JSON.stringify([
      state.status,
      state.title,
      state.meta,
      state.transcript.length,
      lastRow?.kind,
      lastRow && "status" in lastRow ? lastRow.status : null,
      lastRow && "text" in lastRow ? lastRow.text.length : null,
      recentActivity,
    ]);
    if (signature === state.lastEmittedSignature) {
      return;
    }
    state.lastEmittedSignature = signature;
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "subagent",
        subagentId: state.subagentId,
        title: state.title,
        meta: state.meta,
        status: state.status,
        transcript: [...state.transcript],
        recentActivity,
        raw: { toolUseId: state.toolUseId, taskId: state.taskId },
      },
    ]);
  }

  private settleSubagentToolRow(
    state: SubagentState,
    event: AgentEventInput
  ): void {
    if (event.kind !== "tool_call_update" && event.kind !== "tool_call") {
      return;
    }
    for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
      const row = state.transcript[index]!;
      if (row.kind === "tool_call" && row.toolCallId === event.toolCallId) {
        state.transcript[index] = {
          ...row,
          status: event.status,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.locations ? { locations: event.locations } : {}),
          ...(event.editPreview ? { editPreview: event.editPreview } : {}),
          raw: event.raw,
        };
        state.lastActivity = row.title;
        state.broadcaster.notify();
        return;
      }
    }
    state.transcript.push({
      ...event,
      kind: "tool_call",
      title: event.kind === "tool_call" ? event.title : event.title ?? "Tool",
      toolKind: event.kind === "tool_call" ? event.toolKind : event.toolKind ?? "tool",
      seq: transcriptSeq(state.transcript),
      createdAt: Date.now(),
    } as AgentStoredEvent);
    state.broadcaster.notify();
  }

  private async settleSubagentFromToolResult(
    state: SubagentState,
    result: { result?: unknown; isError?: boolean }
  ): Promise<void> {
    const text = textFromClaudeToolResult(result.result).trim();
    const resultRecord =
      result.result && typeof result.result === "object" && !Array.isArray(result.result)
        ? (result.result as Record<string, unknown>)
        : null;
    const launchedAsync =
      resultRecord?.isAsync === true ||
      /running in the background|launched .*background|async agent/i.test(text);
    if (launchedAsync && !result.isError && !state.finished) {
      state.background = true;
      state.lastActivity = "Running in the background";
      await this.emitSubagent(state);
      return;
    }
    await this.finishSubagent(state, result.isError ? "failed" : "completed", text);
  }

  private async finishSubagent(
    state: SubagentState,
    status: "completed" | "failed",
    finalText: string
  ): Promise<void> {
    if (state.finished) {
      return;
    }
    state.finished = true;
    state.broadcaster.stop();
    await this.closeOpenMessage(state.scope, state);
    const trimmed = finalText.trim();
    const lastChunk = [...state.transcript]
      .reverse()
      .find((row) => row.kind === "assistant_message_chunk");
    if (trimmed && !(lastChunk && lastChunk.kind === "assistant_message_chunk" && lastChunk.text.trim() === trimmed)) {
      const messageId = randomUUID();
      state.transcript.push(
        {
          seq: transcriptSeq(state.transcript),
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          createdAt: Date.now(),
          kind: "assistant_message_chunk",
          messageId,
          text: trimmed,
        },
        {
          seq: transcriptSeq(state.transcript) + 1,
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          createdAt: Date.now(),
          kind: "assistant_message_end",
          messageId,
          stopReason: "complete",
        }
      );
    }
    state.status = status;
    state.lastActivity = trimmed.slice(0, 240) || state.lastActivity;
    await this.emitSubagent(state);
  }

  private async handleTaskEvent(
    task: NonNullable<ReturnType<typeof parseClaudeTaskEvent>>,
    record: Record<string, unknown>
  ): Promise<void> {
    if (task.skipTranscript) {
      return;
    }
    const toolUseId =
      task.toolUseId ?? (task.taskId ? this.tasksByToolUse.get(task.taskId) ?? null : null);
    if (task.taskId && task.toolUseId) {
      this.tasksByToolUse.set(task.taskId, task.toolUseId);
    }
    const knownSubagent = toolUseId ? this.subagents.get(toolUseId) : undefined;
    const isAgentTask =
      Boolean(knownSubagent) ||
      task.taskType === "local_agent" ||
      Boolean(task.subagentType) ||
      (toolUseId ? isClaudeSubagentToolName(this.activeToolPayloads.get(toolUseId)?.name) : false);

    if (isAgentTask && toolUseId) {
      const state = await this.ensureSubagent(toolUseId, {
        title: task.description ?? "Subagent task",
        meta: task.subagentType ?? undefined,
      });
      state.taskId = task.taskId ?? state.taskId;
      if (task.subtype === "task_started") {
        if (task.description && state.title === "Subagent task") {
          state.title = task.description;
        }
        state.meta = state.meta ?? task.subagentType ?? undefined;
        await this.emitSubagent(state);
        return;
      }
      if (task.subtype === "task_progress") {
        state.lastActivity = task.description ?? task.summary ?? state.lastActivity;
        state.broadcaster.notify();
        return;
      }
      if (task.subtype === "task_updated") {
        if (task.status === "completed") {
          await this.finishSubagent(state, "completed", task.summary ?? "");
        } else if (task.status === "failed" || task.status === "killed") {
          await this.finishSubagent(state, "failed", task.error ?? task.summary ?? "");
        } else if (task.description) {
          state.lastActivity = task.description;
          state.broadcaster.notify();
        }
        return;
      }
      if (task.subtype === "task_notification") {
        const failed = task.status === "failed" || task.status === "stopped";
        await this.finishSubagent(state, failed ? "failed" : "completed", task.summary ?? task.error ?? "");
      }
      return;
    }

    // Non-agent tasks: background Bash, local workflows, monitors. Render
    // against the originating tool call when known, else as a task card.
    const toolCallId = toolUseId ?? (task.taskId ? `claude-task-${task.taskId}` : null);
    if (!toolCallId) {
      return;
    }
    const title =
      task.taskType === "local_workflow"
        ? `Workflow${task.workflowName ? ` · ${task.workflowName}` : ""}`
        : task.description ?? "Background task";
    if (task.subtype === "task_started") {
      const known = toolUseId ? this.activeToolPayloads.has(toolUseId) : false;
      await this.callbacks.appendEvents([
        known
          ? {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "tool_call_update",
              toolCallId,
              status: "in_progress",
              detail: task.description ?? "Running in the background",
              raw: record,
            }
          : {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "tool_call",
              toolCallId,
              title,
              toolKind: "task",
              status: "in_progress",
              detail: task.description ?? undefined,
              raw: record,
            },
      ]);
      return;
    }
    if (task.subtype === "task_progress") {
      const now = Date.now();
      const last = this.toolProgressAt.get(toolCallId) ?? 0;
      if (now - last < this.timings.toolProgressIntervalMs) {
        return;
      }
      this.toolProgressAt.set(toolCallId, now);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId,
          status: "in_progress",
          detail: task.summary ?? task.description ?? undefined,
          raw: record,
        },
      ]);
      return;
    }
    const status =
      task.status === "completed"
        ? "completed"
        : task.status === "failed" || task.status === "killed" || task.status === "stopped"
          ? "failed"
          : null;
    if (!status) {
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        status,
        detail: task.summary ?? task.error ?? task.description ?? undefined,
        raw: record,
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Permissions and questions
  // ---------------------------------------------------------------------------

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = options.toolUseID || randomUUID();
    if (this.turn?.cancelRequested || this.disposed) {
      return { behavior: "deny", message: CANCEL_DENY_MESSAGE, interrupt: true };
    }
    if (toolName === "AskUserQuestion") {
      return this.askUserQuestion(requestId, input);
    }
    const unsafeMessage = unsafeRecursiveGrepMessage(toolName, input);
    if (unsafeMessage) {
      return { behavior: "deny", message: unsafeMessage };
    }
    const isPlanApproval = toolName === "ExitPlanMode";
    const toolKey = permissionToolKey(toolName, input);
    const toolLabel = options.displayName || toolName;
    const title = isPlanApproval
      ? "Claude has a plan ready. Approve it and start implementing?"
      : options.title || permissionTitleForClaudeTool(toolName, input);
    const detail = isPlanApproval
      ? typeof input.plan === "string" && input.plan.trim()
        ? input.plan.trim().slice(0, 4_000)
        : "Review the plan in the transcript, then approve to let Claude implement it or reject to keep planning."
      : typeof input.command === "string" && input.command.trim()
        ? input.command.trim()
        : options.description ||
          options.decisionReason ||
          firstString(input, ["file_path", "notebook_path", "path", "url", "query", "prompt"]) ||
          JSON.stringify(input).slice(0, 600);
    const permissionCategory = permissionCategoryForClaudeTool(toolName);

    if (!isPlanApproval) {
      const resolved = await resolveRememberedPermissionDecision({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey,
        permissionCategory,
      });
      if (resolved.kind === "remembered") {
        return resolved.decision === "allow"
          ? { behavior: "allow", updatedPermissions: options.suggestions }
          : {
              behavior: "deny",
              message: `Denied by remembered rule for ${resolved.rule.toolLabel}.`,
            };
      }
      if (resolved.kind === "auto_accept") {
        return { behavior: "allow" };
      }
    }

    const optionsList = isPlanApproval ? planApprovalOptions() : permissionOptions();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_request",
        requestId,
        title,
        detail,
        toolCallId: requestId,
        options: optionsList,
        raw: { toolName, input, options: { ...options, signal: undefined } },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_permission",
        detail: title,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: {
        requestId,
        requestedAt: Date.now(),
        toolCallId: requestId,
        ...(permissionCategory ? { permission: permissionCategory } : {}),
        title,
        detail,
        options: optionsList,
      },
    }));

    return new Promise<PermissionResult>((resolve) => {
      this.pendingInteractions.set(requestId, {
        kind: "permission",
        resolve,
        suggestions: options.suggestions,
        toolName,
        toolKey,
        toolLabel,
        toolUseId: requestId,
      });
      options.signal.addEventListener(
        "abort",
        () => {
          if (this.pendingInteractions.get(requestId)) {
            this.pendingInteractions.delete(requestId);
            resolve({ behavior: "deny", message: "Permission request aborted by Claude Code.", interrupt: true });
            void this.callbacks.updateConversation((current) =>
              current.pendingPermission?.requestId === requestId
                ? { ...current, status: "running", pendingPermission: null }
                : current
            );
          }
        },
        { once: true }
      );
    });
  };

  private async askUserQuestion(
    requestId: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    const parsed = parseClaudeAskUserQuestion(input);
    if (!parsed) {
      return { behavior: "deny", message: "AskUserQuestion payload had no questions." };
    }
    const questionId = `${this.callbacks.conversation.id}-claude-code-sdk-question-${requestId}`;
    return new Promise<PermissionResult>((resolve) => {
      void this.openQuestion({
        questionId,
        prompt: parsed.prompt,
        steps: parsed.steps,
        source: "ask_user_question",
        raw: input,
        onAnswer: (submission) => {
          if (submission === null) {
            resolve({ behavior: "deny", message: "The user dismissed the question without answering." });
            return;
          }
          const answers = claudeAnswersFromSubmission(parsed.steps, submission);
          resolve({ behavior: "allow", updatedInput: { ...input, answers } });
        },
      });
    });
  }

  /**
   * MCP elicitation bridge. URL-mode requests (OAuth in a browser) are surfaced
   * and accepted so the server can wait for the browser flow; form-mode
   * requests become Cesium question cards whose answers are typed back into
   * the requested schema.
   */
  private readonly onElicitation: OnElicitation = async (request, options) => {
    if (this.disposed || this.turn?.cancelRequested) {
      return { action: "cancel" };
    }
    if (request.mode === "url" || request.url) {
      await this.appendSystem(
        "warning",
        `${request.serverName} needs authorization in your browser: ${request.url ?? "(no URL provided)"}${
          request.message ? ` — ${request.message}` : ""
        }`,
        request
      );
      return { action: "accept" };
    }
    const form = parseClaudeElicitationForm(request);
    if (!form) {
      await this.appendSystem(
        "warning",
        `${request.serverName} asked for input Cesium could not render; the request was declined.`,
        request
      );
      return { action: "decline" };
    }
    const questionId = `${this.callbacks.conversation.id}-claude-code-sdk-elicitation-${
      request.elicitationId ?? randomUUID()
    }`;
    return new Promise((resolve) => {
      const settle = (result: Awaited<ReturnType<OnElicitation>>) => resolve(result);
      options.signal.addEventListener(
        "abort",
        () => {
          const pending = this.pendingInteractions.get(questionId);
          if (pending) {
            this.pendingInteractions.delete(questionId);
            settle({ action: "cancel" });
          }
        },
        { once: true }
      );
      void this.openQuestion({
        questionId,
        prompt: form.prompt,
        steps: form.steps,
        source: "mcp_elicitation",
        raw: request,
        onAnswer: (submission) => {
          if (submission === null) {
            settle({ action: "decline" });
            return;
          }
          settle({ action: "accept", content: claudeElicitationContentFromSubmission(form, submission) });
        },
      });
    });
  };

  private async openQuestion(input: {
    questionId: string;
    prompt: string;
    steps: ClaudeQuestionStep[];
    source: PendingQuestion["source"];
    raw: unknown;
    onAnswer: (submission: string | null) => void;
  }): Promise<void> {
    const primary = input.steps[0]!;
    this.pendingInteractions.set(input.questionId, {
      kind: "question",
      onAnswer: input.onAnswer,
      steps: input.steps,
      prompt: input.prompt,
      source: input.source,
    });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: input.prompt,
        options: primary.options.map((option) => ({ id: option.id, label: option.label })),
        questions: input.steps.map((step) => ({
          id: step.id,
          prompt: step.prompt,
          options: step.options.map((option) => ({ id: option.id, label: option.label })),
          allowMultiple: step.allowMultiple,
        })),
        allowMultiple: input.steps.length === 1 ? primary.allowMultiple : false,
        status: "pending",
        raw: input.raw,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: input.prompt,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: { questionId: input.questionId, requestedAt: Date.now() },
    }));
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const pending = this.pendingInteractions.get(input.questionId);
    if (!pending || pending.kind !== "question") {
      return;
    }
    this.pendingInteractions.delete(input.questionId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: pending.prompt,
        options: pending.steps[0]!.options.map((option) => ({ id: option.id, label: option.label })),
        questions: pending.steps.map((step) => ({
          id: step.id,
          prompt: step.prompt,
          options: step.options.map((option) => ({ id: option.id, label: option.label })),
          allowMultiple: step.allowMultiple,
        })),
        allowMultiple: pending.steps.length === 1 ? pending.steps[0]!.allowMultiple : false,
        status: "answered",
        answer: input.answer,
        raw: { source: pending.source, answers: claudeAnswersFromSubmission(pending.steps, input.answer) },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail:
          pending.source === "mcp_elicitation"
            ? "Answer sent to the MCP server."
            : "Answer sent to Claude Code.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
    pending.onAnswer(input.answer);
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const pending = this.pendingInteractions.get(input.requestId);
    if (!pending) {
      return;
    }
    if (pending.kind === "question") {
      // A dismissed question card arrives through the permission path.
      this.pendingInteractions.delete(input.requestId);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "question",
          questionId: input.requestId,
          prompt: pending.prompt,
          options: pending.steps[0]!.options.map((option) => ({ id: option.id, label: option.label })),
          status: "cancelled",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "running",
        pendingQuestion: null,
      }));
      pending.onAnswer(null);
      return;
    }
    this.pendingInteractions.delete(input.requestId);
    const decision = input.cancelled ? "reject" : permissionDecisionFromOption(input.optionId);
    const optionId = input.cancelled ? undefined : input.optionId;
    if (optionId === "allow_always" || optionId === "reject_always") {
      await persistRememberedPermissionChoice({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: pending.toolKey,
        toolLabel: pending.toolLabel,
        optionId,
        optionKind: optionId,
        permissionCategory: permissionCategoryForClaudeTool(pending.toolName),
      });
    }
    const isPlanApproval = pending.toolName === "ExitPlanMode";
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
        detail: isPlanApproval
          ? decision === "allow"
            ? "Plan approved; Claude is implementing it."
            : "Plan rejected; Claude keeps planning."
          : decision === "allow"
            ? "Permission allowed."
            : "Permission rejected.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
    if (isPlanApproval && decision === "allow") {
      await this.applyModeChange("agent");
    }
    pending.resolve(
      decision === "allow"
        ? {
            behavior: "allow",
            updatedPermissions:
              optionId === "allow_always" && Array.isArray(pending.suggestions)
                ? pending.suggestions
                : undefined,
          }
        : {
            behavior: "deny",
            message: isPlanApproval
              ? "The user wants to keep planning. Revise the plan based on any new feedback."
              : "Rejected by user.",
            interrupt: input.cancelled,
          }
    );
  }

  private rejectPendingInteractions(message: string): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      this.pendingInteractions.delete(requestId);
      if (pending.kind === "question") {
        pending.onAnswer(null);
      } else {
        pending.resolve({ behavior: "deny", message, interrupt: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel / config / dispose
  // ---------------------------------------------------------------------------

  async cancel(): Promise<void> {
    const turn = this.turn;
    const live = this.live;
    if (!turn) {
      this.rejectPendingInteractions(CANCEL_DENY_MESSAGE);
      await this.callbacks.updateConversation((current) =>
        current.status === "awaiting_permission" || current.status === "awaiting_question"
          ? { ...current, status: "idle", pendingPermission: null, pendingQuestion: null }
          : current
      );
      return;
    }
    turn.cancelRequested = true;
    const hadPendingInteractions = this.pendingInteractions.size > 0;
    this.rejectPendingInteractions(CANCEL_DENY_MESSAGE);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      pendingPermission: null,
      pendingQuestion: null,
    }));
    if (live && !live.closed) {
      await withTimeout(live.query.interrupt().catch(() => undefined), this.timings.interruptGraceMs);
      const settled = await withTimeout(turn.done, hadPendingInteractions ? 2_000 : this.timings.interruptGraceMs);
      if (settled === undefined && !turn.settled) {
        live.query.close();
        await withTimeout(turn.done, this.timings.closeGraceMs);
      }
    }
    if (!turn.settled) {
      turn.settle({ kind: "cancelled", result: null });
    }
    await withTimeout(turn.finalized, this.timings.closeGraceMs);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const previous = this.configOptions.find((option) => option.id === configId)?.currentValue;
    this.configOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.callbacks.updateConversation((current) => {
      const next = { ...current, configOptions: this.configOptions };
      if (configId === "model") {
        next.config = {
          ...next.config,
          modelId: value,
          modelName: optionDisplayName(this.configOptions, configId, value),
        };
      } else if (configId === "mode") {
        next.config = { ...next.config, mode: value };
      }
      return next;
    });
    if (previous === value) {
      return;
    }
    const live = this.live;
    if (!live || live.closed) {
      return;
    }
    if (configId === "model") {
      const model = selectedModel(this.callbacks.conversation, this.configOptions);
      const applied = await withTimeout(
        live.query.setModel(model).then(() => true).catch(() => false),
        this.timings.controlRequestTimeoutMs
      );
      // Through a third-party proxy the subagent alias remap lives in the
      // spawn env, so the process must be rebuilt for subagents to follow.
      if (!applied || isThirdPartyClaudeCodeSdkProxy()) {
        this.restartRequired = true;
      }
      return;
    }
    if (configId === "mode" || configId === "permission_mode") {
      const permissionMode = permissionModeForConfig(this.callbacks.conversation, this.configOptions);
      const applied = await withTimeout(
        live.query.setPermissionMode(permissionMode).then(() => true).catch(() => false),
        this.timings.controlRequestTimeoutMs
      );
      // Tool profiles differ per mode (ask/plan), so the process is rebuilt too.
      this.restartRequired = true;
      if (!applied) {
        return;
      }
      return;
    }
    // Everything else (tools, effort, thinking, budget, setting sources,
    // persistence) is a spawn-time option: rebuild the process on next prompt.
    this.restartRequired = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectPendingInteractions("Session disposed before the request was answered.");
    for (const state of this.subagents.values()) {
      state.broadcaster.stop();
    }
    const live = this.live;
    this.live = null;
    if (live) {
      live.input.end();
      live.abortController.abort();
      live.query.close();
      await withTimeout(live.pump, this.timings.closeGraceMs);
    }
    if (this.turn && !this.turn.settled) {
      this.turn.settle({ kind: "cancelled", result: null });
    }
  }

  // ---------------------------------------------------------------------------
  // Context usage
  // ---------------------------------------------------------------------------

  private async persistContextUsage(): Promise<void> {
    const assistant = this.lastAssistantUsage;
    const result = this.lastResultUsage;
    const contextTokens = assistant
      ? assistant.inputTokens + assistant.cacheReadTokens + assistant.cacheCreationTokens
      : result
        ? result.inputTokens + result.cacheReadTokens + result.cacheCreationTokens
        : 0;
    if (contextTokens <= 0) {
      return;
    }
    const usage: ClaudeCodeSdkContextUsage = {
      contextTokens,
      contextWindow: result?.contextWindow ?? this.lastContextUsage?.contextWindow ?? null,
      model: result?.primaryModel ?? this.lastContextUsage?.model ?? null,
      updatedAt: Date.now(),
      source: "assistant_usage",
    };
    this.lastContextUsage = usage;
    await writeClaudeCodeSdkConversationState(
      this.callbacks.workspace.id,
      this.callbacks.conversation.id,
      { contextUsage: usage }
    ).catch(() => undefined);
  }

  private scheduleContextProbe(): void {
    if (!this.contextProbeEnabled) {
      return;
    }
    const live = this.live;
    if (!live || live.closed) {
      return;
    }
    void withTimeout(
      live.query.getContextUsage().catch(() => null),
      this.timings.controlRequestTimeoutMs
    ).then(async (response) => {
      if (!response || typeof response !== "object") {
        return;
      }
      const record = response as Record<string, unknown>;
      const total = typeof record.totalTokens === "number" ? record.totalTokens : 0;
      const max = typeof record.maxTokens === "number" ? record.maxTokens : null;
      const categories = Array.isArray(record.categories)
        ? (record.categories as unknown[]).flatMap((entry) => {
            const category = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
            const name = typeof category?.name === "string" ? category.name : "";
            const tokens = typeof category?.tokens === "number" ? category.tokens : 0;
            const id = mapClaudeContextCategory(name);
            return id && tokens > 0 ? [{ id, label: name, tokens }] : [];
          })
        : [];
      if (total <= 0) {
        return;
      }
      const usage: ClaudeCodeSdkContextUsage = {
        contextTokens: total,
        contextWindow: max,
        model: this.lastContextUsage?.model ?? null,
        updatedAt: Date.now(),
        categories,
        source: "context_probe",
      };
      this.lastContextUsage = usage;
      await writeClaudeCodeSdkConversationState(
        this.callbacks.workspace.id,
        this.callbacks.conversation.id,
        { contextUsage: usage }
      ).catch(() => undefined);
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Appends a CLI note unless the current turn already carries the same text
   * (the CLI echoes local-command output as a status, a synthetic assistant
   * message, and the result text; one note is enough).
   */
  private async appendSystemOnce(
    level: "info" | "warning" | "error",
    text: string,
    raw?: unknown
  ): Promise<void> {
    const trimmed = text.trim();
    const last = this.turn?.lastSystemText;
    if (!trimmed || (last && (last === trimmed || last.includes(trimmed)))) {
      return;
    }
    await this.appendSystem(level, trimmed, raw);
  }

  private async appendSystem(
    level: "info" | "warning" | "error",
    text: string,
    raw?: unknown
  ): Promise<void> {
    if (!text.trim()) {
      return;
    }
    if (this.turn) {
      this.turn.lastSystemText = text.trim();
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level,
        text,
        ...(raw !== undefined ? { raw } : {}),
      },
    ]);
  }
}

export function createClaudeCodeSdkProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
  deps?: ClaudeCodeSdkProviderDeps;
}): AgentProvider {
  const deps = input.deps ?? {};
  return {
    backend: input.backend,
    startSession(callbacks) {
      return ClaudeCodeSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        deps,
      });
    },
    loadSession(callbacks, providerSessionId) {
      return ClaudeCodeSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
        deps,
      });
    },
  };
}

export type ClaudeCodeSdkCapabilityProbe = {
  models: Array<{
    value: string;
    displayName?: string;
    description?: string;
    supportedEffortLevels?: string[];
    supportsAdaptiveThinking?: boolean;
  }>;
  commands: Array<{ name: string; description?: string; inputHint?: string }>;
  /** Tool names, when the probe observed an `init` message (empty for handshake-only probes). */
  tools: string[];
  version: string | null;
  agents: string[];
  account: Record<string, unknown> | null;
};

let capabilityProbeCache: { key: string; expiresAt: number; value: ClaudeCodeSdkCapabilityProbe } | null = null;
const CAPABILITY_PROBE_TTL_MS = 10 * 60_000;

/**
 * Spawns a short-lived streaming session to read the CLI's real model
 * catalog, slash commands, and tool list. The `init` message arrives before
 * any model request, so the probe costs no tokens. Results are memoized per
 * credential/executable configuration.
 */
export async function probeClaudeCodeSdkCapabilities(options: {
  cwd?: string;
  timeoutMs?: number;
  query?: ClaudeCodeSdkQueryFn;
  force?: boolean;
} = {}): Promise<ClaudeCodeSdkCapabilityProbe | null> {
  const key = JSON.stringify({
    baseUrl: getClaudeCodeSdkProxyBaseUrl(),
    hasKey: Boolean(getClaudeCodeSdkProxyApiKey()),
    model: getClaudeCodeSdkProxyModel(),
    executable: getClaudeCodeSdkPathToExecutable() ?? null,
    cwd: options.cwd ?? null,
  });
  if (!options.force && capabilityProbeCache && capabilityProbeCache.key === key && capabilityProbeCache.expiresAt > Date.now()) {
    return capabilityProbeCache.value;
  }
  const queryFn = options.query ?? sdkQuery;
  const input = new PushableInput();
  const abortController = new AbortController();
  const model = hasClaudeCodeSdkProxyConfig() ? getClaudeCodeSdkProxyModel() : undefined;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let live: Query | null = null;
  try {
    live = queryFn({
      prompt: input,
      options: {
        abortController,
        cwd: options.cwd ?? process.cwd(),
        env: claudeCodeSdkEnv(model),
        pathToClaudeCodeExecutable: getClaudeCodeSdkPathToExecutable(),
        persistSession: false,
        model,
        tools: CLAUDE_STANDARD_TOOLS,
        settingSources: [],
        canUseTool: async () => ({ behavior: "deny", message: "Capability probe." }),
      },
    });
    const query = live;
    // Drain the message stream in the background so control responses are
    // read; in streaming-input mode the CLI emits nothing until a prompt
    // arrives, so the initialize handshake is the only source of metadata.
    const drain = (async () => {
      try {
        for await (const _message of query) {
          // no-op
        }
      } catch {
        // closed below
      }
    })();
    void drain;
    const init = (await withTimeout(query.initializationResult(), timeoutMs)) as
      | Record<string, unknown>
      | undefined;
    if (!init) {
      return null;
    }
    const models = init.models;
    const commands = init.commands;
    const agents = init.agents;
    const value: ClaudeCodeSdkCapabilityProbe = {
      models: Array.isArray(models)
        ? models.flatMap((entry) => {
            const record = entry as Record<string, unknown>;
            return typeof record.value === "string" && record.value
              ? [
                  {
                    value: record.value,
                    displayName: typeof record.displayName === "string" ? record.displayName : undefined,
                    description: typeof record.description === "string" ? record.description : undefined,
                    supportedEffortLevels: Array.isArray(record.supportedEffortLevels)
                      ? (record.supportedEffortLevels as string[])
                      : undefined,
                    supportsAdaptiveThinking: record.supportsAdaptiveThinking === true,
                  },
                ]
              : [];
          })
        : [],
      commands: claudeSlashCommandsFromSdk(commands),
      // The initialize handshake carries no tool list; sessions learn it from `init`.
      tools: [],
      version: null,
      agents: Array.isArray(agents)
        ? agents.flatMap((entry) => {
            const record = entry as Record<string, unknown>;
            return typeof record.name === "string" ? [record.name] : [];
          })
        : [],
      account:
        init.account && typeof init.account === "object"
          ? (init.account as Record<string, unknown>)
          : null,
    };
    capabilityProbeCache = { key, expiresAt: Date.now() + CAPABILITY_PROBE_TTL_MS, value };
    return value;
  } catch (error) {
    harnessLog({
      level: "warning",
      backendId: "claude-code-sdk",
      event: "claude-code-sdk.capability_probe_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    input.end();
    try {
      live?.close();
    } catch {
      // already closed
    }
  }
}

export function resetClaudeCodeSdkCapabilityProbeCache(): void {
  capabilityProbeCache = null;
}
