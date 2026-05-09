import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getClaudeCodeSdkProxyApiKey,
  getClaudeCodeSdkProxyBaseUrl,
  hasClaudeCodeSdkAuthConfig,
  hasClaudeCodeSdkProxyConfig,
} from "../claude-code-sdk-credentials.js";
import {
  claudeToolUseToAgentEvent,
  planEntriesFromClaudeToolPayload,
  streamEventKind,
  textDeltaFromClaudeStreamEvent,
  textFromClaudeAssistantMessage,
  thinkingTextFromClaudeAssistantMessage,
  toolResultFromClaudeUserMessage,
  toolUsesFromClaudeAssistantMessage,
} from "./claude-code-sdk-normalize.js";
import { getClaudeCodeSdkCapabilities } from "./claude-code-sdk-capabilities.js";
import {
  findPrimaryModeConfigOption,
  findPrimaryModelConfigOption,
} from "./config-option-utils.js";
import {
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../global-settings-store.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentPermissionOptionKind,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";

type ClaudeCodeSdkHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  providerSessionId?: string | null;
};

type PendingPermission = {
  resolve: (result: PermissionResult) => void;
  suggestions?: unknown;
  toolName: string;
  toolKey: string;
  toolLabel: string;
};

const capabilities = getClaudeCodeSdkCapabilities();

const TOOL_PROFILES: Record<string, string[] | { type: "preset"; preset: "claude_code" }> = {
  standard: ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "TodoWrite", "Agent", "AskUserQuestion"],
  "safe-readonly": ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"],
  full: { type: "preset", preset: "claude_code" },
};

const PROXY_SYSTEM_APPEND = [
  "OpenCursor displays tool calls as structured cards.",
  "For codebase searches, prefer Grep or Glob when available.",
  "If search must use Bash, use ripgrep (`rg`) with exclusions for node_modules, .git, .next, and .docker.",
  "Do not run unbounded recursive `grep -r` over the workspace.",
].join(" ");

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
  const value = conversation.config.modelId || modelOption?.currentValue || "";
  return value && value !== "auto" ? value : undefined;
}

function optionDisplayName(configOptions: AgentConfigOption[], configId: string, value: string): string {
  return configOptions
    .find((option) => option.id === configId)
    ?.options.find((option) => option.value === value)?.name ?? value;
}

function permissionModeForConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): PermissionMode {
  const modeOption = findPrimaryModeConfigOption(configOptions);
  const mode = modeOption?.currentValue || conversation.config.mode;
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
  const raw = Number.parseInt(optionValue(configOptions, "max_turns", "20"), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function maxBudgetForConfig(configOptions: AgentConfigOption[]): number | undefined {
  const raw = Number.parseFloat(optionValue(configOptions, "max_budget_usd", ""));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function toolProfileForConfig(configOptions: AgentConfigOption[]): Options["tools"] {
  const profile = optionValue(configOptions, "tool_profile", "standard");
  if (profile === "plan") {
    return [];
  }
  return TOOL_PROFILES[profile] ?? TOOL_PROFILES.standard;
}

function thinkingForConfig(configOptions: AgentConfigOption[]): Options["thinking"] | undefined {
  const value = optionValue(configOptions, "thinking", "adaptive");
  if (value === "disabled") {
    return { type: "disabled" };
  }
  if (value === "adaptive") {
    return { type: "adaptive" };
  }
  return undefined;
}

function claudeCodeSdkEnv(): NodeJS.ProcessEnv {
  const proxyApiKey = getClaudeCodeSdkProxyApiKey();
  const proxyBaseUrl = getClaudeCodeSdkProxyBaseUrl();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(proxyApiKey ? { ANTHROPIC_API_KEY: proxyApiKey } : {}),
    ...(proxyBaseUrl ? { ANTHROPIC_BASE_URL: proxyBaseUrl, CLAUDE_CODE_API_BASE_URL: proxyBaseUrl } : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP:
      process.env.CLAUDE_AGENT_SDK_CLIENT_APP ?? "opencursor/claude-code-sdk",
  };
  if (hasClaudeCodeSdkProxyConfig()) {
    delete env.ANTHROPIC_AUTH_TOKEN;
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

function permissionDecisionFromOption(optionId: string | undefined): "allow" | "reject" {
  return optionId === "allow_once" || optionId === "allow_always" ? "allow" : "reject";
}

function permissionToolKey(toolName: string, input: Record<string, unknown>): string {
  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.command === "string"
          ? input.command
          : "";
  return `${toolName}:${path}`.slice(0, 260);
}

function unsafeRecursiveGrepMessage(toolName: string, input: Record<string, unknown>): string | null {
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

class ClaudeCodeSdkSessionHandle implements AgentSessionHandle {
  readonly capabilities = capabilities;
  configOptions: AgentConfigOption[];
  sessionId: string;

  private activeQuery: Query | null = null;
  private activeAbortController: AbortController | null = null;
  private disposed = false;
  private lastSdkApiError: string | null = null;
  private readonly activeToolPayloads = new Map<string, { name?: string; input?: unknown }>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private constructor(
    private readonly callbacks: AgentRuntimeCallbacks,
    private readonly backend: AgentBackendInfo,
    configOptions: AgentConfigOption[],
    providerSessionId?: string | null
  ) {
    this.sessionId = providerSessionId || `claude-code-sdk-pending-${callbacks.conversation.id}`;
    this.configOptions = configOptions;
  }

  static async create(input: ClaudeCodeSdkHandleInput): Promise<ClaudeCodeSdkSessionHandle> {
    if (!hasClaudeCodeSdkAuthConfig()) {
      throw new Error(
        "Claude Code SDK auth is not configured. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or a supported Claude provider env var."
      );
    }
    const configOptions = withCurrentConfig(input.configOptions, input.callbacks.conversation);
    const handle = new ClaudeCodeSdkSessionHandle(
      input.callbacks,
      input.backend,
      configOptions,
      input.providerSessionId
    );
    await input.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: input.providerSessionId ?? current.providerSessionId,
      configOptions,
      capabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
    return handle;
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Claude Code SDK session has been disposed.");
    }
    if (input.attachments?.length) {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: "Claude Code SDK image attachments are not enabled yet; sending the text prompt only.",
        },
      ]);
    }
    const assistantMessageId = `claude-code-sdk-assistant-${randomUUID()}`;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.lastSdkApiError = null;
    this.activeToolPayloads.clear();
    let emittedAssistantText = false;
    let emittedAssistantEnd = false;

    const options = this.buildQueryOptions(abortController);
    const active = query({ prompt: input.text, options });
    this.activeQuery = active;

    try {
      for await (const message of active) {
        if (this.disposed) {
          break;
        }
        await this.handleSdkMessage(message, assistantMessageId, {
          hasAssistantText: () => emittedAssistantText,
          markAssistantText: () => {
            emittedAssistantText = true;
          },
          markAssistantEnd: () => {
            emittedAssistantEnd = true;
          },
        });
      }
      if (!emittedAssistantText && (this.lastSdkApiError || !emittedAssistantEnd)) {
        const failureDetail =
          this.lastSdkApiError ??
          "Claude Code SDK completed without assistant output. Check SDK auth, base URL, and model route availability.";
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "error",
            text: failureDetail,
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "failed",
            detail: failureDetail,
          },
        ]);
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "failed",
          pendingPermission: null,
          lastError: failureDetail,
          providerSessionId: this.sessionId,
        }));
        return;
      }
      if (!emittedAssistantEnd) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_end",
            messageId: assistantMessageId,
            stopReason: "complete",
          },
        ]);
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: emittedAssistantText ? "Claude Code SDK turn complete." : "Claude Code SDK completed.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
        providerSessionId: this.sessionId,
      }));
    } catch (error) {
      const cancelled =
        abortController.signal.aborted ||
        (error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message)));
      const message = error instanceof Error ? error.message : "Claude Code SDK prompt failed.";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: cancelled ? "warning" : "error",
          text: cancelled ? "Claude Code SDK turn cancelled." : message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: cancelled ? "cancelled" : "failed",
          detail: cancelled ? "Cancelled by the client." : message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        pendingPermission: null,
        lastError: cancelled ? null : message,
      }));
      if (!cancelled) {
        throw error;
      }
    } finally {
      this.activeQuery = null;
      this.activeAbortController = null;
    }
  }

  private buildQueryOptions(abortController: AbortController): Options {
    const permissionMode = permissionModeForConfig(this.callbacks.conversation, this.configOptions);
    const proxyMode = hasClaudeCodeSdkProxyConfig();
    return {
      abortController,
      cwd: this.callbacks.workspace.root,
      env: claudeCodeSdkEnv(),
      includePartialMessages: true,
      forwardSubagentText: true,
      persistSession: !proxyMode && optionValue(this.configOptions, "session_persistence", "enabled") !== "disabled",
      model: selectedModel(this.callbacks.conversation, this.configOptions),
      permissionMode,
      allowDangerouslySkipPermissions:
        permissionMode === "bypassPermissions" &&
        process.env.OPENCURSOR_CLAUDE_CODE_SDK_ALLOW_BYPASS === "1",
      tools: toolProfileForConfig(this.configOptions),
      systemPrompt: proxyMode
        ? { type: "preset", preset: "claude_code", append: PROXY_SYSTEM_APPEND }
        : undefined,
      canUseTool: this.canUseTool,
      effort: effortForConfig(this.configOptions),
      thinking: thinkingForConfig(this.configOptions),
      maxTurns: maxTurnsForConfig(this.configOptions),
      maxBudgetUsd: maxBudgetForConfig(this.configOptions),
      ...(proxyMode
        ? {
            extraArgs: {
              bare: null,
              "no-session-persistence": null,
              "setting-sources": "local",
            },
            settingSources: [],
          }
        : {}),
      ...(proxyMode || this.sessionId.startsWith("claude-code-sdk-pending-") ? {} : { resume: this.sessionId }),
    };
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = options.toolUseID || randomUUID();
    const unsafeMessage = unsafeRecursiveGrepMessage(toolName, input);
    if (unsafeMessage) {
      return { behavior: "deny", message: unsafeMessage };
    }
    const toolKey = permissionToolKey(toolName, input);
    const toolLabel = options.displayName || toolName;
    const title = options.title || `${toolLabel} permission`;
    const detail =
      options.description ||
      options.decisionReason ||
      (typeof input.command === "string" ? input.command : JSON.stringify(input));

    const settings = await getGlobalSettings().catch(() => undefined);
    const remembered = settings?.agents.rememberedPermissions.find(
      (rule) =>
        rule.workspaceId === this.callbacks.workspace.id &&
        rule.backendId === this.backend.id &&
        rule.toolKey === toolKey
    );
    if (remembered) {
      return remembered.decision === "allow"
        ? { behavior: "allow", updatedPermissions: options.suggestions }
        : { behavior: "deny", message: `Denied by remembered rule for ${remembered.toolLabel}.` };
    }
    if (settings?.agents.autoAcceptAllAgentPermissions) {
      return { behavior: "allow" };
    }

    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_request",
        requestId,
        title,
        detail,
        toolCallId: requestId,
        options: permissionOptions(),
        raw: { toolName, input, options },
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
        title,
        detail,
        options: permissionOptions(),
      },
    }));

    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        suggestions: options.suggestions,
        toolName,
        toolKey,
        toolLabel,
      });
    });
  };

  private async handleSdkMessage(
    message: unknown,
    assistantMessageId: string,
    flags: { hasAssistantText: () => boolean; markAssistantText: () => void; markAssistantEnd: () => void }
  ): Promise<void> {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      await this.callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: sessionId,
      }));
    }

    if (record.type === "system") {
      await this.handleSystemMessage(record);
      return;
    }

    if (record.type === "stream_event") {
      const kind = streamEventKind(message);
      const text = textDeltaFromClaudeStreamEvent(message);
      if (text) {
        flags.markAssistantText();
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: kind === "thinking" ? "reasoning" : "assistant_message_chunk",
            messageId: kind === "thinking" ? `${assistantMessageId}-thinking` : assistantMessageId,
            text,
            raw: message,
          },
        ]);
      }
      if (kind === "stop") {
        flags.markAssistantEnd();
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_end",
            messageId: assistantMessageId,
            stopReason: "message_stop",
            raw: message,
          },
        ]);
      }
      return;
    }

    if (record.type === "assistant") {
      const events: AgentEventInput[] = [];
      const text = textFromClaudeAssistantMessage(message);
      if (text) {
        flags.markAssistantText();
        events.push({
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId: assistantMessageId,
          text,
          raw: message,
        });
      }
      const thinking = thinkingTextFromClaudeAssistantMessage(message);
      if (thinking) {
        events.push({
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "reasoning",
          messageId: `${assistantMessageId}-thinking`,
          text: thinking,
          raw: message,
        });
      }
      for (const tool of toolUsesFromClaudeAssistantMessage(message)) {
        if (tool.id) {
          this.activeToolPayloads.set(tool.id, { name: tool.name, input: tool.input });
        }
        events.push(
          claudeToolUseToAgentEvent({
            tool,
            conversationId: this.callbacks.conversation.id,
            eventId: randomUUID(),
            status: "in_progress",
          })
        );
        const entries = planEntriesFromClaudeToolPayload(tool.input);
        if (entries.length > 0) {
          events.push({
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "plan",
            planId: `${this.callbacks.conversation.id}-claude-code-sdk-todos`,
            entries,
            raw: tool,
          });
        }
      }
      if (events.length > 0) {
        await this.callbacks.appendEvents(events);
      }
      return;
    }

    if (record.type === "user") {
      const events: AgentEventInput[] = [];
      for (const tool of toolResultFromClaudeUserMessage(message)) {
        const activeTool = tool.id ? this.activeToolPayloads.get(tool.id) : undefined;
        const normalizedTool = {
          ...tool,
          ...(tool.name ? {} : { name: activeTool?.name }),
          ...(tool.input ? {} : { input: activeTool?.input }),
        };
        events.push(
          claudeToolUseToAgentEvent({
            tool: normalizedTool,
            conversationId: this.callbacks.conversation.id,
            eventId: randomUUID(),
            status: tool.isError ? "failed" : "completed",
          })
        );
        if (tool.id) {
          this.activeToolPayloads.delete(tool.id);
        }
      }
      if (events.length > 0) {
        await this.callbacks.appendEvents(events);
      }
      return;
    }

    if (record.type === "tool_progress") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: String(record.tool_use_id ?? randomUUID()),
          title: typeof record.tool_name === "string" ? record.tool_name : "Tool",
          toolKind: "tool",
          status: "in_progress",
          detail:
            typeof record.elapsed_time_seconds === "number"
              ? `${record.elapsed_time_seconds.toFixed(1)}s elapsed`
              : undefined,
          raw: message,
        },
      ]);
      return;
    }

    if (record.type === "tool_use_summary") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "info",
          text: typeof record.summary === "string" ? record.summary : "Tool summary",
          raw: message,
        },
      ]);
      return;
    }

    if (record.type === "result") {
      const success = record.subtype === "success";
      if (success) {
        this.lastSdkApiError = null;
      }
      if (success && !flags.hasAssistantText() && typeof record.result === "string" && record.result.trim()) {
        flags.markAssistantText();
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: assistantMessageId,
            text: record.result,
            raw: message,
          },
        ]);
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: success ? "idle" : "failed",
          detail: typeof record.subtype === "string" ? record.subtype : "result",
          raw: message,
        },
      ]);
      if (!success) {
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "failed",
          lastError: typeof record.subtype === "string" ? record.subtype : "Claude Code SDK failed.",
        }));
      }
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "warning",
        text:
          typeof record.type === "string"
            ? `Claude Code SDK emitted unhandled message type: ${record.type}`
            : "Claude Code SDK emitted an unhandled message.",
        raw: message,
      },
    ]);
  }

  private async handleSystemMessage(record: Record<string, unknown>): Promise<void> {
    if (record.subtype === "init") {
      const model = typeof record.model === "string" ? record.model : "Claude";
      const permissionMode = typeof record.permissionMode === "string" ? record.permissionMode : "default";
      const tools = Array.isArray(record.tools) ? record.tools.length : 0;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: `${model} · ${permissionMode} · ${tools} tools`,
          raw: record,
        },
      ]);
      return;
    }
    if (record.subtype === "api_retry") {
      const status = typeof record.error_status === "number" ? record.error_status : undefined;
      const error = typeof record.error === "string" ? record.error : "API request failed";
      const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
      this.lastSdkApiError = status
        ? `Claude Code SDK API error ${status}: ${error}`
        : `Claude Code SDK API error: ${error}`;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: attempt ? `${this.lastSdkApiError} (retry ${attempt})` : this.lastSdkApiError,
          raw: record,
        },
      ]);
      return;
    }
    if (record.subtype === "status") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: record.status === null ? "running" : "running",
          detail:
            typeof record.status === "string"
              ? record.status
              : typeof record.compact_result === "string"
                ? `compact ${record.compact_result}`
                : undefined,
          raw: record,
        },
      ]);
      return;
    }
    if (
      record.subtype === "task_started" ||
      record.subtype === "task_progress" ||
      record.subtype === "task_updated" ||
      record.subtype === "task_notification"
    ) {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: String(record.tool_use_id ?? record.task_id ?? randomUUID()),
          title: "Task",
          toolKind: "task",
          status:
            record.status === "completed"
              ? "completed"
              : record.status === "failed" || record.status === "killed"
                ? "failed"
                : "in_progress",
          detail:
            typeof record.description === "string"
              ? record.description
              : typeof record.summary === "string"
                ? record.summary
                : typeof record.output_file === "string"
                  ? record.output_file
                  : undefined,
          raw: record,
        },
      ]);
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "info",
        text: typeof record.subtype === "string" ? `Claude Code SDK: ${record.subtype}` : "Claude Code SDK system event",
        raw: record,
      },
    ]);
  }

  async cancel(): Promise<void> {
    this.activeAbortController?.abort();
    await this.activeQuery?.interrupt().catch(() => undefined);
    this.activeQuery?.close();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Claude Code SDK turn cancelled by the client.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
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
    pending.resolve(
      decision === "allow"
        ? {
            behavior: "allow",
            updatedPermissions:
              optionId === "allow_always" && Array.isArray(pending.suggestions)
                ? (pending.suggestions as never)
                : undefined,
          }
        : { behavior: "deny", message: "Rejected by user.", interrupt: input.cancelled }
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeAbortController?.abort();
    this.activeQuery?.close();
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({
        behavior: "deny",
        message: "Session disposed before permission was answered.",
        interrupt: true,
      });
      this.pendingPermissions.delete(requestId);
    }
  }
}

export function createClaudeCodeSdkProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    startSession(callbacks) {
      return ClaudeCodeSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
      });
    },
    loadSession(callbacks, providerSessionId) {
      return ClaudeCodeSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
      });
    },
  };
}
