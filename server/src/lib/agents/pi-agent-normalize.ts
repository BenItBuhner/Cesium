import { randomUUID } from "node:crypto";
import {
  formatGrepToolTitle,
  formatFindToolTitle,
  formatReadToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import { formatCompressingContextStatusDetail } from "./completion-retry.js";
import { asRecord, asString } from "./json-coerce.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import type {
  AgentConversationStatus,
  AgentEventInput,
  AgentPromptAttachment,
  AgentToolCallStatus,
  AgentToolEditPreview,
} from "./types.js";

export type PiAgentRecord = Record<string, unknown>;

type NormalizeToolInput = {
  conversationId: string;
  eventId: string;
  toolCallId: string;
  toolName: string;
  /** Human label registered by the tool (extension `label`); falls back to the name. */
  toolLabel?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  emitAsUpdate?: boolean;
  status?: AgentToolCallStatus;
};

function compactJson(value: unknown, max = 1_200): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  try {
    const text = JSON.stringify(value);
    if (!text || text === "{}" || text === "[]") {
      return undefined;
    }
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return undefined;
  }
}

/** Text parts of a Pi content array (user/custom/tool-result messages). */
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      const item = asRecord(entry);
      if (item?.type === "text" && typeof item.text === "string") {
        return [item.text];
      }
      return [];
    })
    .join("");
}

function contentImages(content: unknown): AgentPromptAttachment[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((entry): AgentPromptAttachment[] => {
    const item = asRecord(entry);
    const data = asString(item?.data);
    const mimeType = asString(item?.mimeType);
    if (item?.type !== "image" || !data || !mimeType) {
      return [];
    }
    return [{ mimeType, data, kind: "image" }];
  });
}

function toolTextFromResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return compactJson(result);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts = content.flatMap((entry) => {
    const item = asRecord(entry);
    if (item?.type === "text" && typeof item.text === "string") {
      return [item.text];
    }
    if (item?.type === "image") {
      return [`[image ${asString(item.mimeType) ?? ""}]`.replace(/\s+\]/, "]")];
    }
    return [];
  });
  if (textParts.length > 0) {
    return textParts.join("\n");
  }
  return compactJson(record.details) ?? compactJson(record);
}

export function piToolKind(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return "read";
    case "grep":
      return "grep";
    case "find":
    case "ls":
      return "search";
    case "bash":
      return "terminal";
    case "edit":
    case "write":
      return "edit";
    default:
      return "tool";
  }
}

export function piToolTitle(toolName: string, args: unknown, toolLabel?: string): string {
  const record = asRecord(args);
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return formatReadToolTitle(asString(record?.path));
    case "grep":
      return formatGrepToolTitle(asString(record?.pattern));
    case "find":
      return formatFindToolTitle(asString(record?.pattern) ?? asString(record?.path));
    case "ls":
      return truncateGenericToolTitle(
        asString(record?.path) ? `List ${asString(record?.path)}` : undefined,
        "List directory"
      );
    case "bash":
      return formatTerminalCommandTitle(asString(record?.command) ?? "Command");
    case "edit":
    case "write":
      return formatUpdateToolTitle(asString(record?.path), normalized === "write" ? "Write file" : "Edit file");
    default:
      return truncateGenericToolTitle(toolLabel?.trim() || toolName, "Tool");
  }
}

function piToolDetail(input: NormalizeToolInput): string | undefined {
  if (input.partialResult != null) {
    return toolTextFromResult(input.partialResult);
  }
  if (input.result != null) {
    return toolTextFromResult(input.result);
  }
  return compactJson(input.args);
}

function piToolLocations(args: unknown): Array<{ path: string }> | undefined {
  const pathValue = asString(asRecord(args)?.path);
  return pathValue ? [{ path: pathValue }] : undefined;
}

/**
 * Edit previews for Pi's file mutation tools. `edit` ships a unified patch in
 * `details.patch` (SDK consumers) plus a TUI `details.diff`; `write` only knows
 * the new content, so it renders as an all-added preview.
 */
export function piToolEditPreview(
  toolName: string,
  args: unknown,
  result: unknown
): AgentToolEditPreview | undefined {
  const normalized = toolName.trim().toLowerCase();
  const argsRecord = asRecord(args);
  const path = asString(argsRecord?.path);
  if (normalized === "edit") {
    const details = asRecord(asRecord(result)?.details);
    const patch = asString(details?.patch);
    if (patch?.trim()) {
      return extractToolEditPreview(args, { patch }, path);
    }
    return undefined;
  }
  if (normalized === "write") {
    const content = typeof argsRecord?.content === "string" ? argsRecord.content : undefined;
    if (content == null) {
      return undefined;
    }
    return extractToolEditPreview(
      args,
      { beforeFullFileContent: "", afterFullFileContent: content },
      path
    );
  }
  return undefined;
}

export function piAgentToolEventFromExecution(input: NormalizeToolInput): AgentEventInput {
  const status =
    input.status ??
    (input.isError ? "failed" : input.emitAsUpdate ? "in_progress" : "in_progress");
  const editPreview =
    input.result != null && !input.isError
      ? piToolEditPreview(input.toolName, input.args, input.result)
      : undefined;
  const common = {
    eventId: input.eventId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    title: piToolTitle(input.toolName, input.args, input.toolLabel),
    toolKind: piToolKind(input.toolName),
    status,
    detail: piToolDetail(input),
    locations: piToolLocations(input.args),
    ...(editPreview ? { editPreview } : {}),
    raw: {
      toolName: input.toolName,
      args: input.args,
      partialResult: input.partialResult,
      result: input.result,
      isError: input.isError,
    },
  };
  return input.emitAsUpdate
    ? { ...common, kind: "tool_call_update" }
    : { ...common, kind: "tool_call" };
}

export type PiAgentRunOutcome = {
  status: Extract<AgentConversationStatus, "idle" | "failed" | "cancelled">;
  error: string | null;
};

/** Result of feeding one Pi `AgentSessionEvent` through the normalizer. */
export type PiAgentNormalizedBatch = {
  events: AgentEventInput[];
  /** Conversation status implied by this event, when it changes. */
  status?: AgentConversationStatus;
  /** `lastError` to persist; `null` clears a previous error. */
  lastError?: string | null;
  /** Set when an agent run reached its terminal state (no retry pending). */
  runOutcome?: PiAgentRunOutcome;
  /** Pi session display name (from `/name` or `pi.setSessionName`). */
  sessionName?: string;
  /** Thinking level after Pi clamped it to the model's capabilities. */
  thinkingLevel?: string;
};

export type PiAgentEventNormalizerOptions = {
  conversationId: string;
  eventId?: () => string;
  /** Label lookup for extension/custom tools (`ToolDefinition.label`). */
  resolveToolLabel?: (toolName: string) => string | undefined;
};

const DEFAULT_ERROR_TEXT = "Pi Agent request failed.";

/**
 * Stateful projection of Pi `AgentSessionEvent`s onto Cesium conversation
 * events. Pi streams one assistant message per LLM call (several per run when
 * tools are involved), only carries tool arguments on `tool_execution_start`,
 * and reports provider failures as assistant messages with `stopReason:
 * "error"` - so the harness has to remember message/tool identity across
 * events and decide the run outcome at `agent_end`.
 */
export class PiAgentEventNormalizer {
  private readonly conversationId: string;
  private readonly nextEventId: () => string;
  private readonly resolveToolLabel: (toolName: string) => string | undefined;

  private assistantMessageId: string | null = null;
  private assistantEmitted = false;
  private runActive = false;
  private pendingError: string | null = null;
  private aborted = false;
  private ownedUserMessagesPending = 0;
  private readonly toolCalls = new Map<string, { toolName: string; args: unknown }>();
  private lastOutcome: PiAgentRunOutcome | null = null;

  constructor(options: PiAgentEventNormalizerOptions) {
    this.conversationId = options.conversationId;
    this.nextEventId = options.eventId ?? (() => randomUUID());
    this.resolveToolLabel = options.resolveToolLabel ?? (() => undefined);
  }

  /** Whether an agent run is in flight (between `agent_start` and a terminal `agent_end`). */
  get isRunActive(): boolean {
    return this.runActive;
  }

  /** Outcome of the most recently finished run, if any. */
  get lastRunOutcome(): PiAgentRunOutcome | null {
    return this.lastOutcome;
  }

  /** Message id of the assistant message currently being streamed, if any. */
  get currentAssistantMessageId(): string | null {
    return this.assistantMessageId;
  }

  /**
   * Call before `session.prompt()`: the next user `message_start` echoes the
   * prompt Cesium already persisted, so it must not be re-emitted.
   */
  beginPrompt(): void {
    this.ownedUserMessagesPending += 1;
  }

  /** Undo `beginPrompt()` when the prompt never reached the agent loop. */
  abandonPrompt(): void {
    this.ownedUserMessagesPending = Math.max(0, this.ownedUserMessagesPending - 1);
  }

  /** Whether a prompt was accepted but its user message has not been echoed yet. */
  get hasPendingOwnedPrompt(): boolean {
    return this.ownedUserMessagesPending > 0;
  }

  private baseEvent(): { eventId: string; conversationId: string } {
    return { eventId: this.nextEventId(), conversationId: this.conversationId };
  }

  private systemEvent(level: "info" | "warning" | "error", text: string, raw?: unknown): AgentEventInput {
    return { ...this.baseEvent(), kind: "system", level, text, ...(raw !== undefined ? { raw } : {}) };
  }

  private statusEvent(status: AgentConversationStatus, detail?: string, raw?: unknown): AgentEventInput {
    return {
      ...this.baseEvent(),
      kind: "status",
      status,
      ...(detail ? { detail } : {}),
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  private ensureAssistantMessage(): string {
    if (!this.assistantMessageId) {
      this.assistantMessageId = `pi-agent-assistant-${this.nextEventId()}`;
      this.assistantEmitted = false;
    }
    return this.assistantMessageId;
  }

  private closeAssistantMessage(stopReason: string, raw?: unknown): AgentEventInput[] {
    const messageId = this.assistantMessageId;
    this.assistantMessageId = null;
    const emitted = this.assistantEmitted;
    this.assistantEmitted = false;
    if (!messageId || !emitted) {
      return [];
    }
    return [
      {
        ...this.baseEvent(),
        kind: "assistant_message_end",
        messageId,
        stopReason,
        ...(raw !== undefined ? { raw } : {}),
      },
    ];
  }

  private toolEvent(input: Omit<NormalizeToolInput, "conversationId" | "eventId">): AgentEventInput {
    return piAgentToolEventFromExecution({
      ...input,
      conversationId: this.conversationId,
      eventId: this.nextEventId(),
      toolLabel: input.toolLabel ?? this.resolveToolLabel(input.toolName),
    });
  }

  /**
   * Finish the current run. Used by `agent_end` and by the provider as a
   * safety net when Pi stops without an `agent_end` (e.g. a cancelled retry).
   */
  endRun(input?: { forceStatus?: PiAgentRunOutcome["status"]; raw?: unknown }): PiAgentNormalizedBatch {
    const events: AgentEventInput[] = [];
    const openStop = this.pendingError ? "error" : this.aborted ? "cancelled" : "completed";
    events.push(...this.closeAssistantMessage(openStop, input?.raw));
    const outcome: PiAgentRunOutcome = input?.forceStatus
      ? { status: input.forceStatus, error: input.forceStatus === "failed" ? this.pendingError ?? DEFAULT_ERROR_TEXT : null }
      : this.pendingError
        ? { status: "failed", error: this.pendingError }
        : this.aborted
          ? { status: "cancelled", error: null }
          : { status: "idle", error: null };
    if (outcome.status === "failed") {
      events.push(this.systemEvent("error", outcome.error ?? DEFAULT_ERROR_TEXT, input?.raw));
      events.push(this.statusEvent("failed", outcome.error ?? undefined, input?.raw));
    } else if (outcome.status === "cancelled") {
      events.push(this.statusEvent("cancelled", "Pi Agent turn cancelled.", input?.raw));
    } else {
      events.push(this.statusEvent("idle", undefined, input?.raw));
    }
    this.runActive = false;
    this.pendingError = null;
    this.aborted = false;
    this.toolCalls.clear();
    this.lastOutcome = outcome;
    return {
      events,
      status: outcome.status,
      lastError: outcome.error,
      runOutcome: outcome,
    };
  }

  /**
   * Events to emit when the user cancels while a run is active. Closes the
   * streaming assistant message so the UI stops showing a live cursor; the
   * terminal `cancelled` status arrives with the aborted run's `agent_end`.
   */
  markCancelRequested(): AgentEventInput[] {
    if (!this.runActive) {
      return [];
    }
    this.aborted = true;
    return this.closeAssistantMessage("cancelled");
  }

  handle(event: PiAgentRecord & { type: string }): PiAgentNormalizedBatch {
    switch (event.type) {
      case "agent_start": {
        this.runActive = true;
        this.pendingError = null;
        this.aborted = false;
        return { events: [], status: "running", lastError: null };
      }
      case "message_start":
        return this.handleMessageStart(event);
      case "message_update":
        return this.handleMessageUpdate(event);
      case "message_end":
        return this.handleMessageEnd(event);
      case "tool_execution_start": {
        const toolCallId = asString(event.toolCallId) ?? "pi-tool";
        const toolName = asString(event.toolName) ?? "tool";
        this.toolCalls.set(toolCallId, { toolName, args: event.args });
        return {
          events: [this.toolEvent({ toolCallId, toolName, args: event.args, status: "in_progress" })],
        };
      }
      case "tool_execution_update": {
        const toolCallId = asString(event.toolCallId) ?? "pi-tool";
        const remembered = this.toolCalls.get(toolCallId);
        const toolName = asString(event.toolName) ?? remembered?.toolName ?? "tool";
        return {
          events: [
            this.toolEvent({
              toolCallId,
              toolName,
              args: event.args ?? remembered?.args,
              partialResult: event.partialResult,
              emitAsUpdate: true,
              status: "in_progress",
            }),
          ],
        };
      }
      case "tool_execution_end": {
        const toolCallId = asString(event.toolCallId) ?? "pi-tool";
        const remembered = this.toolCalls.get(toolCallId);
        this.toolCalls.delete(toolCallId);
        const toolName = asString(event.toolName) ?? remembered?.toolName ?? "tool";
        const isError = event.isError === true;
        return {
          events: [
            this.toolEvent({
              toolCallId,
              toolName,
              args: event.args ?? remembered?.args,
              result: event.result,
              isError,
              emitAsUpdate: true,
              status: isError ? "failed" : "completed",
            }),
          ],
        };
      }
      case "agent_end": {
        if (event.willRetry === true) {
          // Pi will re-run the last turn after a backoff; keep the run open.
          return { events: [], status: "running" };
        }
        return this.endRun({ raw: { type: "agent_end", willRetry: false } });
      }
      case "auto_retry_start": {
        const attempt = typeof event.attempt === "number" ? event.attempt : 1;
        const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : attempt;
        const delaySeconds = Math.round(((typeof event.delayMs === "number" ? event.delayMs : 0) / 1000) * 10) / 10;
        const reason = asString(event.errorMessage) ?? DEFAULT_ERROR_TEXT;
        return {
          events: [
            this.systemEvent(
              "warning",
              `Provider request failed; retrying in ${delaySeconds}s (attempt ${attempt}/${maxAttempts}). ${reason}`,
              event
            ),
            this.statusEvent("running", `Taking longer - retrying provider request (${attempt}/${maxAttempts})…`, event),
          ],
          status: "running",
        };
      }
      case "auto_retry_end": {
        if (event.success === true) {
          this.pendingError = null;
          return { events: [] };
        }
        this.pendingError = asString(event.finalError) ?? this.pendingError ?? DEFAULT_ERROR_TEXT;
        return { events: [] };
      }
      case "compaction_start": {
        const reason = asString(event.reason);
        return {
          events: [
            this.statusEvent(
              "running",
              reason ? `${formatCompressingContextStatusDetail()} (${reason})` : formatCompressingContextStatusDetail(),
              event
            ),
          ],
          status: "running",
        };
      }
      case "compaction_end":
        return this.handleCompactionEnd(event);
      case "session_info_changed": {
        const name = asString(event.name);
        return name ? { events: [], sessionName: name } : { events: [] };
      }
      case "thinking_level_changed": {
        const level = asString(event.level);
        return level ? { events: [], thinkingLevel: level } : { events: [] };
      }
      default:
        // turn_start / turn_end / queue_update carry no UI-visible state.
        return { events: [] };
    }
  }

  private handleMessageStart(event: PiAgentRecord): PiAgentNormalizedBatch {
    const message = asRecord(event.message);
    const role = asString(message?.role);
    if (role === "assistant") {
      const events = this.closeAssistantMessage("completed");
      this.assistantMessageId = `pi-agent-assistant-${this.nextEventId()}`;
      this.assistantEmitted = false;
      return { events };
    }
    if (role === "user") {
      if (this.ownedUserMessagesPending > 0) {
        this.ownedUserMessagesPending -= 1;
        return { events: [] };
      }
      // Injected by an extension (`pi.sendUserMessage`) or a Pi-side steering
      // queue: Cesium never persisted it, so surface it as a user turn.
      const text = contentText(message?.content).trim();
      const attachments = contentImages(message?.content);
      if (!text && attachments.length === 0) {
        return { events: [] };
      }
      return {
        events: [
          {
            ...this.baseEvent(),
            kind: "user_message",
            messageId: `pi-agent-user-${this.nextEventId()}`,
            content: text,
            ...(attachments.length > 0 ? { attachments } : {}),
            raw: { source: "pi-agent-injected", message },
          },
        ],
      };
    }
    return { events: [] };
  }

  private handleMessageUpdate(event: PiAgentRecord): PiAgentNormalizedBatch {
    const assistantMessageEvent = asRecord(event.assistantMessageEvent);
    const deltaType = asString(assistantMessageEvent?.type);
    const delta = asString(assistantMessageEvent?.delta);
    if (!delta) {
      return { events: [] };
    }
    if (deltaType === "text_delta") {
      const messageId = this.ensureAssistantMessage();
      this.assistantEmitted = true;
      return {
        events: [
          {
            ...this.baseEvent(),
            kind: "assistant_message_chunk",
            messageId,
            text: delta,
            raw: event,
          },
        ],
      };
    }
    if (deltaType === "thinking_delta") {
      const messageId = this.ensureAssistantMessage();
      this.assistantEmitted = true;
      return {
        events: [
          {
            ...this.baseEvent(),
            kind: "reasoning",
            messageId: `${messageId}-reasoning`,
            text: delta,
            raw: event,
          },
        ],
      };
    }
    return { events: [] };
  }

  private handleMessageEnd(event: PiAgentRecord): PiAgentNormalizedBatch {
    const message = asRecord(event.message);
    const role = asString(message?.role);
    if (role === "assistant") {
      const stopReason = asString(message?.stopReason);
      if (stopReason === "error") {
        this.pendingError = asString(message?.errorMessage) ?? DEFAULT_ERROR_TEXT;
        return { events: this.closeAssistantMessage("error", { stopReason, errorMessage: this.pendingError }) };
      }
      if (stopReason === "aborted") {
        this.aborted = true;
        return { events: this.closeAssistantMessage("cancelled", { stopReason }) };
      }
      // A clean assistant message after a failed attempt means the retry worked.
      this.pendingError = null;
      return { events: this.closeAssistantMessage("completed", { stopReason }) };
    }
    if (role === "custom") {
      if (message?.display === false) {
        return { events: [] };
      }
      const text = contentText(message?.content).trim();
      if (!text) {
        return { events: [] };
      }
      const customType = asString(message?.customType);
      return {
        events: [
          this.systemEvent("info", customType ? `[${customType}] ${text}` : text, {
            source: "pi-agent-custom-message",
            customType,
          }),
        ],
      };
    }
    return { events: [] };
  }

  private handleCompactionEnd(event: PiAgentRecord): PiAgentNormalizedBatch {
    const events: AgentEventInput[] = [];
    const result = asRecord(event.result);
    const summary = asString(result?.summary);
    if (event.aborted === true) {
      events.push(this.systemEvent("warning", "Context compaction cancelled.", event));
    } else if (asString(event.errorMessage)) {
      events.push(this.systemEvent("error", `Context compaction failed: ${asString(event.errorMessage)}`, event));
    } else if (summary) {
      events.push({
        ...this.baseEvent(),
        kind: "compression_summary",
        messageId: `pi-agent-compaction-${this.nextEventId()}`,
        summary,
        retainedTurnCount: 0,
        compressedTurnCount: 0,
        ...(typeof result?.tokensBefore === "number" ? { estimatedTokensBefore: result.tokensBefore } : {}),
        raw: { reason: event.reason, firstKeptEntryId: result?.firstKeptEntryId },
      });
    }
    // While a run is active the agent loop continues; otherwise the manual
    // compaction is over and the conversation is idle again.
    if (!this.runActive && event.willRetry !== true) {
      events.push(this.statusEvent("idle", undefined, { type: "compaction_end" }));
      return { events, status: "idle" };
    }
    return { events };
  }
}

/**
 * Stateless convenience wrapper kept for callers that project a single Pi
 * event with a known assistant message id (tests, transcripts).
 */
export function piAgentEventsFromSessionEvent(input: {
  event: { type: string; [key: string]: unknown };
  conversationId: string;
  assistantMessageId: string;
  eventId: () => string;
}): AgentEventInput[] {
  const normalizer = new PiAgentEventNormalizer({
    conversationId: input.conversationId,
    eventId: input.eventId,
  });
  normalizer.handle({ type: "agent_start" });
  // Seed the current assistant message so chunk/end events reuse the caller's id.
  normalizer.handle({
    type: "message_start",
    message: { role: "assistant" },
  });
  const seeded = normalizer as unknown as { assistantMessageId: string | null; assistantEmitted: boolean };
  seeded.assistantMessageId = input.assistantMessageId;
  if (input.event.type === "agent_end") {
    seeded.assistantEmitted = true;
  }
  return normalizer.handle(input.event).events;
}
