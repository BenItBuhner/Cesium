/**
 * The in-browser Cesium agent harness: prompt → turn loop → streamed events,
 * with permission gating, structured questions, cancel/retry, and prompt
 * queueing - persisting the same event log shapes as the server harness.
 */
import type {
  AgentConversationRecord,
  AgentConversationSnapshotHead,
  AgentPendingPermission,
  AgentPermissionCategory,
  WorkspaceRecord,
} from "@cesium/core";
import {
  buildCesiumBaseSystemPrompt,
  CESIUM_TOOL_DEFINITIONS,
  normalizeCesiumMode,
  resolveCesiumModeToolPolicy,
} from "@cesium/core";
import type { Vfs } from "../vfs";
import type { BrowserGit } from "../git/browser-git";
import type { ShellRuntime } from "../shell/runtime";
import type { ConversationStore } from "../stores/conversations";
import type { BrowserModeId, SettingsStore } from "../stores/settings";
import { BROWSER_MODE_IDS } from "../stores/settings";
import { newEventId } from "../stores/conversations";
import type { BrowserAgentRuntime, PromptInput } from "../routes/agent-routes";
import { streamModelTurn, type AdapterToolDefinition } from "./adapters";
import { buildHistoryFromEvents } from "./history";
import { buildBrowserMachineReminder, formatGitSummary } from "./reminder";
import { BrowserToolExecutor } from "./tools";
import { readDoc, writeDoc } from "../stores/kv-docs";

const MAX_ITERATIONS = 40;
const STREAM_FLUSH_MS = 250;
const STREAM_FLUSH_CHARS = 1200;

const PERMISSION_BY_TOOL: Record<string, AgentPermissionCategory> = {
  write_file: "editFile",
  edit_file: "editFile",
  terminal: "terminal",
  switch_mode: "switchMode",
  call_mcp_tool: "mcpCall",
};

const REMEMBERED_PERMISSIONS_KEY = "settings:remembered-permissions";

type RememberedRule = {
  id: string;
  category: AgentPermissionCategory;
  toolKey: string;
  createdAt: number;
};

/** Extra tool definitions the browser harness adds to the shared catalog. */
const EXTRA_TOOLS: AdapterToolDefinition[] = [
  {
    name: "write_file",
    description: "Create or overwrite a workspace file with the provided content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "switch_branch",
    description: "Switch the workspace to another git branch (creates it if missing).",
    parameters: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
    },
  },
];

const BROWSER_TOOL_NAMES = new Set([
  "read_file",
  "grep",
  "edit_file",
  "write_file",
  "terminal",
  "todo",
  "ask_question",
  "wait",
  "switch_branch",
  "switch_mode",
]);

type TurnState = {
  abort: AbortController;
  cancelled: boolean;
};

type PendingGate = {
  resolve: (value: { approved: boolean; always?: boolean; answer?: string }) => void;
};

export class BrowserAgentHarness implements BrowserAgentRuntime {
  private readonly tools: BrowserToolExecutor;
  private readonly turns = new Map<string, TurnState>();
  private readonly permissionGates = new Map<string, PendingGate>();
  private readonly questionGates = new Map<string, PendingGate>();

  constructor(
    private readonly deps: {
      vfs: Vfs;
      conversations: ConversationStore;
      settings: SettingsStore;
      git: BrowserGit;
      shell: ShellRuntime;
      installedPacks?: () => string[];
    }
  ) {
    this.tools = new BrowserToolExecutor(deps.vfs, deps.git, deps.shell, async () => {
      const prefs = await deps.settings.getAgentPrefs();
      return prefs.limits.waitMaxSeconds;
    });
  }

  /**
   * Tool schemas advertised for a mode: the browser tool set filtered by the
   * shared Cesium mode policy, so Ask stays read-only and Plan hides direct
   * edit tools exactly like the server harness.
   */
  private toolDefinitions(mode: string): AdapterToolDefinition[] {
    const shared = CESIUM_TOOL_DEFINITIONS.filter((tool) => BROWSER_TOOL_NAMES.has(tool.name)).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })
    );
    return [...shared, ...EXTRA_TOOLS].filter(
      (tool) => resolveCesiumModeToolPolicy({ mode, toolName: tool.name }).allowed
    );
  }

  async promptConversation(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: PromptInput
  ): Promise<AgentConversationSnapshotHead> {
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    if (
      record.status === "running" ||
      record.status === "awaiting_permission" ||
      record.status === "awaiting_question"
    ) {
      await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
        ...current,
        queuedPrompts: [
          ...current.queuedPrompts,
          {
            id: crypto.randomUUID(),
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
            ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
          },
        ],
      }));
      const head = await this.deps.conversations.readSnapshotHead(workspace.id, conversationId);
      if (!head) throw new Error(`Unknown conversation: ${conversationId}`);
      return head;
    }

    await this.beginTurn(workspace, conversationId, input);
    const head = await this.deps.conversations.readSnapshotHead(workspace.id, conversationId);
    if (!head) throw new Error(`Unknown conversation: ${conversationId}`);
    return head;
  }

  private async beginTurn(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: PromptInput
  ): Promise<void> {
    const messageId = input.clientMessageId ?? crypto.randomUUID();
    await this.deps.conversations.appendEvents(workspace.id, conversationId, [
      {
        eventId: input.clientEventId ?? newEventId(),
        conversationId,
        kind: "user_message",
        messageId,
        content: input.text,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      },
    ]);
    await this.appendReminder(workspace, conversationId, messageId);
    await this.deps.conversations.appendEvents(workspace.id, conversationId, [
      {
        eventId: newEventId(),
        conversationId,
        kind: "status",
        status: "running",
        detail: "Cesium is starting…",
      },
    ]);
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "running",
      lastError: null,
      settledAt: null,
      settledUntil: null,
      updatedAt: Date.now(),
    }));
    void this.runTurn(workspace, conversationId).catch((error) => {
      console.error("[browser-machine] turn crashed:", error);
    });
  }

  private async appendReminder(
    workspace: WorkspaceRecord,
    conversationId: string,
    targetMessageId: string
  ): Promise<void> {
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record) return;
    const status = await this.deps.git.status(workspace).catch(() => null);
    const reminder = buildBrowserMachineReminder({
      workspace,
      mode: record.config.mode,
      modelName: record.config.modelName,
      gitSummary: formatGitSummary({
        isGitRepo: status?.isGitRepo ?? false,
        branch: status?.currentBranch,
        dirty: status?.dirty,
      }),
      shellCommands: this.deps.shell.listCommands(),
      installedPacks: this.deps.installedPacks?.() ?? [],
      dateLabel: new Date().toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    });
    await this.deps.conversations.appendEvents(workspace.id, conversationId, [
      {
        eventId: newEventId(),
        conversationId,
        kind: "system_reminder",
        reminderId: crypto.randomUUID(),
        targetMessageId,
        reason: "mode",
        text: reminder,
      },
    ]);
  }

  private async runTurn(workspace: WorkspaceRecord, conversationId: string): Promise<void> {
    const turn: TurnState = { abort: new AbortController(), cancelled: false };
    this.turns.set(conversationId, turn);
    const append = (events: Parameters<ConversationStore["appendEvents"]>[2]) =>
      this.deps.conversations.appendEvents(workspace.id, conversationId, events);
    const fail = async (message: string): Promise<void> => {
      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "system",
          level: "error",
          text: message,
        },
      ]);
      await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
        ...current,
        status: "failed",
        lastError: message,
        pendingPermission: null,
        pendingQuestion: null,
      }));
    };

    try {
      const record = await this.deps.conversations.get(workspace.id, conversationId);
      if (!record) return;
      const auth = await this.deps.settings.resolveModelAuth(record.config.modelId);
      if (!auth || !auth.provider.apiKey) {
        await fail(
          `No API key configured for model "${record.config.modelId}". Open Settings → Agents → Cesium Agent on this browser machine and add a provider key (or a custom OpenAI-compatible provider), then retry.`
        );
        return;
      }

      const systemPrompt = buildCesiumBaseSystemPrompt();

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        if (turn.cancelled) return;
        // Re-resolve the mode each iteration so switch_mode mid-turn swaps
        // the advertised tool set immediately (server parity).
        const liveRecord = await this.deps.conversations.get(workspace.id, conversationId);
        const mode = normalizeCesiumMode(liveRecord?.config.mode ?? record.config.mode);
        const toolDefinitions = this.toolDefinitions(mode);
        const events = await this.deps.conversations.readEvents(conversationId);
        const messages = buildHistoryFromEvents({
          events,
          systemPrompt,
          supportsImages: auth.model.supportsImages ?? false,
        });

        // Streaming text/reasoning buffers flushed as chunk events.
        const assistantMessageId = crypto.randomUUID();
        let textBuffer = "";
        let reasoningBuffer = "";
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        let flushChain = Promise.resolve();
        const flush = (): Promise<void> => {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          const text = textBuffer;
          const reasoning = reasoningBuffer;
          textBuffer = "";
          reasoningBuffer = "";
          if (!text && !reasoning) return flushChain;
          flushChain = flushChain.then(async () => {
            const batch: Parameters<typeof append>[0] = [];
            if (reasoning) {
              batch.push({
                eventId: newEventId(),
                conversationId,
                kind: "reasoning",
                messageId: assistantMessageId,
                text: reasoning,
              });
            }
            if (text) {
              batch.push({
                eventId: newEventId(),
                conversationId,
                kind: "assistant_message_chunk",
                messageId: assistantMessageId,
                text,
              });
            }
            await append(batch);
          });
          return flushChain;
        };
        const scheduleFlush = (): void => {
          if (textBuffer.length + reasoningBuffer.length >= STREAM_FLUSH_CHARS) {
            void flush();
            return;
          }
          if (!flushTimer) {
            flushTimer = setTimeout(() => void flush(), STREAM_FLUSH_MS);
          }
        };

        let result;
        try {
          result = await streamModelTurn(
            {
              apiKind: auth.model.apiKind ?? auth.provider.apiKind,
              baseUrl: auth.provider.baseUrl,
              apiKey: auth.provider.apiKey,
              modelId: auth.model.modelId,
              messages,
              tools: toolDefinitions,
              signal: turn.abort.signal,
            },
            {
              onTextDelta: (text) => {
                textBuffer += text;
                scheduleFlush();
              },
              onReasoningDelta: (text) => {
                reasoningBuffer += text;
                scheduleFlush();
              },
            }
          );
        } catch (error) {
          await flush();
          if (turn.cancelled) return;
          await fail(
            error instanceof Error
              ? `Model call failed: ${error.message}`
              : "Model call failed."
          );
          return;
        }
        await flush();

        if (result.toolCalls.length === 0) {
          await append([
            {
              eventId: newEventId(),
              conversationId,
              kind: "assistant_message_end",
              messageId: assistantMessageId,
              stopReason: result.stopReason ?? undefined,
            },
          ]);
          break;
        }

        for (const toolCall of result.toolCalls) {
          if (turn.cancelled) return;
          const executed = await this.executeToolCall(workspace, conversationId, turn, {
            id: toolCall.id,
            name: toolCall.name,
            argsJson: toolCall.argsJson,
          });
          if (!executed) {
            // Permission rejected turn continues so the model can adapt; a
            // cancelled turn stops entirely.
            if (turn.cancelled) return;
          }
        }
      }

      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "status",
          status: "idle",
          detail: "Cesium turn complete.",
        },
      ]);
      await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        pendingQuestion: null,
      }));
      await this.deliverQueuedPrompt(workspace, conversationId);
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.turns.delete(conversationId);
    }
  }

  private async deliverQueuedPrompt(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<void> {
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record || record.queuedPrompts.length === 0 || record.status !== "idle") return;
    const [next, ...rest] = record.queuedPrompts;
    if (!next) return;
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      queuedPrompts: rest,
    }));
    await this.beginTurn(workspace, conversationId, {
      text: next.text,
      attachments: next.attachments,
      clientEventId: next.clientEventId,
      clientMessageId: next.clientMessageId,
    });
  }

  /** Global settings switch: answer every permission prompt with Allow. */
  private async autoAcceptAllPermissions(): Promise<boolean> {
    const globalSettings = await this.deps.settings.getGlobalSettings().catch(() => null);
    const agents =
      globalSettings && typeof globalSettings.agents === "object" && globalSettings.agents
        ? (globalSettings.agents as Record<string, unknown>)
        : null;
    return agents?.autoAcceptAllAgentPermissions === true;
  }

  private async checkRemembered(category: AgentPermissionCategory, toolKey: string): Promise<boolean> {
    const rules = (await readDoc<RememberedRule[]>(REMEMBERED_PERMISSIONS_KEY)) ?? [];
    return rules.some(
      (rule) => rule.category === category && (rule.toolKey === toolKey || rule.toolKey === "*")
    );
  }

  private async rememberRule(category: AgentPermissionCategory, toolKey: string): Promise<void> {
    const rules = (await readDoc<RememberedRule[]>(REMEMBERED_PERMISSIONS_KEY)) ?? [];
    if (rules.some((rule) => rule.category === category && rule.toolKey === toolKey)) return;
    rules.push({ id: crypto.randomUUID(), category, toolKey, createdAt: Date.now() });
    await writeDoc(REMEMBERED_PERMISSIONS_KEY, rules);
  }

  /** Returns false when the tool was rejected/cancelled. */
  private async executeToolCall(
    workspace: WorkspaceRecord,
    conversationId: string,
    turn: TurnState,
    toolCall: { id: string; name: string; argsJson: string }
  ): Promise<boolean> {
    const append = (events: Parameters<ConversationStore["appendEvents"]>[2]) =>
      this.deps.conversations.appendEvents(workspace.id, conversationId, events);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.argsJson || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
    const toolCallId = crypto.randomUUID();
    const title = this.toolTitle(toolCall.name, args);
    await append([
      {
        eventId: newEventId(),
        conversationId,
        kind: "tool_call",
        toolCallId,
        title,
        toolKind: this.toolKind(toolCall.name),
        status: "in_progress",
        detail: this.toolDetail(toolCall.name, args),
        raw: { callId: toolCall.id, name: toolCall.name, argsJson: toolCall.argsJson },
      },
    ]);

    // ask_question is a first-class interactive tool, not a permission gate.
    if (toolCall.name === "ask_question") {
      return this.runAskQuestion(workspace, conversationId, turn, {
        toolCallId,
        callId: toolCall.id,
        args,
      });
    }

    // Mode policy gate (shared with the server harness): a tool the active
    // mode forbids fails with the policy reason so the model can adapt.
    const activeRecord = await this.deps.conversations.get(workspace.id, conversationId);
    const activeMode = normalizeCesiumMode(activeRecord?.config.mode);
    const modePolicy = resolveCesiumModeToolPolicy({
      mode: activeMode,
      toolName: toolCall.name,
    });
    if (!modePolicy.allowed) {
      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "tool_call_update",
          toolCallId,
          status: "failed",
          detail: "Blocked by mode policy",
          raw: {
            callId: toolCall.id,
            result: modePolicy.reason ?? `Tool ${toolCall.name} is blocked in ${activeMode} mode.`,
          },
        },
      ]);
      return true;
    }

    const category = PERMISSION_BY_TOOL[toolCall.name];
    if (category) {
      // Settings cascade (server parity): tool permission deny blocks
      // outright, allow skips the prompt; otherwise remembered rules, the
      // global auto-approve switch, then an interactive prompt.
      const prefs = await this.deps.settings.getAgentPrefs();
      const decision = prefs.toolPermissions[category];
      if (decision === "deny") {
        await append([
          {
            eventId: newEventId(),
            conversationId,
            kind: "tool_call_update",
            toolCallId,
            status: "cancelled",
            detail: "Blocked by permission settings",
            raw: {
              callId: toolCall.id,
              result: `${title} blocked by Cesium permission settings.`,
            },
          },
        ]);
        return false;
      }
      if (decision !== "allow") {
        const remembered = await this.checkRemembered(category, toolCall.name);
        const autoAccept = !remembered && (await this.autoAcceptAllPermissions());
        if (!remembered && !autoAccept) {
          const approved = await this.requestPermission(workspace, conversationId, turn, {
            toolCallId,
            category,
            toolName: toolCall.name,
            title,
            detail: this.toolDetail(toolCall.name, args),
          });
          if (!approved) {
            await append([
              {
                eventId: newEventId(),
                conversationId,
                kind: "tool_call_update",
                toolCallId,
                status: "cancelled",
                detail: "Rejected by user",
                raw: { callId: toolCall.id, result: "The user rejected this tool call." },
              },
            ]);
            return false;
          }
        }
      }
    }

    if (turn.cancelled) {
      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "tool_call_update",
          toolCallId,
          status: "cancelled",
          raw: { callId: toolCall.id, result: "Cancelled." },
        },
      ]);
      return false;
    }

    // switch_mode is handled by the harness itself: the target must be a
    // mode this engine implements and one the user left enabled in Settings.
    if (toolCall.name === "switch_mode") {
      const rawTarget = args.target_mode ?? args.mode ?? args.target;
      const target = normalizeCesiumMode(typeof rawTarget === "string" ? rawTarget : "agent");
      const prefs = await this.deps.settings.getAgentPrefs();
      const supported = BROWSER_MODE_IDS.includes(target as BrowserModeId);
      const enabled = supported && prefs.modes.enabled[target as BrowserModeId];
      if (!supported || !enabled) {
        await append([
          {
            eventId: newEventId(),
            conversationId,
            kind: "tool_call_update",
            toolCallId,
            status: "failed",
            detail: `Mode ${target} unavailable`,
            raw: {
              callId: toolCall.id,
              result: supported
                ? `Mode ${target} is disabled in Settings on this browser machine.`
                : `Mode ${target} is not available on the browser machine (available: ${BROWSER_MODE_IDS.join(", ")}).`,
            },
          },
        ]);
        return true;
      }
      await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
        ...current,
        config: { ...current.config, mode: target },
        configOptions: current.configOptions.map((option) =>
          option.id === "mode" ? { ...option, currentValue: target } : option
        ),
      }));
      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "tool_call_update",
          toolCallId,
          status: "completed",
          detail: `Switched to ${target} mode`,
          raw: { callId: toolCall.id, result: `Switched to ${target} mode.` },
        },
      ]);
      return true;
    }

    const execution = await this.tools
      .execute({
        conversationId,
        workspace,
        name: toolCall.name,
        args,
        signal: turn.abort.signal,
      })
      .catch((error) => ({
        result: error instanceof Error ? error.message : String(error),
        isError: true as const,
      }));

    // The todo tool doubles as the structured plan surface.
    if (toolCall.name === "todo" && !execution.isError) {
      await append([
        {
          eventId: newEventId(),
          conversationId,
          kind: "plan",
          planId: "todo",
          entries: this.tools.getTodoList(conversationId),
        },
      ]);
    }
    await append([
      {
        eventId: newEventId(),
        conversationId,
        kind: "tool_call_update",
        toolCallId,
        status: execution.isError ? "failed" : "completed",
        detail: "detail" in execution ? (execution.detail ?? undefined) : undefined,
        ...("editPreview" in execution && execution.editPreview
          ? { editPreview: execution.editPreview }
          : {}),
        ...("locations" in execution && execution.locations
          ? { locations: execution.locations }
          : {}),
        raw: { callId: toolCall.id, result: execution.result },
      },
    ]);
    return true;
  }

  private async runAskQuestion(
    workspace: WorkspaceRecord,
    conversationId: string,
    turn: TurnState,
    input: { toolCallId: string; callId: string; args: Record<string, unknown> }
  ): Promise<boolean> {
    const append = (events: Parameters<ConversationStore["appendEvents"]>[2]) =>
      this.deps.conversations.appendEvents(workspace.id, conversationId, events);
    const questionId = crypto.randomUUID();
    const prompt =
      typeof input.args.prompt === "string" ? input.args.prompt : "The agent has a question.";
    const rawOptions = Array.isArray(input.args.options) ? input.args.options : [];
    const options = rawOptions.map((option, index) => {
      if (typeof option === "string") return { id: `option-${index + 1}`, label: option };
      const record = option as { id?: string; label?: string; title?: string };
      return {
        id: record.id ?? `option-${index + 1}`,
        label: record.label ?? record.title ?? `Option ${index + 1}`,
      };
    });
    await append([
      {
        eventId: newEventId(),
        conversationId,
        kind: "question",
        questionId,
        prompt,
        options,
        allowMultiple:
          input.args.allowMultiple === true || input.args.allow_multiple === true,
        status: "pending",
      },
    ]);
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: { questionId, requestedAt: Date.now() },
    }));

    const outcome = await new Promise<{ approved: boolean; answer?: string }>((resolve) => {
      this.questionGates.set(questionId, { resolve });
    });
    if (turn.cancelled) return false;
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
    await append([
      {
        eventId: newEventId(),
        conversationId,
        kind: "tool_call_update",
        toolCallId: input.toolCallId,
        status: "completed",
        detail: outcome.answer ?? "answered",
        raw: {
          callId: input.callId,
          result: outcome.approved
            ? `User answered: ${outcome.answer ?? ""}`
            : "The user dismissed the question.",
        },
      },
    ]);
    return true;
  }

  private async requestPermission(
    workspace: WorkspaceRecord,
    conversationId: string,
    turn: TurnState,
    input: {
      toolCallId: string;
      category: AgentPermissionCategory;
      toolName: string;
      title: string;
      detail?: string;
    }
  ): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const options = [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" as const },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" as const },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" as const },
      { optionId: "reject_always", name: "Always reject", kind: "reject_always" as const },
    ];
    const pending: AgentPendingPermission = {
      requestId,
      requestedAt: Date.now(),
      toolCallId: input.toolCallId,
      permission: input.category,
      title: input.title,
      detail: input.detail,
      options,
    };
    await this.deps.conversations.appendEvents(workspace.id, conversationId, [
      {
        eventId: newEventId(),
        conversationId,
        kind: "permission_request",
        requestId,
        title: input.title,
        detail: input.detail,
        toolCallId: input.toolCallId,
        options,
      },
    ]);
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: pending,
    }));

    const outcome = await new Promise<{ approved: boolean; always?: boolean }>((resolve) => {
      this.permissionGates.set(requestId, { resolve });
    });
    if (outcome.always && outcome.approved) {
      await this.rememberRule(input.category, input.toolName);
    }
    await this.deps.conversations.appendEvents(workspace.id, conversationId, [
      {
        eventId: newEventId(),
        conversationId,
        kind: "permission_resolved",
        requestId,
        outcome: outcome.approved ? "selected" : "cancelled",
        optionId: outcome.approved
          ? outcome.always
            ? "allow_always"
            : "allow_once"
          : "reject_once",
      },
    ]);
    if (!turn.cancelled) {
      await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
        ...current,
        status: "running",
        pendingPermission: null,
      }));
    }
    return outcome.approved;
  }

  async cancelConversation(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<AgentConversationRecord> {
    const turn = this.turns.get(conversationId);
    if (turn) {
      turn.cancelled = true;
      turn.abort.abort();
    }
    // Release any gates so awaiting promises resolve.
    for (const [requestId, gate] of this.permissionGates) {
      gate.resolve({ approved: false });
      this.permissionGates.delete(requestId);
    }
    for (const [questionId, gate] of this.questionGates) {
      gate.resolve({ approved: false });
      this.questionGates.delete(questionId);
    }
    return this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "cancelled",
      pendingPermission: null,
      pendingQuestion: null,
    }));
  }

  async answerPermission(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean }
  ): Promise<AgentConversationRecord> {
    const gate = this.permissionGates.get(input.requestId);
    if (gate) {
      this.permissionGates.delete(input.requestId);
      const approved =
        !input.cancelled &&
        (input.optionId === "allow_once" || input.optionId === "allow_always");
      gate.resolve({ approved, always: input.optionId === "allow_always" });
    }
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record) throw new Error(`Unknown conversation: ${conversationId}`);
    return record;
  }

  async answerQuestion(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: { questionId: string; answer: string }
  ): Promise<AgentConversationRecord> {
    const gate = this.questionGates.get(input.questionId);
    if (gate) {
      this.questionGates.delete(input.questionId);
      gate.resolve({ approved: true, answer: input.answer });
    }
    // Mark the question event answered for the UI.
    const events = await this.deps.conversations.readEvents(conversationId);
    const question = events.find(
      (event) => event.kind === "question" && event.questionId === input.questionId
    );
    if (question && question.kind === "question") {
      await this.deps.conversations.appendEvents(workspace.id, conversationId, [
        {
          eventId: newEventId(),
          conversationId,
          kind: "question",
          questionId: input.questionId,
          prompt: question.prompt,
          options: question.options,
          status: "answered",
          answer: input.answer,
        },
      ]);
    }
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record) throw new Error(`Unknown conversation: ${conversationId}`);
    return record;
  }

  async retryConversation(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<AgentConversationSnapshotHead> {
    const record = await this.deps.conversations.get(workspace.id, conversationId);
    if (!record) throw new Error(`Unknown conversation: ${conversationId}`);
    if (record.status === "running") {
      const head = await this.deps.conversations.readSnapshotHead(workspace.id, conversationId);
      if (!head) throw new Error(`Unknown conversation: ${conversationId}`);
      return head;
    }
    await this.deps.conversations.update(workspace.id, conversationId, (current) => ({
      ...current,
      status: "running",
      lastError: null,
    }));
    void this.runTurn(workspace, conversationId).catch((error) => {
      console.error("[browser-machine] retry turn crashed:", error);
    });
    const head = await this.deps.conversations.readSnapshotHead(workspace.id, conversationId);
    if (!head) throw new Error(`Unknown conversation: ${conversationId}`);
    return head;
  }

  private toolKind(name: string): string {
    switch (name) {
      case "read_file":
        return "read";
      case "grep":
        return "search";
      case "write_file":
      case "edit_file":
        return "edit";
      case "terminal":
        return "execute";
      case "todo":
        return "think";
      case "ask_question":
        return "other";
      case "switch_branch":
        return "move";
      default:
        return "other";
    }
  }

  private toolTitle(name: string, args: Record<string, unknown>): string {
    const path = typeof args.path === "string" ? args.path : "";
    switch (name) {
      case "read_file":
        return `Read ${path || "file"}`;
      case "grep":
        return `Search for ${typeof args.pattern === "string" ? args.pattern : "pattern"}`;
      case "write_file":
        return `Write ${path || "file"}`;
      case "edit_file":
        return `Edit ${path || "file"}`;
      case "terminal":
        return `Run: ${typeof args.command === "string" ? args.command.slice(0, 80) : "command"}`;
      case "todo":
        return "Update todos";
      case "ask_question":
        return "Ask a question";
      case "wait":
        return "Wait";
      case "switch_branch":
        return `Switch branch to ${typeof args.branch === "string" ? args.branch : "?"}`;
      default:
        return name;
    }
  }

  private toolDetail(name: string, args: Record<string, unknown>): string | undefined {
    if (name === "terminal" && typeof args.command === "string") return args.command;
    if (typeof args.path === "string") return args.path;
    return undefined;
  }
}
