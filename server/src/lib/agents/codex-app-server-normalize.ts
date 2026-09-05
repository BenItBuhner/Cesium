import { asNumber, asRecord, asString } from "./json-coerce.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  formatDeleteToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  formatWebSearchTitle,
  toolPathBasename,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import {
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "./tool-normalize.js";
import type {
  AgentEventInput,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentToolCallStatus,
  AgentToolEditPreview,
} from "./types.js";

/**
 * Codex App Server (v2 JSON-RPC) → Cesium event normalization.
 *
 * Protocol reference: `codex app-server generate-json-schema` for the
 * installed CLI (0.153.x) plus `codex-rs/app-server/README.md`. Every shape
 * accepted here is either the current wire format or a documented legacy
 * alias that older app-server builds still emit.
 */

export type CodexAppServerRecord = Record<string, unknown>;

type NormalizeToolInput = {
  item: CodexAppServerRecord;
  conversationId: string;
  eventId: string;
  status?: AgentToolCallStatus;
  emitAsUpdate?: boolean;
};

type PermissionRequestInput = {
  requestId: string;
  method: string;
  params: CodexAppServerRecord | undefined;
  conversationId: string;
  eventId: string;
};

export type CodexAppServerQuestionOption = { id: string; label: string };

export type CodexAppServerQuestionStep = {
  id: string;
  prompt: string;
  options: CodexAppServerQuestionOption[];
  allowMultiple?: boolean;
};

/** Normalized `item/tool/requestUserInput` payload. */
export type CodexAppServerUserInputRequest = {
  itemId: string | undefined;
  isBlocking: boolean;
  prompt: string;
  steps: CodexAppServerQuestionStep[];
  /** Per question: the exact option labels the server offered (answers echo labels). */
  labelsByQuestionId: Record<string, string[]>;
};

export const CODEX_USER_INPUT_REQUEST_METHODS = new Set([
  "item/tool/requestUserInput",
  // Pre-0.150 app-server builds used a shorter method name for the same request.
  "tool/requestUserInput",
]);

export const CODEX_APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

const MAX_DETAIL_CHARS = 1_200;

function compactJson(value: unknown, max = MAX_DETAIL_CHARS): string | undefined {
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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function statusFromCodexStatus(value: unknown, fallback: AgentToolCallStatus): AgentToolCallStatus {
  switch (value) {
    case "inProgress":
    case "in_progress":
    case "running":
    case "pending":
    case "pendingInit":
    case "started":
    case "interacted":
      return "in_progress";
    case "completed":
    case "success":
    case "shutdown":
      return "completed";
    case "failed":
    case "error":
    case "errored":
    case "notFound":
      return "failed";
    case "cancelled":
    case "canceled":
    case "declined":
    case "interrupted":
      return "cancelled";
    default:
      return fallback;
  }
}

/** `changes[].kind` is `{ type: "add" | "delete" | "update", move_path? }` on 0.150+, a bare string before. */
function changeKind(change: CodexAppServerRecord | undefined): string | undefined {
  if (!change) {
    return undefined;
  }
  const kind = change.kind;
  if (typeof kind === "string") {
    return kind;
  }
  const record = asRecord(kind);
  return asString(record?.type) ?? asString(record?.kind);
}

function changeMovePath(change: CodexAppServerRecord | undefined): string | undefined {
  const record = asRecord(change?.kind);
  return asString(record?.move_path) ?? asString(record?.movePath);
}

function changeRecords(changes: unknown): CodexAppServerRecord[] {
  if (!Array.isArray(changes)) {
    return [];
  }
  return changes.map((change) => asRecord(change)).filter((change): change is CodexAppServerRecord => Boolean(change));
}

/**
 * Unwraps `/bin/bash -lc '<script>'`, `zsh -c ...`, `powershell -Command ...`
 * wrappers so the title shows the command the model actually wrote.
 */
export function codexAppServerCommandLabel(command: unknown, commandActions?: unknown): string {
  const actions = Array.isArray(commandActions) ? commandActions : [];
  const actionCommands = actions
    .map((action) => asString(asRecord(action)?.command)?.trim())
    .filter((value): value is string => Boolean(value));
  if (actionCommands.length > 0) {
    return Array.from(new Set(actionCommands)).join(" && ");
  }
  const text = Array.isArray(command)
    ? command.map((part) => String(part)).join(" ")
    : typeof command === "string"
      ? command
      : "";
  const trimmed = text.trim();
  if (!trimmed) {
    return "Command";
  }
  const shellWrapper =
    /^(?:(?:\/usr)?\/bin\/)?(?:bash|sh|zsh|dash)\s+-(?:l?c|cl?)\s+(.+)$/s.exec(trimmed) ??
    /^(?:pwsh|powershell)(?:\.exe)?\s+(?:-NoProfile\s+)?-Command\s+(.+)$/is.exec(trimmed) ??
    /^cmd(?:\.exe)?\s+\/[cC]\s+(.+)$/s.exec(trimmed);
  const body = shellWrapper?.[1]?.trim();
  if (!body) {
    return trimmed;
  }
  if (
    body.length >= 2 &&
    ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"')))
  ) {
    return body.slice(1, -1).replace(/\\(["'])/g, "$1").trim() || trimmed;
  }
  return body;
}

export function canonicalizeCodexAppServerItem(
  item: CodexAppServerRecord
): CodexAppServerRecord {
  const type = asString(item.type);
  const out: CodexAppServerRecord = { ...item };
  if (type === "collabToolCall" || type === "collabAgentToolCall") {
    out.type = "collab_tool_call";
    const receiverIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
      : Array.isArray(item.receiver_thread_ids)
        ? item.receiver_thread_ids
        : asString(item.receiverThreadId) || asString(item.receiver_thread_id)
          ? [asString(item.receiverThreadId) ?? asString(item.receiver_thread_id)]
          : undefined;
    if (receiverIds) {
      out.receiver_thread_ids = receiverIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      );
    }
    const receiverThreadId =
      asString(item.receiverThreadId) ??
      asString(item.receiver_thread_id) ??
      (Array.isArray(out.receiver_thread_ids) ? asString(out.receiver_thread_ids[0]) : undefined);
    if (receiverThreadId) {
      out.receiver_thread_id = receiverThreadId;
    }
    const newThreadId = asString(item.newThreadId) ?? asString(item.new_thread_id);
    if (newThreadId) {
      out.new_thread_id = newThreadId;
    }
    const senderThreadId = asString(item.senderThreadId) ?? asString(item.sender_thread_id);
    if (senderThreadId) {
      out.sender_thread_id = senderThreadId;
    }
    const agentsStates = asRecord(item.agentsStates) ?? asRecord(item.agents_states);
    if (agentsStates) {
      out.agents_states = agentsStates;
    }
    const agentStatus = asString(item.agentStatus) ?? asString(item.agent_status);
    if (agentStatus) {
      out.agent_status = agentStatus;
    }
  } else if (type === "subAgentActivity") {
    out.type = "sub_agent_activity";
    const agentThreadId = asString(item.agentThreadId);
    if (agentThreadId) {
      out.agent_thread_id = agentThreadId;
      out.receiver_thread_ids = [agentThreadId];
    }
  } else if (type === "mcpToolCall") {
    out.type = "mcp_tool_call";
  } else if (type === "dynamicToolCall") {
    out.type = "dynamic_tool_call";
  }
  return out;
}

const COLLAB_TOOL_LABELS: Record<string, string> = {
  spawnAgent: "Spawn agent",
  spawn_agent: "Spawn agent",
  sendInput: "Send input to agent",
  send_input: "Send input to agent",
  resumeAgent: "Resume agent",
  resume_agent: "Resume agent",
  wait: "Wait for agent",
  closeAgent: "Close agent",
  close_agent: "Close agent",
  sendMessage: "Message agent",
  followupTask: "Follow-up task",
  interruptAgent: "Interrupt agent",
  listAgents: "List agents",
};

function collabToolLabel(item: CodexAppServerRecord): string {
  const tool = asString(item.tool);
  const label = tool ? COLLAB_TOOL_LABELS[tool] : undefined;
  if (label) {
    return label;
  }
  return tool ? truncateGenericToolTitle(tool.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "), "Task") : "Task";
}

function subAgentActivityLabel(item: CodexAppServerRecord): string {
  const kind = asString(item.kind);
  const path = asString(item.agentPath);
  const name = path ? path.split("/").filter(Boolean).pop() ?? path : "Subagent";
  switch (kind) {
    case "started":
      return `${name} started`;
    case "interacted":
      return `${name} received input`;
    case "interrupted":
      return `${name} interrupted`;
    case "completed":
      return `${name} completed`;
    default:
      return name;
  }
}

function itemToolKind(item: CodexAppServerRecord): string {
  switch (item.type) {
    case "commandExecution":
      return "terminal";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "search_web";
    case "collabToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "task";
    case "imageView":
      return "image";
    case "imageGeneration":
      return "image";
    case "contextCompaction":
      return "context";
    case "mcpToolCall":
      return "mcp";
    case "dynamicToolCall":
      return inferCanonicalToolKind({
        name: asString(item.tool) ?? "dynamic_tool",
        input: item.arguments,
        result: item.result ?? item.contentItems,
      });
    case "enteredReviewMode":
    case "exitedReviewMode":
      return "review";
    case "sleep":
      return "wait";
    case "hookPrompt":
      return "hook";
    case "functionCallOutput":
      return "tool";
    default:
      return "tool";
  }
}

function webSearchTitle(item: CodexAppServerRecord): string {
  const action = asRecord(item.action);
  const actionType = asString(action?.type);
  const query = asString(item.query) ?? asString(action?.query) ?? stringList(action?.queries)[0];
  if (actionType === "openPage" || actionType === "open_page") {
    const url = asString(action?.url);
    return truncateGenericToolTitle(url ? `Open ${url}` : "Open page", "Open page");
  }
  if (actionType === "findInPage" || actionType === "find_in_page") {
    const pattern = asString(action?.pattern);
    return truncateGenericToolTitle(pattern ? `Find "${pattern}" in page` : "Find in page", "Find in page");
  }
  return formatWebSearchTitle(query);
}

function fileChangeTitle(item: CodexAppServerRecord): string {
  const changes = changeRecords(item.changes);
  if (changes.length > 1) {
    const kinds = new Set(changes.map((change) => changeKind(change)));
    const verb = kinds.size === 1 && kinds.has("delete") ? "Delete" : kinds.size === 1 && kinds.has("add") ? "Create" : "Edit";
    return `${verb} ${changes.length} files`;
  }
  const change = changes[0];
  const p = asString(change?.path);
  const kind = changeKind(change);
  if (kind === "delete" || kind === "remove") {
    return formatDeleteToolTitle(p, "Delete file");
  }
  if (kind === "add" || kind === "create") {
    return p ? `Create ${toolPathBasename(p)}` : "Create file";
  }
  const movePath = changeMovePath(change);
  if (movePath && p) {
    return `Move ${toolPathBasename(p)} → ${toolPathBasename(movePath)}`;
  }
  return formatUpdateToolTitle(p, "Edit file");
}

function itemTitle(item: CodexAppServerRecord): string {
  switch (item.type) {
    case "commandExecution":
      return formatTerminalCommandTitle(codexAppServerCommandLabel(item.command, item.commandActions));
    case "fileChange":
      return fileChangeTitle(item);
    case "webSearch":
      return webSearchTitle(item);
    case "collabToolCall":
    case "collabAgentToolCall":
      return collabToolLabel(item);
    case "subAgentActivity":
      return subAgentActivityLabel(item);
    case "imageView":
      return asString(item.path) ? `View ${toolPathBasename(String(item.path))}` : "View image";
    case "imageGeneration": {
      const saved = asString(item.savedPath);
      return saved ? `Generate ${toolPathBasename(saved)}` : "Generate image";
    }
    case "mcpToolCall": {
      const server = asString(item.server);
      const tool = asString(item.tool);
      return truncateGenericToolTitle([server, tool].filter(Boolean).join(" · "), "MCP tool");
    }
    case "dynamicToolCall":
      return titleForCanonicalTool({
        name: asString(item.tool) ?? "Dynamic tool",
        kind: itemToolKind(item),
        payload: { input: item.arguments, result: item.result ?? item.contentItems },
      });
    case "enteredReviewMode":
      return "Review started";
    case "exitedReviewMode":
      return "Review completed";
    case "contextCompaction":
      return "Compact context";
    case "sleep": {
      const ms = asNumber(item.durationMs);
      return ms != null ? `Wait ${formatDuration(ms)}` : "Wait";
    }
    case "hookPrompt":
      return "Hook prompt";
    case "functionCallOutput":
      return truncateGenericToolTitle(asString(item.name), "Tool output");
    default:
      return truncateGenericToolTitle(asString(item.type), "Tool");
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function itemLocations(item: CodexAppServerRecord): Array<{ path: string }> | undefined {
  if (item.type === "fileChange") {
    const paths = changeRecords(item.changes)
      .map((change) => asString(change.path))
      .filter((path): path is string => Boolean(path));
    return paths.length > 0 ? paths.map((path) => ({ path })) : undefined;
  }
  if (item.type === "commandExecution") {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const paths = actions
      .map((action) => asString(asRecord(action)?.path))
      .filter((path): path is string => Boolean(path));
    return paths.length > 0 ? Array.from(new Set(paths)).map((path) => ({ path })) : undefined;
  }
  if (item.type === "imageView" || item.type === "imageGeneration") {
    const path = asString(item.path) ?? asString(item.savedPath);
    return path ? [{ path }] : undefined;
  }
  if (item.type === "dynamicToolCall") {
    return locationsForToolPayload({
      input: item.arguments,
      result: item.result ?? item.contentItems,
    });
  }
  return undefined;
}

function mcpResultText(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return undefined;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const texts = content
    .map((entry) => {
      const block = asRecord(entry);
      return block?.type === "text" ? asString(block.text) : undefined;
    })
    .filter((value): value is string => Boolean(value?.trim()));
  if (texts.length > 0) {
    const joined = texts.join("\n");
    return joined.length > MAX_DETAIL_CHARS ? `${joined.slice(0, MAX_DETAIL_CHARS)}...` : joined;
  }
  return compactJson(record.structuredContent) ?? compactJson(record);
}

function commandDetail(item: CodexAppServerRecord): string | undefined {
  const output = asString(item.aggregatedOutput);
  const exitCode = asNumber(item.exitCode);
  const status = asString(item.status);
  const parts: string[] = [];
  if (output?.trim()) {
    parts.push(output.length > 8_000 ? `${output.slice(0, 8_000)}\n...[truncated]` : output);
  }
  if (status === "declined") {
    parts.push("Command declined.");
  } else if (exitCode != null && exitCode !== 0) {
    parts.push(`Exit code ${exitCode}`);
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return codexAppServerCommandLabel(item.command, item.commandActions);
}

function collabDetail(item: CodexAppServerRecord): string | undefined {
  const prompt = asString(item.prompt);
  if (prompt?.trim()) {
    return prompt;
  }
  const states = asRecord(item.agentsStates);
  if (states) {
    const lines = Object.entries(states).map(([threadId, value]) => {
      const record = asRecord(value);
      const status = asString(record?.status);
      const message = asString(record?.message);
      return [threadId, status, message].filter(Boolean).join(" · ");
    });
    if (lines.length > 0) {
      return lines.join("\n");
    }
  }
  return asString(item.agentStatus) ?? compactJson({
    receiverThreadIds: item.receiverThreadIds ?? item.receiverThreadId,
    newThreadId: item.newThreadId,
  });
}

function itemDetail(item: CodexAppServerRecord): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return commandDetail(item);
    case "fileChange": {
      const changes = changeRecords(item.changes);
      const summary = changes
        .map((change) => `${changeKind(change) ?? "update"} ${asString(change.path) ?? ""}`.trim())
        .join("\n");
      return summary || compactJson(item.changes);
    }
    case "webSearch":
      return asString(item.query) ?? compactJson(item.action);
    case "collabToolCall":
    case "collabAgentToolCall":
      return collabDetail(item);
    case "subAgentActivity":
      return asString(item.agentPath);
    case "mcpToolCall": {
      const error = asRecord(item.error);
      return (
        asString(error?.message) ??
        asString(item.error) ??
        mcpResultText(item.result) ??
        compactJson(item.arguments)
      );
    }
    case "dynamicToolCall":
      return compactJson(item.contentItems) ?? compactJson(item.arguments);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return asString(item.review) ?? compactJson(item.review);
    case "imageGeneration": {
      const failure = asRecord(item.failure);
      return asString(failure?.message) ?? asString(item.revisedPrompt) ?? asString(item.savedPath);
    }
    case "imageView":
      return asString(item.path);
    case "contextCompaction":
      return "Conversation history was compacted to free up context.";
    case "sleep": {
      const ms = asNumber(item.durationMs);
      return ms != null ? `Slept for ${formatDuration(ms)}.` : undefined;
    }
    case "functionCallOutput": {
      const output = item.output;
      return typeof output === "string" ? output.slice(0, MAX_DETAIL_CHARS) : compactJson(output);
    }
    default:
      return asString(item.text) ?? compactJson(item);
  }
}

function fileChangeEditPreview(changes: unknown): AgentToolEditPreview | undefined {
  for (const change of changeRecords(changes)) {
    const path = asString(change.path);
    const diff = asString(change.diff);
    if (!diff) {
      continue;
    }
    const kind = changeKind(change);
    const preview =
      kind === "add" || kind === "create"
        ? extractToolEditPreview({ path, beforeFullFileContent: "", afterFullFileContent: diff }, undefined, path)
        : kind === "delete" || kind === "remove"
          ? extractToolEditPreview({ path, beforeFullFileContent: diff, afterFullFileContent: "" }, undefined, path)
          : extractToolEditPreview({ path, patch: diff }, undefined, path) ??
            extractToolEditPreview({ path, beforeFullFileContent: "", afterFullFileContent: diff }, undefined, path);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

export function codexAppServerPlanEntriesFromTurnPlan(params: CodexAppServerRecord): AgentPlanEntry[] {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  return plan.flatMap((entry, index) => {
    const record = asRecord(entry);
    const content = asString(record?.step) ?? asString(record?.text) ?? asString(record?.content);
    if (!content) {
      return [];
    }
    const rawStatus = asString(record?.status)?.toLowerCase();
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "blocked" || rawStatus === "stuck"
          ? "blocked"
          : rawStatus === "inprogress" || rawStatus === "in_progress"
            ? "in_progress"
            : "pending";
    return [
      {
        id: asString(record?.id) ?? `codex-app-server-plan-${index}`,
        content,
        status,
      },
    ];
  });
}

/** Item types that render as messages/reasoning rather than tool cards. */
const NON_TOOL_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning", "plan"]);

export function codexAppServerToolEventFromItem(input: NormalizeToolInput): AgentEventInput | null {
  const id = asString(input.item.id);
  const type = asString(input.item.type);
  if (!id || !type || NON_TOOL_ITEM_TYPES.has(type)) {
    return null;
  }
  const status = input.status ?? statusFromCodexStatus(input.item.status ?? input.item.kind, "in_progress");
  const editPreview = type === "fileChange" ? fileChangeEditPreview(input.item.changes) : undefined;
  const common = {
    eventId: input.eventId,
    conversationId: input.conversationId,
    toolCallId: id,
    title: itemTitle(input.item),
    toolKind: itemToolKind(input.item),
    status,
    detail: itemDetail(input.item),
    locations: itemLocations(input.item),
    editPreview,
    raw: canonicalizeCodexAppServerItem(input.item),
  };
  return input.emitAsUpdate
    ? { ...common, kind: "tool_call_update" }
    : { ...common, kind: "tool_call" };
}

export function codexAppServerAssistantTextFromItem(item: CodexAppServerRecord): string | null {
  if (item.type !== "agentMessage") {
    return null;
  }
  return asString(item.text) ?? null;
}

/** Proposed-plan text from a `plan` item (plan-mode `<proposed_plan>` block). */
export function codexAppServerPlanTextFromItem(item: CodexAppServerRecord): string | null {
  if (item.type !== "plan") {
    return null;
  }
  return asString(item.text) ?? null;
}

/**
 * Full reasoning text from a completed `reasoning` item. OpenAI models stream
 * `summary` parts; open-weight models expose raw `content` blocks. Providers
 * that never stream deltas still deliver the text here.
 */
export function codexAppServerReasoningTextFromItem(item: CodexAppServerRecord): string | null {
  if (item.type !== "reasoning") {
    return null;
  }
  const summary = stringList(item.summary);
  const content = stringList(item.content);
  const parts = summary.length > 0 ? summary : content;
  const text = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return text || null;
}

/** Inline async questions attached to an `agentMessage` (non-blocking ask). */
export function codexAppServerAsyncQuestionsFromItem(
  item: CodexAppServerRecord
): CodexAppServerQuestionStep[] {
  if (item.type !== "agentMessage" || !Array.isArray(item.questions)) {
    return [];
  }
  return item.questions.flatMap((entry, index) => {
    const record = asRecord(entry);
    const title = asString(record?.title);
    if (!title) {
      return [];
    }
    const options = stringList(record?.options).map((label) => ({ id: label, label }));
    return [{ id: `q${index + 1}`, prompt: title, options, allowMultiple: false }];
  });
}

export function codexAppServerTextDelta(params: CodexAppServerRecord): {
  itemId: string;
  text: string;
} | null {
  const itemId = asString(params.itemId) ?? asString(params.id);
  const text = asString(params.delta) ?? asString(params.text);
  return itemId && text ? { itemId, text } : null;
}

export function codexAppServerReasoningDelta(params: CodexAppServerRecord): string | null {
  return asString(params.delta) ?? asString(params.text) ?? null;
}

/**
 * Unwraps provider error bodies that Codex forwards verbatim, e.g.
 * `{"error":{"message":"Model 'x' not found","type":"invalid_request_error"}}`.
 */
export function codexAppServerUnwrapErrorMessage(message: string | undefined): string | undefined {
  const trimmed = message?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      const nested = asRecord(record?.error);
      const inner = asString(nested?.message) ?? asString(record?.message) ?? asString(record?.detail);
      if (inner?.trim()) {
        return inner.trim();
      }
    } catch {
      // fall through to the raw text
    }
  }
  return trimmed;
}

const CODEX_ERROR_LABELS: Record<string, string> = {
  contextWindowExceeded: "Context window exceeded",
  sessionBudgetExceeded: "Session budget exceeded",
  usageLimitExceeded: "Usage limit reached",
  rateLimitExceeded: "Rate limited by the model provider",
  serverOverloaded: "Model provider overloaded",
  cyberPolicy: "Blocked by cyber safety policy",
  misalignmentPolicyViolation: "Blocked by misalignment policy",
  internalServerError: "Model provider internal error",
  unauthorized: "Not authorized - check your Codex login or API key",
  badRequest: "Model provider rejected the request",
  threadRollbackFailed: "Thread rollback failed",
  sandboxError: "Sandbox error",
  httpConnectionFailed: "Could not connect to the model provider",
  responseStreamConnectionFailed: "Could not open the response stream",
  responseStreamDisconnected: "Response stream disconnected mid-turn",
  responseTooManyFailedAttempts: "Too many failed attempts",
  activeTurnNotSteerable: "The active turn cannot be steered",
};

/** Human-readable `TurnError` summary: `<category>: <provider message>`. */
export function codexAppServerErrorSummary(error: CodexAppServerRecord | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const message = codexAppServerUnwrapErrorMessage(asString(error.message));
  const info = error.codexErrorInfo;
  let category: string | undefined;
  let httpStatus: number | undefined;
  if (typeof info === "string") {
    category = info;
  } else {
    const record = asRecord(info);
    // `{ httpConnectionFailed: { httpStatusCode } }` (current) or `{ type: "..." }` (legacy).
    const typeTag = asString(record?.type);
    const key = record ? Object.keys(record).find((candidate) => candidate !== "type") : undefined;
    if (typeTag) {
      category = typeTag;
      httpStatus = asNumber(record?.httpStatusCode);
    } else if (key) {
      category = key;
      httpStatus = asNumber(asRecord(record?.[key])?.httpStatusCode);
    }
  }
  const label =
    category && category.toLowerCase() !== "other"
      ? CODEX_ERROR_LABELS[category] ?? CODEX_ERROR_LABELS[category.charAt(0).toLowerCase() + category.slice(1)] ?? category
      : undefined;
  const misalignment = asRecord(error.misalignment);
  const explanation = asString(misalignment?.detailedExplanation);
  const additional = asString(error.additionalDetails);
  const head = [label, httpStatus ? `HTTP ${httpStatus}` : undefined].filter(Boolean).join(" · ");
  const body = message && message !== label ? message : undefined;
  const parts = [head && body ? `${head}: ${body}` : head || body, explanation, additional].filter(
    (part): part is string => Boolean(part?.trim())
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function codexAppServerStatusFromTurn(params: CodexAppServerRecord):
  | {
      status: "idle" | "failed" | "interrupted";
      detail?: string;
    }
  | null {
  const turn = asRecord(params.turn);
  const status = turn?.status;
  const detail = codexAppServerErrorSummary(asRecord(turn?.error));
  if (status === "completed") {
    return { status: "idle", detail };
  }
  if (status === "interrupted") {
    return { status: "interrupted", detail };
  }
  if (status === "failed") {
    return { status: "failed", detail: detail ?? "Codex App Server turn failed." };
  }
  return null;
}

export type CodexAppServerTokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexAppServerTokenUsage = {
  /** Cumulative usage for the thread. */
  total: CodexAppServerTokenBreakdown;
  /** Usage of the most recent model turn (what currently fills the context window). */
  last?: CodexAppServerTokenBreakdown;
  modelContextWindow?: number;
};

function tokenBreakdown(value: unknown): CodexAppServerTokenBreakdown | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const inputTokens = asNumber(record.inputTokens) ?? asNumber(record.input_tokens) ?? 0;
  const outputTokens = asNumber(record.outputTokens) ?? asNumber(record.output_tokens) ?? 0;
  const totalTokens = asNumber(record.totalTokens) ?? asNumber(record.total_tokens);
  if (totalTokens == null && inputTokens === 0 && outputTokens === 0) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens: asNumber(record.cachedInputTokens) ?? asNumber(record.cached_input_tokens) ?? 0,
    outputTokens,
    reasoningOutputTokens:
      asNumber(record.reasoningOutputTokens) ?? asNumber(record.reasoning_output_tokens) ?? 0,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
  };
}

export function codexAppServerTokenUsage(params: CodexAppServerRecord): CodexAppServerTokenUsage | null {
  const usage = asRecord(params.tokenUsage) ?? asRecord(params.usage);
  if (!usage) {
    return null;
  }
  const total = tokenBreakdown(usage.total) ?? tokenBreakdown(usage);
  if (!total) {
    return null;
  }
  return {
    total,
    last: tokenBreakdown(usage.last) ?? undefined,
    modelContextWindow: asNumber(usage.modelContextWindow) ?? asNumber(usage.model_context_window) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Server requests: approvals, permissions, elicitations, user input
// ---------------------------------------------------------------------------

/** Option ids are the wire decision; structured decisions are JSON-encoded. */
function decisionOptionId(decision: unknown): string {
  return typeof decision === "string" ? decision : JSON.stringify(decision);
}

export function codexAppServerDecisionFromOptionId(optionId: string | undefined): unknown {
  if (!optionId) {
    return undefined;
  }
  if (optionId.startsWith("{")) {
    try {
      return JSON.parse(optionId) as unknown;
    } catch {
      return optionId;
    }
  }
  return optionId;
}

function describeDecision(decision: unknown, context: { commandLabel?: string }): AgentPermissionOption | null {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return { optionId: "accept", name: "Accept", kind: "allow_once" };
      case "acceptForSession":
        return { optionId: "acceptForSession", name: "Accept for session", kind: "allow_always" };
      case "decline":
        return { optionId: "decline", name: "Decline", kind: "reject_once" };
      case "cancel":
        return { optionId: "cancel", name: "Cancel turn", kind: "reject_once" };
      default:
        return { optionId: decision, name: decision, kind: decision.toLowerCase().includes("accept") ? "allow_once" : "reject_once" };
    }
  }
  const record = asRecord(decision);
  if (!record) {
    return null;
  }
  const execpolicy = asRecord(record.acceptWithExecpolicyAmendment);
  if (execpolicy) {
    const amendment = stringList(execpolicy.execpolicy_amendment ?? execpolicy.execpolicyAmendment);
    const label = amendment.length > 0 ? amendment.join(" ") : context.commandLabel;
    return {
      optionId: decisionOptionId(decision),
      name: label ? `Always allow \`${truncateGenericToolTitle(label, "this command")}\`` : "Always allow this command",
      kind: "allow_always",
    };
  }
  const network = asRecord(record.applyNetworkPolicyAmendment);
  if (network) {
    const amendment = asRecord(network.network_policy_amendment ?? network.networkPolicyAmendment);
    const host = asString(amendment?.host) ?? "this host";
    const action = asString(amendment?.action) ?? "allow";
    return {
      optionId: decisionOptionId(decision),
      name: action === "deny" ? `Always deny ${host}` : `Always allow ${host}`,
      kind: action === "deny" ? "reject_always" : "allow_always",
    };
  }
  return null;
}

function approvalOptions(
  availableDecisions: unknown,
  fallback: string[],
  context: { commandLabel?: string }
): AgentPermissionOption[] {
  const decisions = Array.isArray(availableDecisions) && availableDecisions.length > 0 ? availableDecisions : fallback;
  const seen = new Set<string>();
  const options: AgentPermissionOption[] = [];
  for (const decision of decisions) {
    const option = describeDecision(decision, context);
    if (option && !seen.has(option.optionId)) {
      seen.add(option.optionId);
      options.push(option);
    }
  }
  // Every approval needs a plain accept and a plain decline. Recent servers
  // omit `decline` from `availableDecisions` (offering only `cancel`, which
  // interrupts the whole turn); the decision enum still accepts it and it is
  // the answer Cesium's "Reject" semantics expect (deny this action, let the
  // agent continue).
  if (!options.some((option) => option.optionId === "accept")) {
    options.unshift({ optionId: "accept", name: "Accept", kind: "allow_once" });
  }
  if (!options.some((option) => option.optionId === "decline")) {
    const cancelIndex = options.findIndex((option) => option.optionId === "cancel");
    const decline: AgentPermissionOption = { optionId: "decline", name: "Decline", kind: "reject_once" };
    if (cancelIndex >= 0) {
      options.splice(cancelIndex, 0, decline);
    } else {
      options.push(decline);
    }
  }
  return options;
}

function formatRequestedPermissions(permissions: CodexAppServerRecord | undefined): string[] {
  if (!permissions) {
    return [];
  }
  const lines: string[] = [];
  const fileSystem = asRecord(permissions.fileSystem);
  if (fileSystem) {
    for (const path of stringList(fileSystem.read)) {
      lines.push(`Read ${path}`);
    }
    for (const path of stringList(fileSystem.write)) {
      lines.push(`Write ${path}`);
    }
    if (Array.isArray(fileSystem.entries)) {
      for (const entry of fileSystem.entries) {
        const record = asRecord(entry);
        const access = asString(record?.access) ?? "access";
        const pathRecord = asRecord(record?.path);
        const target =
          asString(pathRecord?.path) ??
          asString(pathRecord?.pattern) ??
          asString(asRecord(pathRecord?.value)?.kind) ??
          "path";
        lines.push(`${access[0]?.toUpperCase()}${access.slice(1)} ${target}`);
      }
    }
  }
  const network = asRecord(permissions.network);
  if (network?.enabled === true) {
    lines.push("Network access");
  }
  return lines;
}

export const CODEX_PERMISSIONS_GRANT_TURN = "grantTurn";
export const CODEX_PERMISSIONS_GRANT_SESSION = "grantSession";
export const CODEX_PERMISSIONS_DENY = "deny";

export const CODEX_ELICITATION_ACCEPT = "accept";
export const CODEX_ELICITATION_ACCEPT_SESSION = "acceptForSession";
export const CODEX_ELICITATION_ACCEPT_ALWAYS = "acceptAlways";
export const CODEX_ELICITATION_DECLINE = "decline";
export const CODEX_ELICITATION_CANCEL = "cancel";

function elicitationMeta(params: CodexAppServerRecord): CodexAppServerRecord | undefined {
  return asRecord(params.meta) ?? asRecord(params._meta);
}

function elicitationSupportsPersist(meta: CodexAppServerRecord | undefined, mode: string): boolean {
  const persist = meta?.persist;
  if (typeof persist === "string") {
    return persist === mode;
  }
  return Array.isArray(persist) && persist.includes(mode);
}

/** `requestedSchema` is null or `{type: object, properties: {}}` → approval-only prompt. */
export function codexAppServerElicitationIsMessageOnly(params: CodexAppServerRecord): boolean {
  const schema = asRecord(params.requestedSchema);
  if (!schema) {
    return params.requestedSchema == null;
  }
  const properties = asRecord(schema.properties);
  return asString(schema.type) === "object" && (!properties || Object.keys(properties).length === 0);
}

export type CodexAppServerElicitationField = {
  id: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "enum" | "unknown";
  required: boolean;
  options: Array<{ value: unknown; label: string }>;
};

/** Flattens a primitive-field MCP elicitation schema into answerable fields. */
export function codexAppServerElicitationFields(params: CodexAppServerRecord): CodexAppServerElicitationField[] {
  const schema = asRecord(params.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!properties) {
    return [];
  }
  const required = new Set(stringList(schema?.required));
  return Object.entries(properties).flatMap(([id, definition]) => {
    const record = asRecord(definition);
    if (!record) {
      return [];
    }
    const title = asString(record.title) ?? id;
    const description = asString(record.description);
    const options: Array<{ value: unknown; label: string }> = [];
    const enumValues = Array.isArray(record.enum) ? record.enum : undefined;
    const enumNames = stringList(record.enumNames);
    if (enumValues) {
      enumValues.forEach((value, index) => {
        options.push({ value, label: enumNames[index] ?? String(value) });
      });
    }
    if (Array.isArray(record.oneOf)) {
      for (const entry of record.oneOf) {
        const option = asRecord(entry);
        if (option && "const" in option) {
          options.push({ value: option.const, label: asString(option.title) ?? String(option.const) });
        }
      }
    }
    const rawType = asString(record.type) ?? (Array.isArray(record.type) ? asString(record.type[0]) : undefined);
    let type: CodexAppServerElicitationField["type"] = "unknown";
    if (options.length > 0) {
      type = "enum";
    } else if (rawType === "boolean") {
      type = "boolean";
      options.push({ value: true, label: "Yes" }, { value: false, label: "No" });
    } else if (rawType === "number") {
      type = "number";
    } else if (rawType === "integer") {
      type = "integer";
    } else if (rawType === "string") {
      type = "string";
    }
    return [{ id, title, description, type, required: required.has(id), options }];
  });
}

export function codexAppServerPermissionRequestFromServerRequest(
  input: PermissionRequestInput
): Extract<AgentEventInput, { kind: "permission_request" }> | null {
  const params = input.params ?? {};
  if (input.method === "item/commandExecution/requestApproval") {
    const commandLabel = codexAppServerCommandLabel(params.command, params.commandActions);
    const networkContext = asRecord(params.networkApprovalContext);
    const isWriteStdin = asString(params.kind) === "writeStdin";
    const detailParts = [
      asString(params.reason),
      networkContext
        ? `Network access to ${asString(networkContext.host) ?? "a host"}${asString(networkContext.protocol) ? ` (${asString(networkContext.protocol)})` : ""}`
        : undefined,
      params.command != null ? commandLabel : undefined,
      asString(params.cwd),
      ...formatRequestedPermissions(asRecord(params.additionalPermissions)),
    ];
    return {
      eventId: input.eventId,
      conversationId: input.conversationId,
      kind: "permission_request",
      requestId: input.requestId,
      toolCallId: asString(params.itemId),
      title: networkContext
        ? "Approve network access"
        : isWriteStdin
          ? "Approve terminal input"
          : "Approve command",
      detail: detailParts.filter(Boolean).join("\n"),
      options: approvalOptions(
        params.availableDecisions,
        ["accept", "acceptForSession", "decline", "cancel"],
        { commandLabel }
      ),
      raw: { method: input.method, params },
    };
  }
  if (input.method === "item/fileChange/requestApproval") {
    return {
      eventId: input.eventId,
      conversationId: input.conversationId,
      kind: "permission_request",
      requestId: input.requestId,
      toolCallId: asString(params.itemId),
      title: "Approve file change",
      detail: [asString(params.reason), asString(params.grantRoot) ? `Grant writes under ${asString(params.grantRoot)}` : undefined]
        .filter(Boolean)
        .join("\n"),
      options: approvalOptions(
        params.availableDecisions,
        ["accept", "acceptForSession", "decline", "cancel"],
        {}
      ),
      raw: { method: input.method, params },
    };
  }
  if (input.method === "item/permissions/requestApproval") {
    const requested = formatRequestedPermissions(asRecord(params.permissions));
    return {
      eventId: input.eventId,
      conversationId: input.conversationId,
      kind: "permission_request",
      requestId: input.requestId,
      toolCallId: asString(params.itemId),
      title: "Grant additional permissions",
      detail: [asString(params.reason), ...requested, asString(params.cwd) ? `Directory: ${asString(params.cwd)}` : undefined]
        .filter(Boolean)
        .join("\n"),
      options: [
        { optionId: CODEX_PERMISSIONS_GRANT_TURN, name: "Grant for this turn", kind: "allow_once" },
        { optionId: CODEX_PERMISSIONS_GRANT_SESSION, name: "Grant for session", kind: "allow_always" },
        { optionId: CODEX_PERMISSIONS_DENY, name: "Deny", kind: "reject_once" },
      ],
      raw: { method: input.method, params },
    };
  }
  if (input.method === "mcpServer/elicitation/request") {
    const serverName = asString(params.serverName) ?? "MCP server";
    const mode = asString(params.mode) ?? "form";
    const message = asString(params.message);
    const meta = elicitationMeta(params);
    const isToolApproval = asString(meta?.codex_approval_kind) === "mcp_tool_call";
    const toolName = asString(meta?.tool_title) ?? asString(meta?.tool_name);
    const toolParams = compactJson(meta?.tool_params_display ?? meta?.tool_params, 600);
    if (mode === "url") {
      return {
        eventId: input.eventId,
        conversationId: input.conversationId,
        kind: "permission_request",
        requestId: input.requestId,
        title: `${serverName} needs you to open a link`,
        detail: [message, asString(params.url)].filter(Boolean).join("\n"),
        options: [
          { optionId: CODEX_ELICITATION_ACCEPT, name: "I opened it", kind: "allow_once" },
          { optionId: CODEX_ELICITATION_DECLINE, name: "Decline", kind: "reject_once" },
          { optionId: CODEX_ELICITATION_CANCEL, name: "Cancel", kind: "reject_once" },
        ],
        raw: { method: input.method, params },
      };
    }
    if (codexAppServerElicitationIsMessageOnly(params)) {
      const options: AgentPermissionOption[] = [
        {
          optionId: CODEX_ELICITATION_ACCEPT,
          name: isToolApproval ? "Run tool" : "Allow",
          kind: "allow_once",
        },
      ];
      if (elicitationSupportsPersist(meta, "session")) {
        options.push({ optionId: CODEX_ELICITATION_ACCEPT_SESSION, name: "Allow for session", kind: "allow_always" });
      }
      if (elicitationSupportsPersist(meta, "always")) {
        options.push({ optionId: CODEX_ELICITATION_ACCEPT_ALWAYS, name: "Always allow", kind: "allow_always" });
      }
      options.push(
        { optionId: CODEX_ELICITATION_DECLINE, name: isToolApproval ? "Decline" : "Deny", kind: "reject_once" },
        { optionId: CODEX_ELICITATION_CANCEL, name: "Cancel", kind: "reject_once" }
      );
      return {
        eventId: input.eventId,
        conversationId: input.conversationId,
        kind: "permission_request",
        requestId: input.requestId,
        title: isToolApproval
          ? `Approve MCP tool${toolName ? ` ${toolName}` : ""} (${serverName})`
          : `${serverName} requests approval`,
        detail: [message, toolParams].filter(Boolean).join("\n"),
        options,
        raw: { method: input.method, params },
      };
    }
    // Structured forms are surfaced as questions (see
    // codexAppServerQuestionFromServerRequest); no approval card here.
    return null;
  }
  return null;
}

/** JSON result for an approval-style server request, given the chosen option. */
export function codexAppServerApprovalResponse(input: {
  method: string;
  params: CodexAppServerRecord | undefined;
  optionId: string | undefined;
  cancelled?: boolean;
}): unknown {
  const params = input.params ?? {};
  if (
    input.method === "item/commandExecution/requestApproval" ||
    input.method === "item/fileChange/requestApproval"
  ) {
    if (input.cancelled) {
      return { decision: "cancel" };
    }
    const decision = codexAppServerDecisionFromOptionId(input.optionId);
    return { decision: decision ?? "decline" };
  }
  if (input.method === "item/permissions/requestApproval") {
    if (input.cancelled || input.optionId === CODEX_PERMISSIONS_DENY || !input.optionId) {
      return { permissions: {} };
    }
    const requested = asRecord(params.permissions) ?? {};
    return {
      permissions: requested,
      ...(input.optionId === CODEX_PERMISSIONS_GRANT_SESSION ? { scope: "session" } : { scope: "turn" }),
    };
  }
  if (input.method === "mcpServer/elicitation/request") {
    if (input.cancelled || input.optionId === CODEX_ELICITATION_CANCEL || !input.optionId) {
      return { action: "cancel", content: null };
    }
    if (input.optionId === CODEX_ELICITATION_DECLINE) {
      return { action: "decline", content: null };
    }
    if (input.optionId === CODEX_ELICITATION_ACCEPT_SESSION) {
      return { action: "accept", content: null, _meta: { persist: "session" } };
    }
    if (input.optionId === CODEX_ELICITATION_ACCEPT_ALWAYS) {
      return { action: "accept", content: null, _meta: { persist: "always" } };
    }
    return { action: "accept", content: null };
  }
  return input.cancelled ? { decision: "cancel" } : { decision: input.optionId ?? "decline" };
}

/** Legacy helper retained for callers that only know the bare decision string. */
export function codexAppServerDecisionForOption(optionId: string | undefined, cancelled?: boolean): unknown {
  if (cancelled) {
    return "cancel";
  }
  switch (optionId) {
    case "accept":
    case "acceptForSession":
    case "decline":
    case "cancel":
      return optionId;
    default:
      return codexAppServerDecisionFromOptionId(optionId) ?? "cancel";
  }
}

const OPTION_DESCRIPTION_SEPARATOR = " — ";

function questionOptionLabel(option: CodexAppServerRecord): { label: string; display: string } | null {
  const label = asString(option.label)?.trim();
  if (!label) {
    return null;
  }
  const description = asString(option.description)?.trim();
  const display =
    description && description.toLowerCase() !== label.toLowerCase()
      ? `${label}${OPTION_DESCRIPTION_SEPARATOR}${description}`
      : label;
  return { label, display };
}

/**
 * Normalizes `item/tool/requestUserInput` (blocking in plan mode, otherwise
 * non-blocking) into a multi-step Cesium question.
 */
export function codexAppServerUserInputRequest(
  params: CodexAppServerRecord | undefined
): CodexAppServerUserInputRequest | null {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const steps: CodexAppServerQuestionStep[] = [];
  const labelsByQuestionId: Record<string, string[]> = {};
  questions.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      return;
    }
    const id = asString(record.id) ?? `question_${index + 1}`;
    const header = asString(record.header)?.trim();
    const question = asString(record.question)?.trim();
    const prompt = question && header && question.toLowerCase() !== header.toLowerCase()
      ? `${header}: ${question}`
      : question || header || `Question ${index + 1}`;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const labels: string[] = [];
    const options = rawOptions.flatMap((option) => {
      const optionRecord = asRecord(option);
      const normalized = optionRecord ? questionOptionLabel(optionRecord) : null;
      if (!normalized) {
        return [];
      }
      labels.push(normalized.label);
      return [{ id: normalized.label, label: normalized.display }];
    });
    labelsByQuestionId[id] = labels;
    steps.push({ id, prompt, options, allowMultiple: false });
  });
  if (steps.length === 0) {
    return null;
  }
  const isBlocking =
    params?.isBlocking === true ||
    (params?.isBlocking == null && params?.autoResolutionMs == null);
  return {
    itemId: asString(params?.itemId),
    isBlocking,
    prompt: steps.length === 1 ? steps[0]!.prompt : "Codex has a few questions",
    steps,
    labelsByQuestionId,
  };
}

/**
 * Parses the Cesium answer blob (`"<step prompt>: <answer>"` per line, or a
 * bare answer for single questions) back into per-question answer arrays.
 * Answers that match an offered option are sent as the option label so the
 * model sees exactly what it proposed; anything else is free text.
 */
export function codexAppServerUserInputResponse(input: {
  request: CodexAppServerUserInputRequest;
  answer: string;
}): { answers: Record<string, { answers: string[] }> } {
  const lines = input.answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const answers: Record<string, { answers: string[] }> = {};
  const steps = input.request.steps;
  const remaining = [...lines];
  for (const step of steps) {
    const prefixes = [step.prompt, step.id].map((value) => `${value}:`.toLowerCase());
    const matchIndex = remaining.findIndex((line) =>
      prefixes.some((prefix) => line.toLowerCase().startsWith(prefix))
    );
    let raw: string | undefined;
    if (matchIndex >= 0) {
      const line = remaining.splice(matchIndex, 1)[0]!;
      const prefix = prefixes.find((candidate) => line.toLowerCase().startsWith(candidate))!;
      raw = line.slice(prefix.length).trim();
    } else if (steps.length === 1) {
      raw = remaining.splice(0).join("\n").trim();
    }
    if (raw === undefined || raw === "" || /^\(no selection\)$/i.test(raw)) {
      answers[step.id] = { answers: [] };
      continue;
    }
    answers[step.id] = { answers: matchSelectedOptionLabels(raw, step.options) };
  }
  return { answers };
}

/**
 * Resolves a submitted answer against the offered options. Multi-select
 * submissions arrive as `"<display>, <display>"`; the tokenizer consumes known
 * option displays greedily and only falls back to free text when the whole
 * answer cannot be explained by options (so commas inside free text survive).
 */
function matchSelectedOptionLabels(
  raw: string,
  options: CodexAppServerQuestionOption[]
): string[] {
  const trimmed = raw.trim();
  const candidates = options
    .flatMap((option) => [
      { display: option.label, value: option.id },
      { display: option.id, value: option.id },
    ])
    .filter((candidate) => candidate.display.trim().length > 0)
    .sort((a, b) => b.display.length - a.display.length);
  const selected: string[] = [];
  let rest = trimmed;
  while (rest.length > 0) {
    const match = candidates.find((candidate) => {
      if (!rest.toLowerCase().startsWith(candidate.display.toLowerCase())) {
        return false;
      }
      const after = rest.slice(candidate.display.length);
      return after.length === 0 || /^\s*,\s*/.test(after);
    });
    if (!match) {
      return selected.length > 0 ? Array.from(new Set([...selected, rest.trim()])) : [trimmed];
    }
    selected.push(match.value);
    rest = rest.slice(match.display.length).replace(/^\s*,\s*/, "");
  }
  return Array.from(new Set(selected));
}

/** Normalized MCP elicitation form (non-approval schema) as a Cesium question. */
export function codexAppServerElicitationQuestion(
  params: CodexAppServerRecord | undefined
): { prompt: string; steps: CodexAppServerQuestionStep[]; fields: CodexAppServerElicitationField[] } | null {
  if (!params || asString(params.mode) === "url" || codexAppServerElicitationIsMessageOnly(params)) {
    return null;
  }
  const fields = codexAppServerElicitationFields(params);
  if (fields.length === 0) {
    return null;
  }
  const serverName = asString(params.serverName) ?? "MCP server";
  const message = asString(params.message)?.trim();
  return {
    prompt: message ? `${serverName}: ${message}` : `${serverName} requests input`,
    steps: fields.map((field) => ({
      id: field.id,
      prompt: field.description && field.description !== field.title ? `${field.title} (${field.description})` : field.title,
      options: field.options.map((option) => ({ id: String(option.value), label: option.label })),
      allowMultiple: false,
    })),
    fields,
  };
}

/** Builds `{ action: "accept", content }` for a structured elicitation answer. */
export function codexAppServerElicitationFormResponse(input: {
  fields: CodexAppServerElicitationField[];
  steps: CodexAppServerQuestionStep[];
  answer: string;
}): { action: "accept" | "cancel"; content: Record<string, unknown> | null } {
  const lines = input.answer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const content: Record<string, unknown> = {};
  const remaining = [...lines];
  input.fields.forEach((field, index) => {
    const step = input.steps[index];
    const prefixes = [step?.prompt, field.title, field.id]
      .filter((value): value is string => Boolean(value))
      .map((value) => `${value}:`.toLowerCase());
    const matchIndex = remaining.findIndex((line) => prefixes.some((prefix) => line.toLowerCase().startsWith(prefix)));
    let raw: string | undefined;
    if (matchIndex >= 0) {
      const line = remaining.splice(matchIndex, 1)[0]!;
      const prefix = prefixes.find((candidate) => line.toLowerCase().startsWith(candidate))!;
      raw = line.slice(prefix.length).trim();
    } else if (input.fields.length === 1) {
      raw = remaining.splice(0).join("\n").trim();
    }
    if (raw === undefined || raw === "" || /^\(no selection\)$/i.test(raw)) {
      return;
    }
    if (field.type === "enum" || field.type === "boolean") {
      const match = field.options.find(
        (option) => option.label.toLowerCase() === raw!.toLowerCase() || String(option.value).toLowerCase() === raw!.toLowerCase()
      );
      if (match) {
        content[field.id] = match.value;
        return;
      }
      if (field.type === "boolean") {
        content[field.id] = /^(y|yes|true|1)$/i.test(raw);
        return;
      }
      content[field.id] = raw;
      return;
    }
    if (field.type === "number" || field.type === "integer") {
      const numeric = Number(raw);
      content[field.id] = Number.isFinite(numeric) ? (field.type === "integer" ? Math.round(numeric) : numeric) : raw;
      return;
    }
    content[field.id] = raw;
  });
  const missingRequired = input.fields.some((field) => field.required && content[field.id] === undefined);
  if (missingRequired && Object.keys(content).length === 0) {
    return { action: "cancel", content: null };
  }
  return { action: "accept", content };
}
