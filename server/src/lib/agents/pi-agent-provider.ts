import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ModelRegistry,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  applyPiRuntimeApiKeys,
  createPiAuthStorage,
  getPiAgentDir,
  getPiAgentSessionsDirForCwd,
  hasPiAgentStoredAuthConfig,
  refreshPiAgentDirCache,
} from "../pi-agent-settings.js";
import {
  isPiAgentThinkingLevel,
  normalizePiAgentToolApprovalMode,
  PI_AGENT_TOOL_APPROVAL_OPTION_ID,
  type PiAgentThinkingLevel,
} from "../pi-agent-model-catalog.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import {
  PiAgentEventNormalizer,
  piToolTitle,
  type PiAgentNormalizedBatch,
  type PiAgentRecord,
} from "./pi-agent-normalize.js";
import { isAllowOptionId, PiAgentUiBridge } from "./pi-agent-ui-context.js";
import { findPrimaryModelConfigOption } from "./config-option-utils.js";
import { STANDARD_PERMISSION_OPTIONS } from "./permission-options.js";
import {
  buildRememberedPermissionToolKey,
  persistRememberedPermissionChoice,
  resolveRememberedPermissionDecision,
} from "./remembered-permissions.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentPermissionCategory,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";
import { asRecord, asString } from "./json-coerce.js";

type PiAgentHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  providerSessionId?: string | null;
};

const capabilities = AGENT_CAPABILITIES["pi-agent"];

/** How long `prompt()` waits for a previous run to settle before queueing as a follow-up. */
const QUIESCENCE_TIMEOUT_MS = 30_000;

const MUTATING_BUILTIN_TOOLS = new Set(["bash", "edit", "write"]);

/**
 * Startup notices already written per conversation in this process. Runtimes
 * are re-created after a few idle seconds, and the snapshot used for dedupe is
 * windowed, so without this a broken extension would be reported on every
 * re-attach of a long conversation.
 */
const emittedStartupNotices = new Map<string, Set<string>>();
const EMITTED_STARTUP_NOTICE_CONVERSATION_LIMIT = 500;

/**
 * Seed a fresh handle's options from the cached catalog while carrying over
 * every value the conversation already chose (model, mode, thinking level,
 * tool approval). Runtimes are disposed when idle, so a value picked in the
 * composer must survive the next `ensureRuntime`.
 */
export function withCurrentConfig(
  configOptions: AgentConfigOption[],
  conversation: AgentConversationRecord
): AgentConfigOption[] {
  const persisted = new Map(
    (conversation.configOptions ?? []).map((option) => [option.id, option.currentValue] as const)
  );
  return configOptions.map((option) => {
    if (option.category === "model") {
      return {
        ...option,
        currentValue: conversation.config.modelId || option.currentValue,
      };
    }
    if (option.category === "mode") {
      return {
        ...option,
        currentValue: conversation.config.mode || option.currentValue,
      };
    }
    const saved = persisted.get(option.id)?.trim();
    if (saved && option.options.some((entry) => entry.value === saved)) {
      return { ...option, currentValue: saved };
    }
    return option;
  });
}

function optionDisplayName(configOptions: AgentConfigOption[], configId: string, value: string): string {
  return configOptions
    .find((option) => option.id === configId)
    ?.options.find((option) => option.value === value)?.name ?? value;
}

function updateConfigOption(
  options: AgentConfigOption[],
  configId: string,
  value: string
): AgentConfigOption[] {
  return options.map((option) =>
    option.id === configId ? { ...option, currentValue: value } : option
  );
}

/**
 * Ensure a model value exists in the model option list so the composer can
 * render it even when the cached catalog predates the model (e.g. a provider
 * registered by an extension at session start).
 */
function ensureModelOption(
  options: AgentConfigOption[],
  value: string,
  name: string
): AgentConfigOption[] {
  return options.map((option) => {
    if (option.category !== "model") {
      return option;
    }
    const present = option.options.some((entry) => entry.value === value);
    const filtered = option.options.filter(
      (entry) => entry.value !== "auto" && entry.value !== "__default__"
    );
    return {
      ...option,
      currentValue: value,
      options: present ? option.options : [...filtered, { value, name }],
    };
  });
}

export function parsePiModelValue(value: string | undefined): { provider: string; modelId: string } | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "__default__") {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slash).toLowerCase(),
    modelId: trimmed.slice(slash + 1),
  };
}

function thinkingLevelForConfig(configOptions: AgentConfigOption[]): PiAgentThinkingLevel | undefined {
  const value = configOptions.find((option) => option.id === "thinking_level")?.currentValue;
  return isPiAgentThinkingLevel(value) ? value : undefined;
}

function useInMemorySessions(): boolean {
  return process.env.OPENCURSOR_PI_AGENT_IN_MEMORY === "1";
}

/**
 * Mirror Pi's getDefaultSessionDir encoding (not re-exported from the package root).
 * Layout: <agentDir>/sessions/--<cwd-with-slashes-as-dashes>--
 */
export function piNativeSessionDirForCwd(cwd: string, agentDir: string): string {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(agentDir), "sessions", safePath);
}

/**
 * Resolve Pi session storage under the active agentDir so CLI and Cesium share
 * the same session tree when using native ~/.pi/agent.
 */
async function resolveSessionManager(cwd: string, agentDir: string, providerSessionId?: string | null) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  if (useInMemorySessions()) {
    return SessionManager.inMemory(cwd);
  }

  // Prefer Pi's native layout under agentDir; fall back to the hashed Cesium path
  // only when that directory already has sessions (resume compatibility).
  const nativeSessionDir = piNativeSessionDirForCwd(cwd, agentDir);
  const legacySessionDir = getPiAgentSessionsDirForCwd(cwd);
  const sessionDir =
    existsSync(legacySessionDir) && !existsSync(nativeSessionDir)
      ? legacySessionDir
      : nativeSessionDir;
  await fs.mkdir(sessionDir, { recursive: true });

  if (providerSessionId) {
    if (providerSessionId.endsWith(".jsonl") && existsSync(providerSessionId)) {
      return SessionManager.open(providerSessionId, sessionDir, cwd);
    }
    const candidate = providerSessionId.includes("/") || providerSessionId.includes("\\")
      ? providerSessionId
      : undefined;
    if (candidate && existsSync(candidate)) {
      return SessionManager.open(candidate, sessionDir, cwd);
    }
    const sessions = await SessionManager.list(cwd, sessionDir);
    const match = sessions.find(
      (session) => session.id === providerSessionId || session.path === providerSessionId
    );
    if (match) {
      return SessionManager.open(match.path, sessionDir, cwd);
    }
    throw new Error(`Pi session not found: ${providerSessionId}`);
  }

  return SessionManager.create(cwd, sessionDir);
}

function resolveModel(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[],
  modelRegistry: ModelRegistry
): { requested: string | null; model: ReturnType<ModelRegistry["find"]> } {
  const modelOption = findPrimaryModelConfigOption(configOptions);
  const requestedValue = conversation.config.modelId || modelOption?.currentValue;
  const parsed = parsePiModelValue(requestedValue);
  if (parsed) {
    return {
      requested: `${parsed.provider}/${parsed.modelId}`,
      model: modelRegistry.find(parsed.provider, parsed.modelId),
    };
  }
  return { requested: null, model: undefined };
}

/** Whether `text` invokes an extension-registered slash command (not a prompt template or skill). */
export function isPiExtensionCommand(
  session: Pick<AgentSession, "extensionRunner">,
  text: string
): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const name = trimmed.slice(1).split(/\s+/, 1)[0];
  if (!name) {
    return false;
  }
  return Boolean(session.extensionRunner.getCommand(name));
}

function permissionCategoryForTool(toolName: string): AgentPermissionCategory | undefined {
  switch (toolName) {
    case "bash":
      return "terminal";
    case "edit":
    case "write":
      return "editFile";
    default:
      return undefined;
  }
}

function describeToolCallForPermission(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") {
    return asString(input.command) ?? "(no command)";
  }
  const pathValue = asString(input.path);
  if (toolName === "write") {
    return pathValue ? `Write ${pathValue}` : "Write file";
  }
  if (toolName === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits.length : undefined;
    return pathValue
      ? `Edit ${pathValue}${edits != null ? ` (${edits} change${edits === 1 ? "" : "s"})` : ""}`
      : "Edit file";
  }
  try {
    const text = JSON.stringify(input);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return toolName;
  }
}

class PiAgentSessionHandle implements AgentSessionHandle {
  readonly capabilities = capabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private readonly normalizer: PiAgentEventNormalizer;
  private readonly ui: PiAgentUiBridge;
  /** Serialises every Cesium-side mutation triggered by Pi events. */
  private chain: Promise<void> = Promise.resolve();
  /** Per-session "always allow" decisions made through the approval gate. */
  private readonly sessionApprovals = new Set<string>();

  private constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[]
  ) {
    this.configOptions = configOptions;
    this.sessionId = `pi-agent-pending-${callbacks.conversation.id}`;
    this.normalizer = new PiAgentEventNormalizer({
      conversationId: callbacks.conversation.id,
      resolveToolLabel: (toolName) => this.session?.getToolDefinition(toolName)?.label,
    });
    this.ui = new PiAgentUiBridge({
      conversationId: callbacks.conversation.id,
      appendEvents: (events) => this.enqueue(() => this.callbacks.appendEvents(events).then(() => undefined)),
      updateConversation: (patch) =>
        this.enqueue(() => this.callbacks.updateConversation(patch).then(() => undefined)),
    });
  }

  static async create(input: PiAgentHandleInput): Promise<PiAgentSessionHandle> {
    if (!(await hasPiAgentStoredAuthConfig())) {
      throw new Error(
        "Pi Agent requires at least one provider credential. Connect OAuth or add an API key in Settings -> Agents, set a provider env var, or add a provider to ~/.pi/agent/models.json."
      );
    }

    const configOptions = withCurrentConfig(input.configOptions, input.callbacks.conversation);
    const cwd = input.callbacks.workspace.root;
    const agentDir = await refreshPiAgentDirCache();
    const authStorage = await createPiAuthStorage();
    await applyPiRuntimeApiKeys(authStorage);

    const handle = new PiAgentSessionHandle(input.backend, input.callbacks, configOptions);

    // Use Pi's service factory so DefaultResourceLoader picks up packages,
    // extensions, skills, prompt templates, themes, and AGENTS.md from agentDir
    // + project .pi/ - the whole point of Pi's customization model.
    const {
      createAgentSessionServices,
      createAgentSessionFromServices,
    } = await import("@earendil-works/pi-coding-agent");

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      resourceLoaderOptions: {
        extensionFactories: [handle.createCesiumExtension()],
      },
    });

    const startupNotices: Array<{ level: "info" | "warning" | "error"; text: string }> = [];
    for (const diagnostic of services.diagnostics) {
      if (diagnostic.type === "error" || diagnostic.type === "warning") {
        console.warn(`[pi-agent] ${diagnostic.type}: ${diagnostic.message}`);
        startupNotices.push({ level: diagnostic.type, text: diagnostic.message });
      }
    }
    const extensionLoad = services.resourceLoader.getExtensions();
    for (const failure of extensionLoad.errors) {
      const text = `Pi extension failed to load (${failure.path}): ${failure.error}`;
      console.warn(`[pi-agent] ${text}`);
      startupNotices.push({ level: "error", text });
    }

    const sessionManager = await resolveSessionManager(cwd, agentDir, input.providerSessionId);
    const { requested, model } = resolveModel(
      input.callbacks.conversation,
      configOptions,
      services.modelRegistry
    );
    if (requested && !model) {
      startupNotices.push({
        level: "warning",
        text: `Pi model "${requested}" is not available in this agent home; falling back to Pi's default model.`,
      });
    }
    const thinkingLevel = thinkingLevelForConfig(configOptions);

    // Do NOT pass a tools allowlist - that would disable extension/custom tools.
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      sessionStartEvent: {
        type: "session_start",
        reason: input.providerSessionId ? "resume" : "startup",
      },
    });
    if (created.modelFallbackMessage) {
      startupNotices.push({ level: "warning", text: created.modelFallbackMessage });
    }

    handle.attachSession(created.session);
    await handle.bindExtensions();
    await handle.syncSessionState({ status: "idle", clearPending: true });
    await handle.emitStartupNotices(startupNotices);
    return handle;
  }

  // ---------------------------------------------------------------------------
  // Session wiring
  // ---------------------------------------------------------------------------

  private providerSessionRef(session: AgentSession): string {
    return session.sessionFile ?? session.sessionId;
  }

  private attachSession(session: AgentSession): void {
    this.session = session;
    this.sessionId = this.providerSessionRef(session);
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.enqueue(() => this.handleSessionEvent(event));
    });
  }

  /** Run `task` after every previously queued Cesium mutation; errors never break the chain. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((error) => {
      console.warn(
        "[pi-agent] event handling failed:",
        error instanceof Error ? error.message : String(error)
      );
    });
    this.chain = next;
    return next;
  }

  private async drain(): Promise<void> {
    await this.chain;
  }

  private async bindExtensions(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    const fallbackUi = session.extensionRunner.getUIContext();
    const unsupported = async (feature: string) => {
      await this.ui.notify(
        `Pi extension requested "${feature}", which is not available inside a Cesium conversation.`,
        "warning"
      );
      return { cancelled: true } as const;
    };
    await session.bindExtensions({
      uiContext: this.ui.createUiContext(fallbackUi),
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: () => unsupported("newSession"),
        fork: () => unsupported("fork"),
        switchSession: () => unsupported("switchSession"),
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        reload: async () => {
          await session.reload();
          await this.enqueue(() => this.syncSessionState({}));
        },
      },
      abortHandler: () => {
        void this.cancel();
      },
      shutdownHandler: () => {
        void this.ui.notify(
          "A Pi extension requested shutdown; the current turn was stopped.",
          "info"
        );
        void this.cancel();
      },
      onError: (error) => {
        void this.ui.notify(
          `Pi extension error (${error.extensionPath}, ${error.event}): ${error.error}`,
          "error"
        );
      },
    });
  }

  /**
   * Cesium-side extension: keeps the conversation record in step with model
   * switches made from inside Pi (extensions, `/model`-style commands) and
   * implements the optional tool approval gate on top of Pi's `tool_call` hook.
   */
  private createCesiumExtension(): ExtensionFactory {
    return (pi: ExtensionAPI) => {
      pi.on("model_select", (event) => {
        if (event.source === "restore") {
          return;
        }
        void this.enqueue(() => this.syncSessionState({}));
      });
      pi.on("tool_call", (event, ctx) => this.gateToolCall(event, ctx));
    };
  }

  private toolApprovalMode() {
    return normalizePiAgentToolApprovalMode(
      this.configOptions.find((option) => option.id === PI_AGENT_TOOL_APPROVAL_OPTION_ID)?.currentValue
    );
  }

  private async gateToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext
  ): Promise<ToolCallEventResult | undefined> {
    const mode = this.toolApprovalMode();
    if (mode === "pi") {
      return undefined;
    }
    const toolName = event.toolName;
    if (mode === "mutations" && !MUTATING_BUILTIN_TOOLS.has(toolName)) {
      return undefined;
    }
    const input = (asRecord(event.input) ?? {}) as Record<string, unknown>;
    const category = permissionCategoryForTool(toolName);
    const detail = describeToolCallForPermission(toolName, input);
    const toolKey = buildRememberedPermissionToolKey(
      "pi-agent",
      toolName,
      toolName === "bash" ? asString(input.command) : asString(input.path)
    );
    const sessionKey = category ?? `tool:${toolName}`;
    if (this.sessionApprovals.has(sessionKey)) {
      return undefined;
    }

    const remembered = await resolveRememberedPermissionDecision({
      workspaceId: this.callbacks.workspace.id,
      backendId: this.backend.id,
      toolKey,
      permissionCategory: category,
      options: STANDARD_PERMISSION_OPTIONS,
    });
    if (remembered.kind !== "prompt") {
      return remembered.decision === "allow"
        ? undefined
        : {
            block: true,
            reason:
              remembered.kind === "remembered"
                ? `Denied by remembered rule for ${remembered.rule.toolLabel}.`
                : "Denied.",
          };
    }

    const label = this.session?.getToolDefinition(toolName)?.label;
    const resolution = await this.ui.requestPermission({
      title: piToolTitle(toolName, input, label),
      detail,
      options: STANDARD_PERMISSION_OPTIONS,
      permission: category,
      toolCallId: event.toolCallId,
      source: "pi-agent-tool-approval",
      opts: { signal: ctx.signal },
    });
    if (resolution.cancelled) {
      return { block: true, reason: "Tool call cancelled by the user." };
    }
    const optionId = resolution.optionId;
    if (optionId === "allow_always" || optionId === "reject_always") {
      if (optionId === "allow_always") {
        this.sessionApprovals.add(sessionKey);
      }
      await persistRememberedPermissionChoice({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey,
        toolLabel: category ? `Pi ${toolName}` : `Pi tool ${toolName}`,
        optionId,
        optionKind: optionId,
        permissionCategory: category,
        matchStyle: category ? "category" : "exact",
      });
    }
    if (isAllowOptionId(optionId)) {
      return undefined;
    }
    return { block: true, reason: "Rejected by the user in Cesium." };
  }

  // ---------------------------------------------------------------------------
  // Event projection
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
    if (this.disposed) {
      return;
    }
    const batch = this.normalizer.handle(event as unknown as PiAgentRecord & { type: string });
    await this.applyBatch(batch);
    if (
      (event.type === "auto_retry_end" || event.type === "compaction_end") &&
      this.normalizer.isRunActive
    ) {
      this.scheduleSettleCheck();
    }
  }

  /**
   * Pi can stop a run without an `agent_end` (a cancelled retry wait, a failed
   * overflow compaction). If the session is quiet but the normalizer still
   * believes a run is active, close it so the conversation never sticks on
   * "running".
   */
  private scheduleSettleCheck(): void {
    setTimeout(() => {
      void this.enqueue(async () => {
        const session = this.session;
        if (
          this.disposed ||
          !session ||
          !this.normalizer.isRunActive ||
          session.isStreaming ||
          session.isRetrying ||
          session.isCompacting ||
          this.ui.hasPendingDialog
        ) {
          return;
        }
        await this.applyBatch(this.normalizer.endRun({ raw: { type: "settle_check" } }));
      });
    }, 250);
  }

  private async applyBatch(batch: PiAgentNormalizedBatch): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (batch.events.length > 0) {
      await this.callbacks.appendEvents(batch.events);
    }
    const hasPatch =
      batch.status !== undefined ||
      batch.lastError !== undefined ||
      batch.sessionName !== undefined ||
      batch.thinkingLevel !== undefined ||
      batch.runOutcome !== undefined;
    if (!hasPatch) {
      return;
    }
    if (batch.thinkingLevel && isPiAgentThinkingLevel(batch.thinkingLevel)) {
      this.configOptions = updateConfigOption(this.configOptions, "thinking_level", batch.thinkingLevel);
    }
    const configOptions = this.configOptions;
    const session = this.session;
    const dialogPending = this.ui.hasPendingDialog;
    await this.callbacks.updateConversation((current) => {
      const next: AgentConversationRecord = { ...current, configOptions };
      if (batch.status !== undefined) {
        // A pending dialog owns the awaiting_* status until it is answered.
        const keepAwaiting =
          dialogPending &&
          batch.status === "running" &&
          (current.status === "awaiting_permission" || current.status === "awaiting_question");
        if (!keepAwaiting) {
          next.status = batch.status;
        }
      }
      if (batch.lastError !== undefined) {
        next.lastError = batch.lastError;
      }
      if (batch.runOutcome) {
        next.pendingPermission = null;
        next.pendingQuestion = null;
        if (session) {
          next.providerSessionId = this.providerSessionRef(session);
        }
      }
      if (batch.sessionName && batch.sessionName.trim() && current.title !== batch.sessionName.trim()) {
        next.title = batch.sessionName.trim();
      }
      return next;
    });
  }

  /**
   * Mirror the live Pi session (model, thinking level, session file) onto the
   * conversation record so the composer always shows what Pi will actually use.
   */
  private async syncSessionState(input: {
    status?: AgentConversationRecord["status"];
    clearPending?: boolean;
  }): Promise<void> {
    const session = this.session;
    if (!session || this.disposed) {
      return;
    }
    const model = session.model;
    let configOptions = this.configOptions;
    if (model) {
      const value = `${model.provider}/${model.id}`;
      const display = `${session.modelRegistry.getProviderDisplayName(model.provider)}/${model.name ?? model.id}`;
      configOptions = ensureModelOption(configOptions, value, display);
    }
    configOptions = updateConfigOption(configOptions, "thinking_level", session.thinkingLevel);
    this.configOptions = configOptions;
    this.sessionId = this.providerSessionRef(session);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: this.providerSessionRef(session),
      configOptions,
      capabilities,
      config: model
        ? {
            ...current.config,
            modelId: `${model.provider}/${model.id}`,
            modelName: optionDisplayName(configOptions, "model", `${model.provider}/${model.id}`),
          }
        : current.config,
      ...(input.status ? { status: input.status } : {}),
      ...(input.clearPending
        ? { pendingPermission: null, pendingQuestion: null, lastError: null }
        : {}),
    }));
  }

  /**
   * Surface resource-loader diagnostics (broken extensions, unknown flags,
   * model fallbacks) in the conversation once, so a user whose custom
   * extension fails to load actually finds out. Re-attaching a runtime to the
   * same conversation must not repeat identical notices.
   */
  private async emitStartupNotices(
    notices: Array<{ level: "info" | "warning" | "error"; text: string }>
  ): Promise<void> {
    if (notices.length === 0) {
      return;
    }
    const conversationId = this.callbacks.conversation.id;
    let remembered = emittedStartupNotices.get(conversationId);
    if (!remembered) {
      if (emittedStartupNotices.size >= EMITTED_STARTUP_NOTICE_CONVERSATION_LIMIT) {
        const oldest = emittedStartupNotices.keys().next().value;
        if (oldest !== undefined) {
          emittedStartupNotices.delete(oldest);
        }
      }
      remembered = new Set<string>();
      emittedStartupNotices.set(conversationId, remembered);
    }
    const snapshot = await this.callbacks.readSnapshot().catch(() => null);
    const seen = new Set([
      ...remembered,
      ...(snapshot?.events ?? [])
        .filter((event) => event.kind === "system")
        .map((event) => (event.kind === "system" ? event.text : "")),
    ]);
    const events: AgentEventInput[] = [];
    for (const notice of notices) {
      if (seen.has(notice.text)) {
        continue;
      }
      seen.add(notice.text);
      remembered.add(notice.text);
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: notice.level,
        text: notice.text,
        raw: { source: "pi-agent-startup" },
      });
    }
    if (events.length > 0) {
      await this.callbacks.appendEvents(events);
    }
  }

  // ---------------------------------------------------------------------------
  // AgentSessionHandle
  // ---------------------------------------------------------------------------

  /**
   * Wait for a previous run to fully settle. Cesium flips the conversation to
   * idle when it sees `agent_end`, but Pi's loop may still be winding down or
   * compacting for a moment; prompting into that window would throw.
   */
  private async awaitQuiescence(session: AgentSession): Promise<boolean> {
    const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!session.isStreaming && !session.isCompacting && !session.isRetrying) {
        return true;
      }
      if (session.isStreaming) {
        await Promise.race([
          session.agent.waitForIdle(),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return !session.isStreaming;
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    const session = this.session;
    if (!session || this.disposed) {
      throw new Error("Pi Agent session is not initialized.");
    }

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      providerSessionId: this.providerSessionRef(session),
      configOptions: this.configOptions,
    }));

    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "pi-agent",
    });
    const promptText = appendAgentPluginPrompt(input.text, pluginAttachments);

    // Generic file attachments carry no inline data (saved to disk, surfaced
    // via the prompt text); only send real inline images.
    const images = (input.attachments ?? [])
      .filter((attachment) => attachment.mimeType.startsWith("image/") && attachment.data.length > 0)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }));

    const quiet = await this.awaitQuiescence(session);
    // Make sure the previous run has been fully projected before this prompt
    // claims the next user message echo as its own.
    await this.drain();
    // Extension slash commands run their handler and never echo a user
    // message, so any user turn that follows (pi.sendUserMessage) is injected.
    const isExtensionCommand = isPiExtensionCommand(session, promptText);
    if (!isExtensionCommand) {
      this.normalizer.beginPrompt();
    }
    try {
      await session.prompt(promptText, {
        ...(images.length > 0 ? { images } : {}),
        // Still streaming after the grace period: let Pi queue it rather than throw.
        ...(quiet ? {} : { streamingBehavior: "followUp" as const }),
      });
    } catch (error) {
      // Preflight failures (no model, missing API key, bad template) never
      // reach the agent loop, so no agent_end will report them.
      this.normalizer.abandonPrompt();
      const message = error instanceof Error ? error.message : "Pi Agent prompt failed.";
      await this.enqueue(async () => {
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
          pendingPermission: null,
          pendingQuestion: null,
          lastError: message,
        }));
      });
      throw error;
    }

    await this.drain();
    // A prompt swallowed by an extension `input` handler never echoes a user
    // message; drop the marker so a later injected turn is not mistaken for it.
    if (this.normalizer.hasPendingOwnedPrompt) {
      this.normalizer.abandonPrompt();
    }
    // Extension commands (`/mycommand`) and `input` handlers that swallow the
    // prompt never start an agent loop, so nothing else will flip us back.
    if (!this.normalizer.isRunActive && !this.ui.hasPendingDialog) {
      const current = this.callbacks.conversation;
      if (current.status === "running") {
        await this.enqueue(async () => {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "status",
              status: "idle",
              raw: { source: "pi-agent-prompt-handled-without-turn" },
            },
          ]);
          await this.callbacks.updateConversation((record) =>
            record.status === "running" ? { ...record, status: "idle" } : record
          );
        });
      }
    }
  }

  async cancel(): Promise<void> {
    const session = this.session;
    const wasActive = this.normalizer.isRunActive;
    if (session) {
      // Close the streaming bubble immediately; the terminal status arrives
      // with the aborted run's agent_end.
      const closing = this.normalizer.markCancelRequested();
      if (closing.length > 0) {
        await this.enqueue(() => this.callbacks.appendEvents(closing).then(() => undefined));
      }
      // Pending extension dialogs would otherwise hold the tool call open.
      await this.ui.cancelAll();
      session.abortRetry();
      session.abortCompaction();
      session.abortBash();
      await session.abort().catch(() => undefined);
      await this.drain();
    }

    if (wasActive && this.normalizer.isRunActive) {
      // Aborted outside the agent loop (e.g. during a retry back-off): no
      // agent_end will come, finish the run ourselves.
      await this.enqueue(() => this.applyBatch(this.normalizer.endRun({ forceStatus: "cancelled" })));
    }

    const outcome = this.normalizer.lastRunOutcome;
    if (!wasActive || outcome?.status !== "cancelled") {
      await this.enqueue(async () => {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "cancelled",
            detail: "Pi Agent turn cancelled.",
          },
        ]);
      });
    }
    await this.enqueue(() =>
      this.callbacks
        .updateConversation((current) => ({
          ...current,
          status: "cancelled",
          pendingPermission: null,
          pendingQuestion: null,
        }))
        .then(() => undefined)
    );
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
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

    const session = this.session;
    if (!session || this.disposed) {
      return;
    }
    if (configId === "model") {
      const parsed = parsePiModelValue(value);
      if (!parsed) {
        return;
      }
      // The live registry knows about extension-registered providers; refresh
      // so models.json edits made while the conversation is open apply too.
      session.modelRegistry.refresh();
      const model = session.modelRegistry.find(parsed.provider, parsed.modelId);
      if (!model) {
        await this.ui.notify(
          `Pi model "${value}" is not available in this agent home. Keeping ${
            session.model ? `${session.model.provider}/${session.model.id}` : "the current model"
          }.`,
          "warning"
        );
        await this.enqueue(() => this.syncSessionState({}));
        return;
      }
      try {
        await session.setModel(model);
      } catch (error) {
        await this.ui.notify(
          `Could not switch Pi model to "${value}": ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      await this.enqueue(() => this.syncSessionState({}));
      return;
    }
    if (configId === "thinking_level") {
      if (isPiAgentThinkingLevel(value)) {
        session.setThinkingLevel(value);
      }
      // Pi clamps to the model's supported levels; reflect the effective value.
      await this.enqueue(() => this.syncSessionState({}));
    }
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const handled = await this.ui.answerPermission(input);
    if (!handled) {
      // Stale card (e.g. after a restart): clear the record so the UI unblocks.
      await this.callbacks.updateConversation((current) =>
        current.pendingPermission?.requestId === input.requestId
          ? {
              ...current,
              pendingPermission: null,
              status: current.status === "awaiting_permission" ? "running" : current.status,
            }
          : current
      );
    }
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const handled = await this.ui.answerQuestion(input);
    if (!handled) {
      await this.callbacks.updateConversation((current) =>
        current.pendingQuestion?.questionId === input.questionId
          ? {
              ...current,
              pendingQuestion: null,
              status: current.status === "awaiting_question" ? "running" : current.status,
            }
          : current
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const session = this.session;
    this.session = null;
    if (!session) {
      return;
    }
    await this.ui.cancelAll().catch(() => undefined);
    try {
      // Give extensions their shutdown hook (auto-commit-on-exit style) and
      // make sure Pi's settings writes hit disk before the process moves on.
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
      await session.settingsManager.flush();
    } catch (error) {
      console.warn(
        "[pi-agent] session shutdown hook failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    session.dispose();
  }
}

export function createPiAgentProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      return PiAgentSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
      });
    },
    async loadSession(callbacks, providerSessionId) {
      return PiAgentSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
      });
    },
  };
}

// Re-export for tests that assert path helpers without importing settings.
export { getPiAgentDir };
