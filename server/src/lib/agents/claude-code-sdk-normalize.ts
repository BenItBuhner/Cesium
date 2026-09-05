import type {
  AgentEventInput,
  AgentPermissionCategory,
  AgentPlanEntry,
  AgentToolCallStatus,
  AgentToolLocation,
} from "./types.js";
import { asRecord, firstString } from "./json-coerce.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "./tool-normalize.js";

type ToolPayload = {
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  /**
   * The tool's structured `tool_use_result` (per-tool Output object) when the
   * CLI supplied one alongside the text `content` the model sees.
   */
  structuredResult?: unknown;
  isError?: boolean;
};

/**
 * Claude Code tool names that spawn a nested agent. The CLI lists the tool as
 * `Task` in `init.tools` but the model emits `tool_use.name === "Agent"`
 * (older builds emitted `Task`); both are accepted by `--tools`.
 */
export const CLAUDE_SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

/**
 * Claude Code's persistent task list (`TaskCreate`/`TaskUpdate`/...) replaced
 * `TodoWrite` in 2.1.x. Both generations are mirrored into Cesium plans.
 */
export const CLAUDE_TASK_LIST_TOOL_NAMES = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

export const CLAUDE_QUESTION_TOOL_NAME = "AskUserQuestion";

export function isClaudeSubagentToolName(name: string | undefined): boolean {
  return Boolean(name && CLAUDE_SUBAGENT_TOOL_NAMES.has(name));
}

export function isClaudeTaskListToolName(name: string | undefined): boolean {
  return Boolean(name && CLAUDE_TASK_LIST_TOOL_NAMES.has(name));
}

export function textFromClaudeAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
}

export function thinkingTextFromClaudeAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks
    .flatMap((block) => {
      const record = asRecord(block);
      if (!record) {
        return [];
      }
      if (
        (record.type === "thinking" || record.type === "redacted_thinking") &&
        typeof record.thinking === "string"
      ) {
        return [record.thinking];
      }
      return [];
    })
    .join("\n");
}

export type ClaudeAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted: boolean }
  | { type: "tool_use"; tool: ToolPayload }
  | { type: "other"; raw: unknown };

/**
 * Ordered content blocks of an `assistant` message. The provider walks these
 * in order so text emitted before a tool call stays before the tool card.
 */
export function blocksFromClaudeAssistantMessage(message: unknown): ClaudeAssistantBlock[] {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks.map((block): ClaudeAssistantBlock => {
    const record = asRecord(block);
    if (!record) {
      return { type: "other", raw: block };
    }
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text };
    }
    if (record.type === "thinking" || record.type === "redacted_thinking") {
      return {
        type: "thinking",
        thinking: typeof record.thinking === "string" ? record.thinking : "",
        redacted: record.type === "redacted_thinking",
      };
    }
    if (record.type === "tool_use") {
      return {
        type: "tool_use",
        tool: {
          id: typeof record.id === "string" ? record.id : undefined,
          name: typeof record.name === "string" ? record.name : undefined,
          input: record.input,
        },
      };
    }
    return { type: "other", raw: block };
  });
}

export function toolUsesFromClaudeAssistantMessage(message: unknown): ToolPayload[] {
  return blocksFromClaudeAssistantMessage(message).flatMap((block) =>
    block.type === "tool_use" ? [block.tool] : []
  );
}

/** Anthropic API message id carried by both partial stream events and full assistant messages. */
export function apiMessageIdFromClaudeMessage(message: unknown): string | null {
  const record = asRecord(message);
  const inner = asRecord(record?.message);
  const id = inner?.id;
  return typeof id === "string" && id.trim() ? id : null;
}

export function parentToolUseIdFromClaudeMessage(message: unknown): string | null {
  const value = asRecord(message)?.parent_tool_use_id;
  return typeof value === "string" && value.trim() ? value : null;
}

export function textDeltaFromClaudeStreamEvent(message: unknown): string {
  const event = asRecord(message)?.event;
  const eventRecord = asRecord(event);
  const delta = asRecord(eventRecord?.delta);
  if (eventRecord?.type === "content_block_delta" && delta?.type === "text_delta") {
    return typeof delta.text === "string" ? delta.text : "";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "thinking_delta") {
    return typeof delta.thinking === "string" ? delta.thinking : "";
  }
  return "";
}

export function streamEventKind(message: unknown): "text" | "thinking" | "stop" | "other" {
  const event = asRecord(message)?.event;
  const eventRecord = asRecord(event);
  const delta = asRecord(eventRecord?.delta);
  if (eventRecord?.type === "message_stop") {
    return "stop";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "thinking_delta") {
    return "thinking";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "text_delta") {
    return "text";
  }
  return "other";
}

export type ClaudeStreamDelta =
  | { kind: "message_start"; apiMessageId: string | null }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_input"; partialJson: string }
  | { kind: "block_start"; blockType: string; toolName?: string; toolUseId?: string }
  | { kind: "message_stop" }
  | { kind: "other" };

/** Structured view of an `SDKPartialAssistantMessage` (`stream_event`). */
export function classifyClaudeStreamEvent(message: unknown): ClaudeStreamDelta {
  const eventRecord = asRecord(asRecord(message)?.event);
  if (!eventRecord) {
    return { kind: "other" };
  }
  if (eventRecord.type === "message_start") {
    const inner = asRecord(eventRecord.message);
    return {
      kind: "message_start",
      apiMessageId: typeof inner?.id === "string" && inner.id ? inner.id : null,
    };
  }
  if (eventRecord.type === "message_stop") {
    return { kind: "message_stop" };
  }
  if (eventRecord.type === "content_block_start") {
    const block = asRecord(eventRecord.content_block);
    return {
      kind: "block_start",
      blockType: typeof block?.type === "string" ? block.type : "unknown",
      toolName: typeof block?.name === "string" ? block.name : undefined,
      toolUseId: typeof block?.id === "string" ? block.id : undefined,
    };
  }
  if (eventRecord.type === "content_block_delta") {
    const delta = asRecord(eventRecord.delta);
    if (delta?.type === "text_delta") {
      return { kind: "text", text: typeof delta.text === "string" ? delta.text : "" };
    }
    if (delta?.type === "thinking_delta") {
      return { kind: "thinking", text: typeof delta.thinking === "string" ? delta.thinking : "" };
    }
    if (delta?.type === "input_json_delta") {
      return {
        kind: "tool_input",
        partialJson: typeof delta.partial_json === "string" ? delta.partial_json : "",
      };
    }
  }
  return { kind: "other" };
}

/**
 * Reconciles the complete text of an assistant content block against the text
 * already emitted from partial stream deltas so the transcript never shows the
 * same sentence twice. Returns the remainder that still needs to be emitted:
 *
 * - Nothing was streamed (proxy fell back to a non-streaming response) → the
 *   whole block.
 * - The block was fully streamed → empty string.
 * - The stream was cut short (abort mid-message) → only the unstreamed tail.
 *
 * The streamed buffer is consumed as blocks are reconciled so a message with
 * several text blocks reconciles each block in order.
 */
export class ClaudeStreamedTextReconciler {
  private buffer = "";

  get streamedLength(): number {
    return this.buffer.length;
  }

  append(delta: string): void {
    if (delta) {
      this.buffer += delta;
    }
  }

  reconcile(fullText: string): string {
    if (!fullText) {
      return "";
    }
    if (!this.buffer) {
      return fullText;
    }
    if (this.buffer.startsWith(fullText)) {
      this.buffer = this.buffer.slice(fullText.length);
      return "";
    }
    if (fullText.startsWith(this.buffer)) {
      const remainder = fullText.slice(this.buffer.length);
      this.buffer = "";
      return remainder;
    }
    // Divergent content (e.g. a refusal-fallback rewrite): trust the full
    // block and drop the stale stream buffer.
    this.buffer = "";
    return fullText;
  }

  reset(): void {
    this.buffer = "";
  }
}

const CLAUDE_TOOL_KIND_OVERRIDES: Record<string, string> = {
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
  TaskList: "todo",
  TaskGet: "todo",
  TaskOutput: "tool",
  TaskStop: "tool",
  Agent: "task",
  Task: "task",
  AskUserQuestion: "question",
  ExitPlanMode: "tool",
  EnterPlanMode: "tool",
  Skill: "tool",
  Workflow: "task",
  NotebookEdit: "edit",
  WebFetch: "fetch",
  WebSearch: "search_web",
  Glob: "search",
  Grep: "grep",
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "terminal",
  REPL: "terminal",
  ReportFindings: "tool",
  SendMessage: "tool",
};

export function inferClaudeToolKind(name: string, payload: ToolPayload): string {
  const override = CLAUDE_TOOL_KIND_OVERRIDES[name];
  if (override) {
    return override;
  }
  if (/^mcp__/i.test(name)) {
    return "mcp";
  }
  return inferCanonicalToolKind({
    name,
    input: payload.input,
    result: payload.result,
  });
}

/**
 * Human-readable permission prompt when the CLI does not supply `title`
 * (older builds and some tools only send the tool name).
 */
export function permissionTitleForClaudeTool(toolName: string, input: Record<string, unknown>): string {
  const path = firstString(input, ["file_path", "notebook_path", "path"]);
  const file = path ? path.split("/").filter(Boolean).pop() ?? path : null;
  switch (toolName) {
    case "Write":
      return file ? `Write ${file}` : "Write a file";
    case "Edit":
    case "MultiEdit":
      return file ? `Edit ${file}` : "Edit a file";
    case "NotebookEdit":
      return file ? `Edit notebook ${file}` : "Edit a notebook";
    case "Bash":
    case "REPL": {
      const description = shortText(input.description, 60);
      return description ? `Run command · ${description}` : "Run a shell command";
    }
    case "WebFetch": {
      const url = shortText(input.url, 80);
      return url ? `Fetch ${url}` : "Fetch a URL";
    }
    case "WebSearch": {
      const query = shortText(input.query, 60);
      return query ? `Search the web · ${query}` : "Search the web";
    }
    case "Agent":
    case "Task": {
      const description = shortText(input.description, 60);
      return description ? `Run subagent · ${description}` : "Run a subagent";
    }
    case "Skill": {
      const skill = shortText(input.skill ?? input.name, 60);
      return skill ? `Use skill ${skill}` : "Use a skill";
    }
    case "EnterWorktree":
      return "Create a git worktree";
    case "Workflow":
      return "Run a workflow";
    default:
      break;
  }
  if (/^mcp__/i.test(toolName)) {
    const parts = toolName.split("__");
    const server = parts[1] ?? "MCP";
    const tool = parts.slice(2).join("__") || toolName;
    return `${server} · ${tool}`;
  }
  return `Use ${toolName}`;
}

/** Remembered-permission category for a Claude tool so "always allow" rules can match by category. */
export function permissionCategoryForClaudeTool(
  toolName: string
): AgentPermissionCategory | undefined {
  if (toolName === "Bash" || toolName === "REPL") {
    return "terminal";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    return "editFile";
  }
  if (/^mcp__/i.test(toolName)) {
    return "mcpCall";
  }
  if (toolName === "ExitPlanMode" || toolName === "EnterPlanMode") {
    return "switchMode";
  }
  return undefined;
}

function locationsForTool(payload: ToolPayload): AgentToolLocation[] | undefined {
  return locationsForToolPayload({ input: payload.input, result: payload.result });
}

function shortText(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function titleForTool(name: string, kind: string, payload: ToolPayload): string {
  const input = asRecord(payload.input);
  switch (name) {
    case "TaskCreate": {
      const subject = shortText(input?.subject);
      return subject ? `Add task · ${subject}` : "Add task";
    }
    case "TaskUpdate": {
      const status = typeof input?.status === "string" ? input.status : undefined;
      const id = typeof input?.taskId === "string" ? input.taskId : undefined;
      const verb =
        status === "completed"
          ? "Complete task"
          : status === "in_progress"
            ? "Start task"
            : status === "deleted"
              ? "Remove task"
              : "Update task";
      return id ? `${verb} #${id}` : verb;
    }
    case "TaskList":
      return "List tasks";
    case "TaskGet":
      return "Read task";
    case "TodoWrite":
      return "Update todos";
    case "TaskOutput":
      return "Read task output";
    case "TaskStop":
      return "Stop task";
    case "Agent":
    case "Task": {
      const description = shortText(input?.description);
      return description ? `Subagent · ${description}` : "Subagent";
    }
    case "AskUserQuestion":
      return "Ask question";
    case "ExitPlanMode":
      return "Exit plan mode";
    case "EnterPlanMode":
      return "Enter plan mode";
    case "Skill": {
      const skill = shortText(input?.skill ?? input?.name ?? input?.command, 60);
      return skill ? `Skill · ${skill}` : "Skill";
    }
    case "Workflow": {
      const workflow = shortText(input?.name, 60);
      return workflow ? `Workflow · ${workflow}` : "Workflow";
    }
    case "NotebookEdit": {
      const path = firstString(input, ["notebook_path", "file_path", "path"]);
      return path ? `Edit notebook ${path.split("/").pop()}` : "Edit notebook";
    }
    case "ReportFindings":
      return "Report findings";
    case "SendMessage":
      return "Send message";
    default:
      break;
  }
  return titleForCanonicalTool({
    name,
    kind,
    payload: { input: payload.input, result: payload.result },
  });
}

function detailForTool(name: string, payload: ToolPayload): string | undefined {
  const input = asRecord(payload.input);
  if (name === "TaskCreate") {
    return shortText(input?.description, 240);
  }
  if (name === "Skill") {
    return shortText(input?.args ?? input?.arguments, 240);
  }
  return detailForToolPayload({ input: payload.input, result: payload.result });
}

export function claudeToolUseToAgentEvent(input: {
  tool: ToolPayload;
  conversationId: string;
  eventId: string;
  status: AgentToolCallStatus;
}): AgentEventInput {
  const name = input.tool.name || "Tool";
  const kind = inferClaudeToolKind(name, input.tool);
  const title = titleForTool(name, kind, input.tool);
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    kind: input.status === "in_progress" || input.status === "pending" ? "tool_call" : "tool_call_update",
    toolCallId: input.tool.id || `${name}-${input.eventId}`,
    title,
    toolKind: kind,
    status: input.status,
    detail: detailForTool(name, input.tool),
    locations: locationsForTool(input.tool),
    editPreview: extractToolEditPreview(input.tool.input, input.tool.result),
    raw: input.tool,
  };
}

export function toolResultFromClaudeUserMessage(message: unknown): ToolPayload[] {
  const record = asRecord(message);
  const messageParam = asRecord(record?.message);
  const blocks = Array.isArray(messageParam?.content) ? (messageParam.content as unknown[]) : [];
  const results: ToolPayload[] = [];
  for (const block of blocks) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type !== "tool_result") {
      continue;
    }
    results.push({
      id: typeof blockRecord.tool_use_id === "string" ? blockRecord.tool_use_id : undefined,
      result: blockRecord.content,
      isError: blockRecord.is_error === true,
    });
  }
  // The CLI emits one tool_result per user message, so a top-level
  // `tool_use_result` belongs to that single block.
  if (record?.tool_use_result != null && results.length === 1) {
    results[0]!.structuredResult = record.tool_use_result;
  }
  if (record?.tool_use_result != null && results.length === 0) {
    const resultRecord = asRecord(record.tool_use_result);
    results.push({
      id: firstString(resultRecord, ["tool_use_id", "toolUseId", "id"]),
      result: record.tool_use_result,
      isError: resultRecord?.is_error === true || resultRecord?.isError === true,
    });
  }
  return results;
}

/** Plain text inside a tool_result content payload (string or text blocks). */
export function textFromClaudeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result)) {
    return result
      .map((item) => {
        const record = asRecord(item);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(result);
  if (record) {
    return firstString(record, ["text", "content", "message", "summary"]) ?? "";
  }
  return "";
}

/**
 * Non-tool text in a `user` message: peer/channel/task-notification turns that
 * the CLI injected into the transcript (`origin` set, no tool_result blocks).
 */
export function textFromClaudeUserMessage(message: unknown): string {
  const record = asRecord(message);
  const messageParam = asRecord(record?.message);
  const content = messageParam?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const blockRecord = asRecord(block);
      return blockRecord?.type === "text" && typeof blockRecord.text === "string"
        ? blockRecord.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function planEntriesFromClaudeToolPayload(payload: unknown): AgentPlanEntry[] {
  const record = asRecord(payload);
  const todos = Array.isArray(record?.todos)
    ? record.todos
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.tasks)
        ? record.tasks
        : [];
  return todos.flatMap((item, index) => {
    const itemRecord = asRecord(item);
    const content =
      firstString(itemRecord, ["content", "subject", "text", "title", "description"]) ??
      (typeof item === "string" ? item : "");
    const trimmed = content.trim();
    if (!trimmed) {
      return [];
    }
    const statusValue = firstString(itemRecord, ["status"])?.toLowerCase();
    const status =
      statusValue === "in_progress" ||
      statusValue === "blocked" ||
      statusValue === "stuck" ||
      statusValue === "completed" ||
      statusValue === "pending"
        ? statusValue === "stuck"
          ? "blocked"
          : statusValue
        : "pending";
    return [
      {
        id: firstString(itemRecord, ["id"]) ?? `claude-sdk-todo-${index}`,
        content: trimmed,
        priority: firstString(itemRecord, ["priority"]),
        status,
      },
    ];
  });
}

function planStatusFromClaudeTaskStatus(value: unknown): AgentPlanEntry["status"] | null {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "blocked") {
    return value;
  }
  if (value === "running") {
    return "in_progress";
  }
  return null;
}

/**
 * Aggregates Claude Code's task-list tool traffic into a single plan.
 *
 * `TaskCreate` results carry the assigned id; `TaskUpdate` patches status /
 * subject (or deletes); `TaskList`/`TaskGet` results re-sync the whole list.
 * Legacy `TodoWrite` payloads replace the plan wholesale. `apply` returns
 * `true` when the visible plan changed so callers only emit `plan` events on
 * real updates.
 */
export class ClaudeTaskPlanTracker {
  private readonly tasks = new Map<string, AgentPlanEntry>();
  private readonly pendingCreates = new Map<string, { subject: string; description?: string }>();

  get size(): number {
    return this.tasks.size;
  }

  entries(): AgentPlanEntry[] {
    return [...this.tasks.values()].map((entry) => ({ ...entry }));
  }

  /** Records the tool_use so the create can be completed once its result (with id) arrives. */
  noteToolUse(tool: ToolPayload): boolean {
    if (!tool.name || !tool.id) {
      return false;
    }
    if (tool.name === "TodoWrite") {
      const entries = planEntriesFromClaudeToolPayload(tool.input);
      if (entries.length === 0) {
        return false;
      }
      this.tasks.clear();
      for (const entry of entries) {
        this.tasks.set(entry.id, entry);
      }
      return true;
    }
    const input = asRecord(tool.input);
    if (tool.name === "TaskCreate") {
      const subject = firstString(input, ["subject", "content", "title"])?.trim();
      if (subject) {
        this.pendingCreates.set(tool.id, {
          subject,
          description: firstString(input, ["description"]),
        });
      }
      return false;
    }
    if (tool.name === "TaskUpdate") {
      return this.applyUpdate(input);
    }
    return false;
  }

  /** Applies a tool_result for a previously noted tool_use. */
  noteToolResult(tool: ToolPayload): boolean {
    if (!tool.name || tool.isError) {
      if (tool.id) {
        this.pendingCreates.delete(tool.id);
      }
      return false;
    }
    const result = asRecord(tool.structuredResult) ?? asRecord(tool.result);
    if (tool.name === "TaskCreate") {
      const pending = tool.id ? this.pendingCreates.get(tool.id) : undefined;
      if (tool.id) {
        this.pendingCreates.delete(tool.id);
      }
      const task = asRecord(result?.task);
      const id =
        firstString(task, ["id"]) ??
        textFromClaudeToolResult(tool.result).match(/Task #(\S+)/)?.[1] ??
        tool.id;
      const subject = firstString(task, ["subject"]) ?? pending?.subject;
      if (!id || !subject) {
        return false;
      }
      const existing = this.tasks.get(id);
      this.tasks.set(id, {
        id,
        content: subject,
        status: existing?.status ?? "pending",
        priority: existing?.priority,
      });
      return true;
    }
    if (tool.name === "TaskList" || tool.name === "TaskGet") {
      const list = Array.isArray(result?.tasks)
        ? (result.tasks as unknown[])
        : result?.task
          ? [result.task]
          : [];
      if (list.length === 0) {
        return false;
      }
      let changed = false;
      if (tool.name === "TaskList") {
        const ids = new Set(
          list.map((item) => firstString(asRecord(item), ["id"])).filter(Boolean) as string[]
        );
        for (const id of [...this.tasks.keys()]) {
          if (!ids.has(id)) {
            this.tasks.delete(id);
            changed = true;
          }
        }
      }
      for (const item of list) {
        const record = asRecord(item);
        const id = firstString(record, ["id"]);
        const subject = firstString(record, ["subject", "content"]);
        if (!id || !subject) {
          continue;
        }
        const status = planStatusFromClaudeTaskStatus(record?.status) ?? "pending";
        const blockedBy = Array.isArray(record?.blockedBy) ? record.blockedBy : [];
        const effectiveStatus =
          status === "pending" && blockedBy.length > 0 ? "blocked" : status;
        const existing = this.tasks.get(id);
        if (!existing || existing.content !== subject || existing.status !== effectiveStatus) {
          this.tasks.set(id, {
            id,
            content: subject,
            status: effectiveStatus,
            priority: existing?.priority,
          });
          changed = true;
        }
      }
      return changed;
    }
    return false;
  }

  private applyUpdate(input: Record<string, unknown> | undefined): boolean {
    const id = firstString(input, ["taskId", "id"]);
    if (!id) {
      return false;
    }
    const status = input?.status;
    if (status === "deleted") {
      return this.tasks.delete(id);
    }
    const existing = this.tasks.get(id);
    const subject = firstString(input, ["subject"]) ?? existing?.content;
    if (!subject) {
      // Update for a task we never saw created (e.g. resumed session). Track it
      // with a placeholder subject so status changes still render.
      const nextStatus = planStatusFromClaudeTaskStatus(status);
      if (!nextStatus) {
        return false;
      }
      this.tasks.set(id, { id, content: `Task #${id}`, status: nextStatus });
      return true;
    }
    const nextStatus = planStatusFromClaudeTaskStatus(status) ?? existing?.status ?? "pending";
    if (existing && existing.content === subject && existing.status === nextStatus) {
      return false;
    }
    this.tasks.set(id, {
      id,
      content: subject,
      status: nextStatus,
      priority: existing?.priority,
    });
    return true;
  }
}

export type ClaudeQuestionOption = { id: string; label: string; description?: string };

export type ClaudeQuestionStep = {
  id: string;
  /** Exact question text - the key Claude expects back in `answers`. */
  question: string;
  header?: string;
  prompt: string;
  options: ClaudeQuestionOption[];
  allowMultiple: boolean;
};

export type ParsedClaudeAskUserQuestion = {
  prompt: string;
  steps: ClaudeQuestionStep[];
};

/** Normalizes an `AskUserQuestion` tool input into Cesium question steps. */
export function parseClaudeAskUserQuestion(input: unknown): ParsedClaudeAskUserQuestion | null {
  const record = asRecord(input);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  const steps: ClaudeQuestionStep[] = [];
  rawQuestions.forEach((raw, index) => {
    const question = asRecord(raw);
    const text = firstString(question, ["question", "prompt", "text"])?.trim();
    if (!text) {
      return;
    }
    const header = firstString(question, ["header"])?.trim();
    const options = (Array.isArray(question?.options) ? question.options : []).flatMap(
      (option, optionIndex): ClaudeQuestionOption[] => {
        const optionRecord = asRecord(option);
        const label =
          firstString(optionRecord, ["label", "text", "title"])?.trim() ??
          (typeof option === "string" ? option.trim() : "");
        if (!label) {
          return [];
        }
        return [
          {
            id: `option-${optionIndex + 1}`,
            label,
            description: firstString(optionRecord, ["description"]),
          },
        ];
      }
    );
    steps.push({
      id: `question-${index + 1}`,
      question: text,
      header: header || undefined,
      prompt: text,
      options,
      allowMultiple: question?.multiSelect === true,
    });
  });
  if (steps.length === 0) {
    return null;
  }
  const prompt =
    steps.length === 1 ? steps[0]!.prompt : `${steps.length} questions from Claude`;
  return { prompt, steps };
}

function normalizeAnswerKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[?:.\s]+$/g, "").toLowerCase();
}

/**
 * Maps a Cesium ask-question submission (`"<question title>: <answer>"` per
 * line, produced by `formatAskQuestionSubmission`) back onto Claude's
 * `answers` record keyed by exact question text. Free text that cannot be
 * matched to a question is attached to the first unanswered question, or the
 * only question when there is just one.
 */
export function claudeAnswersFromSubmission(
  steps: ClaudeQuestionStep[],
  submission: string
): Record<string, string> {
  const answers: Record<string, string> = {};
  const lines = submission
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const byKey = new Map(steps.map((step) => [normalizeAnswerKey(step.question), step] as const));
  const unmatched: string[] = [];
  for (const line of lines) {
    let matched = false;
    for (const step of steps) {
      const prefix = step.question.trim();
      const candidates = [prefix, prefix.replace(/[?:.]+$/g, "")];
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        if (line.startsWith(candidate)) {
          const rest = line.slice(candidate.length).replace(/^[\s:?.-]+/, "").trim();
          if (rest) {
            answers[step.question] = rest;
            matched = true;
            break;
          }
        }
      }
      if (matched) {
        break;
      }
    }
    if (matched) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = normalizeAnswerKey(line.slice(0, colon));
      const step = byKey.get(key);
      const rest = line.slice(colon + 1).trim();
      if (step && rest) {
        answers[step.question] = rest;
        continue;
      }
      const generic = key.match(/^question (\d+)$/);
      if (generic) {
        const step = steps[Number.parseInt(generic[1]!, 10) - 1];
        if (step && rest) {
          answers[step.question] = rest;
          continue;
        }
      }
    }
    unmatched.push(line);
  }
  if (unmatched.length > 0) {
    const target =
      steps.find((step) => !(step.question in answers)) ?? (steps.length === 1 ? steps[0] : undefined);
    if (target) {
      answers[target.question] = [answers[target.question], unmatched.join("\n")]
        .filter(Boolean)
        .join("\n");
    }
  }
  if (Object.keys(answers).length === 0 && steps.length > 0 && submission.trim()) {
    answers[steps[0]!.question] = submission.trim();
  }
  return answers;
}

export type ClaudeElicitationField = {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  enumValues?: string[];
  required: boolean;
};

export type ParsedClaudeElicitationForm = {
  prompt: string;
  steps: ClaudeQuestionStep[];
  fields: ClaudeElicitationField[];
};

/**
 * Maps an MCP form elicitation (`requestedSchema` = flat JSON-schema object)
 * onto Cesium question steps: enum/boolean fields become options, everything
 * else is answered through the free-text "Other" entry the card always adds.
 */
export function parseClaudeElicitationForm(request: {
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
}): ParsedClaudeElicitationForm | null {
  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties);
  const required = new Set(
    Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((value): value is string => typeof value === "string")
      : []
  );
  const fields: ClaudeElicitationField[] = [];
  const steps: ClaudeQuestionStep[] = [];
  const header = request.title?.trim() || request.serverName;
  const message = request.message.trim();
  const entries = properties ? Object.entries(properties) : [];
  if (entries.length === 0) {
    // Message-only elicitation: a single free-text answer.
    fields.push({ key: "response", type: "string", required: true });
    steps.push({
      id: "question-1",
      question: message || `${header} needs your input`,
      header,
      prompt: message || `${header} needs your input`,
      options: [],
      allowMultiple: false,
    });
    return { prompt: message || `${header} needs your input`, steps, fields };
  }
  entries.forEach(([key, raw], index) => {
    const property = asRecord(raw) ?? {};
    const title = firstString(property, ["title", "description"]) ?? key;
    const enumValues = Array.isArray(property.enum)
      ? (property.enum as unknown[]).map((value) => String(value))
      : Array.isArray(property.oneOf)
        ? (property.oneOf as unknown[]).flatMap((option) => {
            const record = asRecord(option);
            const value = record?.const ?? record?.enum;
            return value == null ? [] : [String(Array.isArray(value) ? value[0] : value)];
          })
        : null;
    const schemaType = typeof property.type === "string" ? property.type : "string";
    const type: ClaudeElicitationField["type"] = enumValues
      ? "enum"
      : schemaType === "boolean"
        ? "boolean"
        : schemaType === "integer"
          ? "integer"
          : schemaType === "number"
            ? "number"
            : "string";
    fields.push({ key, type, ...(enumValues ? { enumValues } : {}), required: required.has(key) });
    const options: ClaudeQuestionOption[] =
      type === "enum"
        ? enumValues!.map((value, optionIndex) => ({ id: `option-${optionIndex + 1}`, label: value }))
        : type === "boolean"
          ? [
              { id: "option-1", label: "Yes" },
              { id: "option-2", label: "No" },
            ]
          : [];
    steps.push({
      id: `question-${index + 1}`,
      question: title,
      header,
      prompt: title,
      options,
      allowMultiple: false,
    });
  });
  const prompt =
    steps.length === 1 ? `${message ? `${message} ` : ""}${steps[0]!.prompt}`.trim() : message || `${header} needs ${steps.length} answers`;
  return { prompt, steps, fields };
}

/** Converts a Cesium submission for an elicitation form back into typed MCP `content`. */
export function claudeElicitationContentFromSubmission(
  form: ParsedClaudeElicitationForm,
  submission: string
): Record<string, string | number | boolean | string[]> {
  const answers = claudeAnswersFromSubmission(form.steps, submission);
  const content: Record<string, string | number | boolean | string[]> = {};
  form.fields.forEach((field, index) => {
    const step = form.steps[index];
    const raw = step ? answers[step.question] : undefined;
    if (raw === undefined || raw === "") {
      return;
    }
    switch (field.type) {
      case "boolean":
        content[field.key] = /^(yes|true|y|1)$/i.test(raw.trim());
        break;
      case "integer": {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) content[field.key] = parsed;
        break;
      }
      case "number": {
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed)) content[field.key] = parsed;
        break;
      }
      case "enum": {
        const match = field.enumValues?.find((value) => value.toLowerCase() === raw.trim().toLowerCase());
        content[field.key] = match ?? raw.trim();
        break;
      }
      default:
        content[field.key] = raw;
    }
  });
  return content;
}

export type ClaudeUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  /** Context window of the primary model when the CLI reported it. */
  contextWindow: number | null;
  /** Model id the CLI reported the bulk of usage under. */
  primaryModel: string | null;
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Usage/cost totals from an `SDKResultMessage`. */
export function usageFromClaudeResult(record: Record<string, unknown>): ClaudeUsageSummary {
  const usage = asRecord(record.usage);
  const modelUsage = asRecord(record.modelUsage) ?? {};
  let primaryModel: string | null = null;
  let contextWindow: number | null = null;
  let best = -1;
  for (const [model, value] of Object.entries(modelUsage)) {
    const entry = asRecord(value);
    if (!entry) {
      continue;
    }
    const weight =
      numberOrZero(entry.inputTokens) +
      numberOrZero(entry.outputTokens) +
      numberOrZero(entry.cacheReadInputTokens) +
      numberOrZero(entry.cacheCreationInputTokens);
    if (weight >= best) {
      best = weight;
      primaryModel = model;
      contextWindow =
        typeof entry.contextWindow === "number" && entry.contextWindow > 0
          ? entry.contextWindow
          : contextWindow;
    }
  }
  return {
    inputTokens: numberOrZero(usage?.input_tokens),
    outputTokens: numberOrZero(usage?.output_tokens),
    cacheReadTokens: numberOrZero(usage?.cache_read_input_tokens),
    cacheCreationTokens: numberOrZero(usage?.cache_creation_input_tokens),
    totalCostUsd:
      typeof record.total_cost_usd === "number" && Number.isFinite(record.total_cost_usd)
        ? record.total_cost_usd
        : null,
    durationMs: typeof record.duration_ms === "number" ? record.duration_ms : null,
    numTurns: typeof record.num_turns === "number" ? record.num_turns : null,
    contextWindow,
    primaryModel,
  };
}

/** Per-request usage from an `assistant` message (`message.usage`), used for live context tracking. */
export function usageFromClaudeAssistantMessage(message: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} | null {
  const usage = asRecord(asRecord(asRecord(message)?.message)?.usage);
  if (!usage) {
    return null;
  }
  const summary = {
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    cacheReadTokens: numberOrZero(usage.cache_read_input_tokens),
    cacheCreationTokens: numberOrZero(usage.cache_creation_input_tokens),
  };
  return summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens > 0
    ? summary
    : null;
}

export function formatClaudeUsageDetail(summary: ClaudeUsageSummary): string {
  const parts: string[] = [];
  const contextTokens = summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens;
  if (contextTokens > 0 || summary.outputTokens > 0) {
    parts.push(`${contextTokens.toLocaleString()} in / ${summary.outputTokens.toLocaleString()} out tokens`);
  }
  if (summary.totalCostUsd != null && summary.totalCostUsd > 0) {
    parts.push(`~$${summary.totalCostUsd.toFixed(4)}`);
  }
  if (summary.durationMs != null && summary.durationMs > 0) {
    parts.push(`${(summary.durationMs / 1000).toFixed(1)}s`);
  }
  if (summary.numTurns != null && summary.numTurns > 1) {
    parts.push(`${summary.numTurns} model turns`);
  }
  return parts.join(" · ");
}

const ASSISTANT_ERROR_MESSAGES: Record<string, string> = {
  authentication_failed: "Authentication failed. Check the API key, OAuth token, or proxy credentials configured for Claude Code.",
  oauth_org_not_allowed: "This Claude account's organization does not allow Claude Code access.",
  billing_error: "Billing error from the Claude API (out of credits or payment required).",
  rate_limit: "Claude API rate limit reached.",
  overloaded: "Claude API is overloaded; the request could not be served.",
  invalid_request: "The Claude API rejected the request as invalid.",
  model_not_found: "The selected model is not available on this Claude endpoint.",
  server_error: "The Claude API returned a server error.",
  max_output_tokens: "The response hit the maximum output token limit.",
  unknown: "The Claude API returned an unknown error.",
};

/**
 * The CLI classifies many proxy/gateway failures as `unknown`; recover the
 * real category from the error text so the user sees an actionable message.
 */
function classifyClaudeErrorText(text: string): string | null {
  if (/model[^\n]*not (?:found|available|supported)|not found in routing|unknown model|invalid model/i.test(text)) {
    return "model_not_found";
  }
  if (/\b(401|403)\b|invalid (?:x-)?api[- ]?key|authentication|unauthori[sz]ed|forbidden/i.test(text)) {
    return "authentication_failed";
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
    return "rate_limit";
  }
  if (/\b(529)\b|overloaded/i.test(text)) {
    return "overloaded";
  }
  if (/\b(402)\b|billing|insufficient (?:credits|quota)|out of credits|payment/i.test(text)) {
    return "billing_error";
  }
  if (/\b5\d\d\b|internal server error|bad gateway|gateway time-?out|timed? ?out/i.test(text)) {
    return "server_error";
  }
  if (/\b(400|422)\b|invalid request/i.test(text)) {
    return "invalid_request";
  }
  return null;
}

export function describeClaudeAssistantError(error: unknown, fallbackText?: string): string {
  const detail = fallbackText?.trim() ?? "";
  const reported = typeof error === "string" ? error : "unknown";
  const key =
    reported === "unknown" || !(reported in ASSISTANT_ERROR_MESSAGES)
      ? classifyClaudeErrorText(detail) ?? "unknown"
      : reported;
  const base = ASSISTANT_ERROR_MESSAGES[key] ?? ASSISTANT_ERROR_MESSAGES.unknown!;
  if (!detail) {
    return base;
  }
  const compact = detail.replace(/^API Error:\s*/i, "").replace(/\s+/g, " ").slice(0, 600);
  return `${base} (${compact})`;
}

const RESULT_SUBTYPE_MESSAGES: Record<string, string> = {
  error_during_execution: "Claude Code stopped because of an error during execution.",
  error_max_turns: "Claude Code stopped: the configured maximum number of turns was reached.",
  error_max_budget_usd: "Claude Code stopped: the configured USD budget was exhausted.",
  error_max_structured_output_retries: "Claude Code stopped: structured output could not be produced.",
};

const TERMINAL_REASON_MESSAGES: Record<string, string> = {
  prompt_too_long: "The prompt exceeded the model's context window.",
  image_error: "An attached image could not be processed by the model.",
  model_error: "The model returned an error.",
  api_error: "The API request failed.",
  malformed_tool_use_exhausted: "The model kept producing malformed tool calls.",
  aborted_streaming: "The response stream was aborted.",
  aborted_tools: "Tool execution was aborted.",
  stop_hook_prevented: "A Stop hook prevented the turn from continuing.",
  hook_stopped: "A hook stopped the turn.",
  max_turns: "The maximum number of turns was reached.",
  budget_exhausted: "The token budget was exhausted.",
  blocking_limit: "A usage limit blocked the request.",
  rapid_refill_breaker: "Requests were paused by the rate-limit circuit breaker.",
  turn_setup_failed: "The turn could not be set up.",
};

/** Human-readable failure text for a non-success `result` message. */
export function describeClaudeResultFailure(record: Record<string, unknown>): string {
  const subtype = typeof record.subtype === "string" ? record.subtype : "error";
  const errors = Array.isArray(record.errors)
    ? (record.errors as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const terminal =
    typeof record.terminal_reason === "string" ? TERMINAL_REASON_MESSAGES[record.terminal_reason] : undefined;
  const base = RESULT_SUBTYPE_MESSAGES[subtype] ?? `Claude Code returned ${subtype}.`;
  const detail = errors.length > 0 ? errors.join("; ") : terminal;
  const resultText = typeof record.result === "string" && record.is_error ? record.result.trim() : "";
  return [base, detail, resultText && resultText !== detail ? resultText : ""]
    .filter(Boolean)
    .join(" ");
}

export type ClaudeSystemEventDescription = {
  level: "info" | "warning" | "error";
  text: string;
  /** When false the event carries nothing worth showing in the transcript. */
  visible: boolean;
};

function formatRateLimitInfo(info: Record<string, unknown> | undefined): string {
  if (!info) {
    return "Rate limit status changed.";
  }
  const status = typeof info.status === "string" ? info.status : "unknown";
  const type = typeof info.rateLimitType === "string" ? info.rateLimitType.replace(/_/g, " ") : null;
  const utilization =
    typeof info.utilization === "number" ? `${Math.round(info.utilization * 100)}% used` : null;
  const resets =
    typeof info.resetsAt === "number" && info.resetsAt > 0
      ? `resets ${new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString()}`
      : null;
  const head =
    status === "rejected"
      ? "Claude usage limit reached"
      : status === "allowed_warning"
        ? "Approaching Claude usage limit"
        : "Claude usage limit status";
  return [head, type, utilization, resets].filter(Boolean).join(" · ");
}

/**
 * Renders the informational / lifecycle `system` subtypes the CLI emits into
 * transcript-friendly text. Returns `visible: false` for chatter that only
 * matters to a full-screen TUI (keep-alives, thinking token pings, etc.).
 */
export function describeClaudeSystemEvent(record: Record<string, unknown>): ClaudeSystemEventDescription {
  const subtype = typeof record.subtype === "string" ? record.subtype : "";
  switch (subtype) {
    case "informational": {
      const level =
        record.level === "warning" ? "warning" : record.level === "info" ? "info" : "info";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      return { level, text: content, visible: Boolean(content) && record.level !== "info" };
    }
    case "notification": {
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const priority = record.priority;
      return {
        level: priority === "high" || priority === "immediate" ? "warning" : "info",
        text,
        visible: Boolean(text) && priority !== "low",
      };
    }
    case "local_command_output": {
      const content = typeof record.content === "string" ? record.content.trim() : "";
      return { level: "info", text: content, visible: Boolean(content) };
    }
    case "compact_boundary": {
      const meta = asRecord(record.compact_metadata);
      const trigger = meta?.trigger === "manual" ? "Manual" : "Automatic";
      const pre = typeof meta?.pre_tokens === "number" ? `${meta.pre_tokens.toLocaleString()} tokens` : null;
      const post = typeof meta?.post_tokens === "number" ? `${meta.post_tokens.toLocaleString()} tokens` : null;
      return {
        level: "info",
        text: `${trigger} context compaction${pre ? ` (${pre}${post ? ` → ${post}` : ""})` : ""}.`,
        visible: true,
      };
    }
    case "auth_status": {
      const error = typeof record.error === "string" ? record.error.trim() : "";
      if (error) {
        return { level: "error", text: `Claude Code authentication: ${error}`, visible: true };
      }
      const output = Array.isArray(record.output)
        ? (record.output as unknown[]).filter((line): line is string => typeof line === "string").join(" ").trim()
        : "";
      return {
        level: "info",
        text: record.isAuthenticating ? `Claude Code is authenticating… ${output}`.trim() : output,
        visible: record.isAuthenticating === true || Boolean(output),
      };
    }
    case "rate_limit_event":
      return { level: "warning", text: formatRateLimitInfo(asRecord(record.rate_limit_info)), visible: true };
    case "permission_denied": {
      const tool = typeof record.tool_name === "string" ? record.tool_name : "tool";
      const reason =
        (typeof record.decision_reason === "string" && record.decision_reason.trim()) ||
        (typeof record.message === "string" && record.message.trim()) ||
        "denied by permission policy";
      return { level: "warning", text: `${tool} was auto-denied: ${reason}`, visible: true };
    }
    case "model_refusal_fallback": {
      const from = typeof record.original_model === "string" ? record.original_model : "the model";
      const to = typeof record.fallback_model === "string" ? record.fallback_model : "a fallback model";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      return { level: "warning", text: `${from} refused the request; retried on ${to}. ${content}`.trim(), visible: true };
    }
    case "model_refusal_no_fallback": {
      const content = typeof record.content === "string" ? record.content.trim() : "";
      return { level: "warning", text: content || "The model refused the request and no fallback model is configured.", visible: true };
    }
    case "hook_started": {
      const name = typeof record.hook_name === "string" ? record.hook_name : "hook";
      const event = typeof record.hook_event === "string" ? record.hook_event : "";
      return { level: "info", text: `Hook ${name}${event ? ` (${event})` : ""} started.`, visible: true };
    }
    case "hook_progress":
      return { level: "info", text: "", visible: false };
    case "hook_response": {
      const name = typeof record.hook_name === "string" ? record.hook_name : "hook";
      const outcome = typeof record.outcome === "string" ? record.outcome : "finished";
      const output =
        (typeof record.output === "string" && record.output.trim()) ||
        (typeof record.stderr === "string" && record.stderr.trim()) ||
        "";
      return {
        level: outcome === "error" ? "warning" : "info",
        text: `Hook ${name} ${outcome}${output ? `: ${output.slice(0, 400)}` : "."}`,
        visible: true,
      };
    }
    case "plugin_install": {
      const status = typeof record.status === "string" ? record.status : "";
      const name = typeof record.name === "string" ? ` ${record.name}` : "";
      const error = typeof record.error === "string" ? `: ${record.error}` : "";
      return {
        level: status === "failed" ? "warning" : "info",
        text: `Plugin install${name} ${status}${error}`.trim(),
        visible: status === "failed" || status === "installed",
      };
    }
    case "files_persisted": {
      const files = Array.isArray(record.files) ? record.files.length : 0;
      const failed = Array.isArray(record.failed) ? (record.failed as unknown[]) : [];
      const failures = failed
        .map((entry) => {
          const failure = asRecord(entry);
          return failure ? `${failure.filename}: ${failure.error}` : "";
        })
        .filter(Boolean);
      return {
        level: failures.length > 0 ? "warning" : "info",
        text: `${files} file(s) persisted${failures.length > 0 ? `; failed: ${failures.join(", ")}` : ""}.`,
        visible: failures.length > 0,
      };
    }
    case "memory_recall": {
      const memories = Array.isArray(record.memories) ? (record.memories as unknown[]) : [];
      return {
        level: "info",
        text: `Recalled ${memories.length} memor${memories.length === 1 ? "y" : "ies"} into context.`,
        visible: memories.length > 0,
      };
    }
    case "mirror_error": {
      const error = typeof record.error === "string" ? record.error : "unknown error";
      return { level: "warning", text: `Transcript mirror failed: ${error}`, visible: true };
    }
    case "elicitation_complete": {
      const server = typeof record.mcp_server_name === "string" ? record.mcp_server_name : "MCP server";
      return { level: "info", text: `${server} completed its authorization request.`, visible: true };
    }
    case "worker_shutting_down": {
      const reason = typeof record.reason === "string" ? record.reason.replace(/_/g, " ") : "unknown reason";
      return { level: "warning", text: `Claude Code worker is shutting down (${reason}).`, visible: true };
    }
    case "session_state_changed":
    case "thinking_tokens":
    case "background_tasks_changed":
    case "commands_changed":
    case "status":
    case "init":
    case "api_retry":
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification":
      return { level: "info", text: "", visible: false };
    default:
      return {
        level: "info",
        text: subtype ? `Claude Code: ${subtype.replace(/_/g, " ")}` : "Claude Code system event",
        visible: Boolean(subtype),
      };
  }
}

export type ClaudeTaskEvent = {
  subtype: "task_started" | "task_progress" | "task_updated" | "task_notification";
  taskId: string | null;
  toolUseId: string | null;
  description: string | null;
  subagentType: string | null;
  taskType: string | null;
  workflowName: string | null;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | "stopped" | null;
  summary: string | null;
  error: string | null;
  lastToolName: string | null;
  totalTokens: number | null;
  toolUses: number | null;
  skipTranscript: boolean;
};

/** Structured view of the four task lifecycle system messages (handles the `patch` envelope of `task_updated`). */
export function parseClaudeTaskEvent(record: Record<string, unknown>): ClaudeTaskEvent | null {
  const subtype = record.subtype;
  if (
    subtype !== "task_started" &&
    subtype !== "task_progress" &&
    subtype !== "task_updated" &&
    subtype !== "task_notification"
  ) {
    return null;
  }
  const patch = subtype === "task_updated" ? asRecord(record.patch) : null;
  const usage = asRecord(record.usage);
  const rawStatus = patch?.status ?? record.status;
  const status =
    rawStatus === "pending" ||
    rawStatus === "running" ||
    rawStatus === "completed" ||
    rawStatus === "failed" ||
    rawStatus === "killed" ||
    rawStatus === "paused" ||
    rawStatus === "stopped"
      ? rawStatus
      : null;
  return {
    subtype,
    taskId: typeof record.task_id === "string" ? record.task_id : null,
    toolUseId: typeof record.tool_use_id === "string" ? record.tool_use_id : null,
    description:
      (typeof patch?.description === "string" && patch.description) ||
      (typeof record.description === "string" ? record.description : null),
    subagentType: typeof record.subagent_type === "string" ? record.subagent_type : null,
    taskType: typeof record.task_type === "string" ? record.task_type : null,
    workflowName: typeof record.workflow_name === "string" ? record.workflow_name : null,
    status,
    summary: typeof record.summary === "string" ? record.summary : null,
    error: typeof patch?.error === "string" ? patch.error : null,
    lastToolName: typeof record.last_tool_name === "string" ? record.last_tool_name : null,
    totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
    toolUses: typeof usage?.tool_uses === "number" ? usage.tool_uses : null,
    skipTranscript: record.skip_transcript === true,
  };
}

/** Normalizes the `slash_commands` / `supportedCommands()` shapes into Cesium slash commands. */
export function claudeSlashCommandsFromSdk(
  commands: unknown
): Array<{ name: string; description?: string; inputHint?: string }> {
  if (!Array.isArray(commands)) {
    return [];
  }
  const seen = new Set<string>();
  const result: Array<{ name: string; description?: string; inputHint?: string }> = [];
  for (const entry of commands) {
    const name =
      typeof entry === "string"
        ? entry
        : firstString(asRecord(entry), ["name"]);
    if (!name || name.startsWith("__") || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const record = asRecord(entry);
    const description = firstString(record, ["description"]);
    const hint = firstString(record, ["argumentHint", "argument_hint"]);
    result.push({
      name,
      ...(description ? { description: description.length > 200 ? `${description.slice(0, 199)}…` : description } : {}),
      ...(hint ? { inputHint: hint } : {}),
    });
  }
  return result;
}
