import { randomUUID } from "node:crypto";
import { Agent, type ModelSelection, type SDKAgent, type Run } from "@cursor/sdk";
import {
  cursorSdkStatusToAgentStatus,
  cursorSdkTaskText,
  cursorSdkThinkingText,
  cursorSdkToolEventToAgentEvent,
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
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentProviderCapabilities,
} from "./types.js";

type CursorSdkHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  loadAgentId?: string | null;
};

const cursorSdkCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: false,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
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

function modePromptPrefix(mode: string): string {
  switch (mode) {
    case "plan":
      return "Operate in planning mode. Do not edit files unless the user explicitly asks you to implement after the plan.";
    case "ask":
      return "Operate in ask mode. Answer and inspect as needed, but do not edit files.";
    case "debug":
      return "Operate in debug mode. Gather runtime evidence, reason systematically, and keep fixes focused.";
    case "agent":
      return "";
    default:
      return "";
  }
}

function buildPromptWithSyntheticMode(mode: string, text: string): string {
  const prefix = modePromptPrefix(mode);
  if (!prefix) {
    return text;
  }
  return `${prefix}\n\nUser request:\n${text}`;
}

function modelSelectionFromConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): ModelSelection {
  const modelOption = findPrimaryModelConfigOption(configOptions);
  return {
    id: conversation.config.modelId || modelOption?.currentValue || "composer-2",
  };
}

function isTodoToolName(name: string): boolean {
  return /todo/i.test(name);
}

export function getCursorSdkCapabilities(): AgentProviderCapabilities {
  return cursorSdkCapabilities;
}

class CursorSdkSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  readonly capabilities = cursorSdkCapabilities;

  private activeRun: Run | null = null;
  private disposed = false;

  private constructor(
    private readonly agent: SDKAgent,
    private readonly callbacks: AgentRuntimeCallbacks,
    private readonly backend: AgentBackendInfo,
    configOptions: AgentConfigOption[]
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
    const agent = input.loadAgentId
      ? await Agent.resume(input.loadAgentId, {
          apiKey,
          model,
          local: { cwd: input.callbacks.workspace.root, settingSources },
        })
      : await Agent.create({
          apiKey,
          model,
          name: input.callbacks.conversation.title,
          local: {
            cwd: input.callbacks.workspace.root,
            settingSources,
            sandboxOptions: { enabled: sandboxEnabled },
          },
        });

    const handle = new CursorSdkSessionHandle(
      agent,
      input.callbacks,
      input.backend,
      configOptions
    );
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
    const promptText = buildPromptWithSyntheticMode(mode, input.text);
    const model = modelSelectionFromConfig(this.callbacks.conversation, this.configOptions);
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
      { model }
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
            const events = [normalized];
            if (event.status === "completed" && isTodoToolName(event.name)) {
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
            const detail =
              "Cursor SDK emitted a request event, but the current public SDK does not expose a request response API.";
            await this.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "permission_request",
                requestId: event.request_id,
                title: "Cursor SDK request",
                detail,
                options: [],
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
                title: "Cursor SDK request",
                detail,
                options: [],
              },
            }));
            break;
          }
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
        lastError: message,
      }));
      throw error;
    } finally {
      this.activeRun = null;
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

  async answerPermission(): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "warning",
        text: "Cursor SDK request responses are not supported by the current public SDK.",
      },
    ]);
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
