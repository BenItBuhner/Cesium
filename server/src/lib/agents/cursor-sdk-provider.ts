import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Agent,
  CursorAgentError,
  type ModelSelection,
  type Run,
  type SDKAgent,
} from "@cursor/sdk";
import {
  buildPromptWithSyntheticMode,
  withCursorSdkMode,
} from "./cursor-sdk-mode.js";
import {
  cursorSdkStatusToAgentStatus,
  cursorSdkTaskText,
  cursorSdkThinkingText,
  cursorSdkToolEventToAgentEvent,
  detectPlanFilePathFromToolPayload,
  isAskQuestionToolName,
  isCreatePlanToolName,
  isTodoToolName,
  parseCursorSdkAskQuestionPayload,
  parseCursorSdkCreatePlanPayload,
  planEntriesFromCursorSdkToolPayload,
  textFromCursorSdkAssistantMessage,
} from "./cursor-sdk-normalize.js";
import {
  findPrimaryModeConfigOption,
  findPrimaryModelConfigOption,
} from "./config-option-utils.js";
import { getCursorSdkApiKey } from "../cursor-sdk-credentials.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import { decodeCursorSdkModelValue } from "./cursor-sdk-model-selection.js";
import type { SdkMcpServerConfig } from "./mcp-export-adapter.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";
import {
  providerPlanEvents,
  writeProviderPlanArtifact,
} from "./plan-artifacts.js";

type CursorSdkHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  loadAgentId?: string | null;
};

type PendingCursorRequest = {
  requestId: string;
  kind: "plan" | "question" | "generic";
};

const cursorSdkCapabilities = AGENT_CAPABILITIES["cursor-sdk"];

type RespondCapableRun = Run & {
  respond?: (requestId: string, payload: unknown) => Promise<void>;
};

type RespondCapableAgent = SDKAgent & {
  respondToRequest?: (requestId: string, payload: unknown) => Promise<void>;
};

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
    return option;
  });
}

function parseSettingSources(value: string): Array<"project" | "user" | "team" | "mdm" | "plugins" | "all"> {
  if (value === "all") {
    return ["all"];
  }
  const allowed = new Set(["project", "user", "team", "mdm", "plugins"] as const);
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is "project" | "user" | "team" | "mdm" | "plugins" => allowed.has(part as never));
}

function modelSelectionFromConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): ModelSelection {
  const modelOption = findPrimaryModelConfigOption(configOptions);
  const decoded = decodeCursorSdkModelValue(
    conversation.config.modelId || modelOption?.currentValue || "composer-2.5"
  );
  return {
    id: decoded.id,
    ...(decoded.params.length > 0 ? { params: decoded.params } : {}),
  };
}

function buildPlanApprovalOptions() {
  return [
    { optionId: "accept", name: "Accept plan", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject plan", kind: "reject_once" as const },
  ];
}

function planFileTitle(filePath: string): string {
  return path.basename(filePath.replace(/\\/g, "/")) || filePath;
}

async function respondToCursorSdkRequest(
  agent: SDKAgent,
  run: Run | null,
  requestId: string,
  payload: unknown
): Promise<boolean> {
  const runWithRespond = run as RespondCapableRun | null;
  if (runWithRespond?.respond) {
    await runWithRespond.respond(requestId, payload);
    return true;
  }
  const agentWithRespond = agent as RespondCapableAgent;
  if (agentWithRespond.respondToRequest) {
    await agentWithRespond.respondToRequest(requestId, payload);
    return true;
  }
  return false;
}

class CursorSdkSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  readonly capabilities = cursorSdkCapabilities;

  private activeRun: Run | null = null;
  private disposed = false;
  private pendingRequest: PendingCursorRequest | null = null;
  private handledCreatePlanCallIds = new Set<string>();
  private pendingQuestions = new Map<
    string,
    Pick<Extract<AgentEventInput, { kind: "question" }>, "prompt" | "options" | "allowMultiple">
  >();

  private constructor(
    private readonly agent: SDKAgent,
    private readonly callbacks: AgentRuntimeCallbacks,
    private readonly backend: AgentBackendInfo,
    configOptions: AgentConfigOption[],
    private readonly mcpServers: Record<string, SdkMcpServerConfig>
  ) {
    this.sessionId = agent.agentId;
    this.configOptions = configOptions;
  }

  static async create(input: CursorSdkHandleInput): Promise<CursorSdkSessionHandle> {
    const apiKey = await getCursorSdkApiKey();
    if (!apiKey) {
      throw new Error("Cursor SDK API key is not configured. Add it in Settings -> Agents.");
    }

    const configOptions = withCurrentConfig(input.configOptions, input.callbacks.conversation);
    const sandboxEnabled =
      process.platform !== "win32" &&
      optionValue(configOptions, "sdk_sandbox", "enabled") !== "disabled";
    const settingSources = parseSettingSources(
      optionValue(configOptions, "setting_sources", "project,user,plugins")
    );
    const model = modelSelectionFromConfig(input.callbacks.conversation, configOptions);
    const modeOption = findPrimaryModeConfigOption(configOptions);
    const mode = modeOption?.currentValue ?? input.callbacks.conversation.config.mode;
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: input.callbacks.workspace.id,
      workspaceRoot: input.callbacks.workspace.root,
      backendId: "cursor-sdk",
    });
    const mcpExport = pluginAttachments.sdkMcp;
    const mcpServers = Object.keys(mcpExport.servers).length > 0 ? mcpExport.servers : undefined;
    const createOptions = withCursorSdkMode(
      {
        apiKey,
        model,
        name: input.callbacks.conversation.title,
        ...(mcpServers ? { mcpServers } : {}),
        local: {
          cwd: input.callbacks.workspace.root,
          settingSources,
          sandboxOptions: { enabled: sandboxEnabled },
        },
      },
      mode
    );
    const agent = input.loadAgentId
      ? await Agent.resume(
          input.loadAgentId,
          withCursorSdkMode(
            {
              apiKey,
              model,
              ...(mcpServers ? { mcpServers } : {}),
              local: { cwd: input.callbacks.workspace.root, settingSources },
            },
            mode
          )
        )
      : await Agent.create(createOptions);

    const handle = new CursorSdkSessionHandle(
      agent,
      input.callbacks,
      input.backend,
      configOptions,
      mcpServers ?? {}
    );
    if (mcpExport.skipped.length > 0) {
      await input.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: input.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `Cursor SDK skipped ${mcpExport.skipped.length} MCP server(s): ${mcpExport.skipped
            .map((server) => `${server.label}: ${server.reason}`)
            .join("; ")}`,
        },
      ]);
    }
    await input.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: agent.agentId,
      configOptions,
      capabilities: cursorSdkCapabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
    return handle;
  }

  private async handleCreatePlanToolCall(
    event: { call_id: string; name: string; args?: unknown; result?: unknown; status: string }
  ): Promise<AgentEventInput[]> {
    if (this.handledCreatePlanCallIds.has(event.call_id)) {
      return [];
    }
    const parsed = parseCursorSdkCreatePlanPayload(event.args ?? event.result);
    if (!parsed) {
      return [];
    }
    this.handledCreatePlanCallIds.add(event.call_id);
    const artifact = await writeProviderPlanArtifact({
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "cursor-sdk",
      title: parsed.name ?? "Cursor SDK plan",
      overview: parsed.overview,
      markdown: parsed.planMarkdown,
      entries: parsed.entries,
      path: parsed.planUri,
    });
    return providerPlanEvents({
      conversationId: this.callbacks.conversation.id,
      planId: `${this.callbacks.conversation.id}-cursor-sdk-plan-${event.call_id}`,
      artifact,
      raw: event,
    });
  }

  private async handleAskQuestionToolCall(
    event: { call_id: string; args?: unknown; result?: unknown }
  ): Promise<AgentEventInput[]> {
    const parsed = parseCursorSdkAskQuestionPayload(event.args ?? event.result);
    if (!parsed) {
      return [];
    }
    const questionId = `${this.callbacks.conversation.id}-cursor-sdk-question-${event.call_id}`;
    this.pendingRequest = { requestId: event.call_id, kind: "question" };
    this.pendingQuestions.set(questionId, {
      prompt: parsed.prompt,
      options: parsed.options,
      allowMultiple: parsed.allowMultiple,
    });
    return [
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt: parsed.prompt,
        options: parsed.options,
        allowMultiple: parsed.allowMultiple,
        status: "pending",
        raw: event,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: parsed.prompt,
        raw: event,
      },
    ];
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Cursor SDK session has been disposed.");
    }
    const assistantMessageId = `cursor-sdk-assistant-${randomUUID()}`;
    const modeOption = findPrimaryModeConfigOption(this.configOptions);
    const mode = modeOption?.currentValue ?? this.callbacks.conversation.config.mode;
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "cursor-sdk",
    });
    const promptText = appendAgentPluginPrompt(
      buildPromptWithSyntheticMode(mode, input.text),
      pluginAttachments
    );
    const model = modelSelectionFromConfig(this.callbacks.conversation, this.configOptions);
    const mcpServers =
      Object.keys(pluginAttachments.sdkMcp.servers).length > 0
        ? pluginAttachments.sdkMcp.servers
        : this.mcpServers;
    const sendOptions = withCursorSdkMode(
      {
        model,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      },
      mode
    );
    const run = await this.agent.send(
      input.attachments?.length
        ? {
            text: promptText,
            images: input.attachments.map((attachment) => ({
              data: attachment.data,
              mimeType: attachment.mimeType,
            })),
          }
        : promptText,
      sendOptions
    );
    this.activeRun = run;

    try {
      for await (const event of run.stream()) {
        if (this.disposed) {
          break;
        }
        switch (event.type) {
          case "system":
          case "user":
            break;
          case "assistant": {
            const text = textFromCursorSdkAssistantMessage(event);
            if (text) {
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "assistant_message_chunk",
                  messageId: assistantMessageId,
                  text,
                  raw: event,
                },
              ]);
            }
            break;
          }
          case "thinking": {
            const text = cursorSdkThinkingText(event);
            if (text) {
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "reasoning",
                  messageId: `${assistantMessageId}-thinking`,
                  text,
                  raw: event,
                },
              ]);
            }
            break;
          }
          case "tool_call": {
            const normalized = cursorSdkToolEventToAgentEvent({
              event,
              conversationId: this.callbacks.conversation.id,
              eventId: randomUUID(),
            });
            const events: AgentEventInput[] = [normalized];
            if (isCreatePlanToolName(event.name)) {
              events.push(...(await this.handleCreatePlanToolCall(event)));
            } else if (isAskQuestionToolName(event.name) && event.status === "running") {
              events.push(...(await this.handleAskQuestionToolCall(event)));
            } else if (event.status === "completed" && isTodoToolName(event.name)) {
              const entries = [
                ...planEntriesFromCursorSdkToolPayload(event.args),
                ...planEntriesFromCursorSdkToolPayload(event.result),
              ];
              if (entries.length > 0) {
                events.push({
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "plan",
                  planId: `${this.callbacks.conversation.id}-cursor-sdk-todos`,
                  entries,
                  raw: event,
                });
              }
            }
            if (event.status === "completed") {
              const planPath = detectPlanFilePathFromToolPayload({
                name: event.name,
                args: event.args,
                result: event.result,
              });
              if (planPath) {
                events.push({
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "plan_file",
                  path: planPath,
                  title: planFileTitle(planPath),
                  previewMode: "preview",
                  raw: event,
                });
              }
            }
            await this.callbacks.appendEvents(events);
            break;
          }
          case "status": {
            const status = cursorSdkStatusToAgentStatus(event);
            if (status) {
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "status",
                  status,
                  detail: event.message,
                  raw: event,
                },
              ]);
            }
            break;
          }
          case "task": {
            const text = cursorSdkTaskText(event);
            if (text) {
              await this.callbacks.appendEvents([
                {
                  eventId: randomUUID(),
                  conversationId: this.callbacks.conversation.id,
                  kind: "tool_call_update",
                  toolCallId: `${event.run_id}-task`,
                  title: "Task",
                  toolKind: "task",
                  status: event.status === "completed" ? "completed" : "in_progress",
                  detail: text,
                  raw: event,
                },
              ]);
            }
            break;
          }
          case "request": {
            const options = buildPlanApprovalOptions();
            const detail = "Cursor SDK is waiting for plan or permission approval.";
            this.pendingRequest = { requestId: event.request_id, kind: "plan" };
            await this.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "permission_request",
                requestId: event.request_id,
                title: "Review plan",
                detail,
                options,
                raw: event,
              },
              {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "status",
                status: "awaiting_permission",
                detail,
              },
            ]);
            await this.callbacks.updateConversation((current) => ({
              ...current,
              status: "awaiting_permission",
              pendingPermission: {
                requestId: event.request_id,
                requestedAt: Date.now(),
                title: "Review plan",
                detail,
                options,
              },
            }));
            break;
          }
          case "usage":
            // Token usage is informational; ignore so it does not abort the turn.
            break;
          default: {
            const exhaustive: never = event;
            throw new Error(`Unhandled Cursor SDK event: ${String(exhaustive)}`);
          }
        }
      }

      const result = await run.wait();
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason: result.status,
          raw: result,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: result.status === "finished" ? "idle" : result.status === "cancelled" ? "cancelled" : "failed",
          detail: result.status,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: result.status === "finished" ? "idle" : result.status === "cancelled" ? "cancelled" : "failed",
        pendingPermission: null,
        lastError: result.status === "error" ? result.result ?? "Cursor SDK run failed." : null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cursor SDK prompt failed.";
      // Avoid double-prefixing when the SDK message already names the source.
      const detail =
        error instanceof CursorAgentError && !/^Cursor SDK agent error:/i.test(message)
          ? `Cursor SDK agent error: ${message}`
          : message;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: detail,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        pendingPermission: null,
        lastError: detail,
      }));
      throw error;
    } finally {
      this.activeRun = null;
      this.pendingRequest = null;
    }
  }

  async cancel(): Promise<void> {
    await this.activeRun?.cancel().catch(() => undefined);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Cursor SDK run cancelled by the client.",
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
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const accepted = !input.cancelled && input.optionId !== "reject";
    const payload = accepted
      ? { outcome: "accepted" }
      : input.cancelled
        ? { outcome: "cancelled" }
        : { outcome: "rejected" };
    const responded = await respondToCursorSdkRequest(
      this.agent,
      this.activeRun,
      input.requestId,
      payload
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
        raw: { responded, payload },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: responded
          ? accepted
            ? "Plan approved."
            : "Plan rejected."
          : "Plan response recorded locally; SDK respond API unavailable.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
    if (this.pendingRequest?.requestId === input.requestId) {
      this.pendingRequest = null;
    }
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const requestId =
      this.pendingRequest?.kind === "question"
        ? this.pendingRequest.requestId
        : input.questionId;
    const payload = { answer: input.answer };
    const question = this.pendingQuestions.get(input.questionId);
    const responded = await respondToCursorSdkRequest(
      this.agent,
      this.activeRun,
      requestId,
      payload
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: question?.prompt ?? "Question answered",
        options: question?.options ?? [],
        allowMultiple: question?.allowMultiple,
        status: "answered",
        answer: input.answer,
        raw: { responded, payload },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: responded
          ? "Question answer sent to Cursor SDK."
          : "Question answer recorded locally; SDK respond API unavailable.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
    if (this.pendingRequest?.requestId === requestId) {
      this.pendingRequest = null;
    }
    this.pendingQuestions.delete(input.questionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.activeRun?.cancel().catch(() => undefined);
    await this.agent[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export function createCursorSdkProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    startSession(callbacks) {
      return CursorSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
      });
    },
    loadSession(callbacks, providerSessionId) {
      return CursorSdkSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        loadAgentId: providerSessionId,
      });
    },
  };
}
