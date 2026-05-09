import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  formatDeleteToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  formatWebSearchTitle,
  toolPathBasename,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import type {
  AgentEventInput,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentToolCallStatus,
} from "./types.js";

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

function asRecord(value: unknown): CodexAppServerRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexAppServerRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

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

function statusFromCodexStatus(value: unknown, fallback: AgentToolCallStatus): AgentToolCallStatus {
  switch (value) {
    case "inProgress":
    case "in_progress":
    case "running":
    case "pending":
      return "in_progress";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
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

function firstChangePath(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) {
    return undefined;
  }
  for (const change of changes) {
    const record = asRecord(change);
    const path = asString(record?.path);
    if (path) {
      return path;
    }
  }
  return undefined;
}

function firstChangeKind(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) {
    return undefined;
  }
  for (const change of changes) {
    const record = asRecord(change);
    const kind = asString(record?.kind);
    if (kind) {
      return kind;
    }
  }
  return undefined;
}

function commandText(command: unknown): string {
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).join(" ");
  }
  if (typeof command === "string") {
    return command;
  }
  return "Command";
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
      return "task";
    case "imageView":
      return "image";
    case "contextCompaction":
      return "context";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "tool";
    case "enteredReviewMode":
    case "exitedReviewMode":
      return "review";
    default:
      return "tool";
  }
}

function itemTitle(item: CodexAppServerRecord): string {
  switch (item.type) {
    case "commandExecution":
      return formatTerminalCommandTitle(commandText(item.command));
    case "fileChange": {
      const p = firstChangePath(item.changes);
      const kind = firstChangeKind(item.changes);
      if (kind === "delete" || kind === "remove") {
        return formatDeleteToolTitle(p, "Delete file");
      }
      return formatUpdateToolTitle(p, "Edit file");
    }
    case "webSearch":
      return formatWebSearchTitle(asString(item.query));
    case "collabToolCall":
      return "Task";
    case "imageView":
      return asString(item.path) ? `View ${toolPathBasename(String(item.path))}` : "View image";
    case "mcpToolCall": {
      const server = asString(item.server);
      const tool = asString(item.tool);
      return truncateGenericToolTitle([server, tool].filter(Boolean).join(" · "), "MCP tool");
    }
    case "dynamicToolCall":
      return truncateGenericToolTitle(asString(item.tool), "Dynamic tool");
    case "enteredReviewMode":
      return "Review started";
    case "exitedReviewMode":
      return "Review completed";
    case "contextCompaction":
      return "Compact context";
    default:
      return truncateGenericToolTitle(asString(item.type), "Tool");
  }
}

function itemDetail(item: CodexAppServerRecord): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return (
        asString(item.aggregatedOutput) ??
        compactJson(item.commandActions) ??
        commandText(item.command)
      );
    case "fileChange":
      return compactJson(item.changes);
    case "webSearch":
      return asString(item.query) ?? compactJson(item.action);
    case "collabToolCall":
      return (
        asString(item.prompt) ??
        asString(item.agentStatus) ??
        compactJson({
          receiverThreadId: item.receiverThreadId,
          newThreadId: item.newThreadId,
        })
      );
    case "mcpToolCall":
      return asString(item.error) ?? compactJson(item.result) ?? compactJson(item.arguments);
    case "dynamicToolCall":
      return compactJson(item.contentItems) ?? compactJson(item.arguments);
    case "enteredReviewMode":
    case "exitedReviewMode":
      return asString(item.review) ?? compactJson(item.review);
    default:
      return asString(item.text) ?? compactJson(item);
  }
}

export function codexAppServerPlanEntriesFromTurnPlan(params: CodexAppServerRecord): AgentPlanEntry[] {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  return plan.flatMap((entry, index) => {
    const record = asRecord(entry);
    const content = asString(record?.step) ?? asString(record?.text) ?? asString(record?.content);
    if (!content) {
      return [];
    }
    const rawStatus = record?.status;
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "inProgress" || rawStatus === "in_progress"
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

export function codexAppServerToolEventFromItem(input: NormalizeToolInput): AgentEventInput | null {
  const id = asString(input.item.id);
  const type = asString(input.item.type);
  if (!id || !type) {
    return null;
  }
  if (
    type === "userMessage" ||
    type === "agentMessage" ||
    type === "reasoning" ||
    type === "plan"
  ) {
    return null;
  }
  const status = input.status ?? statusFromCodexStatus(input.item.status, "in_progress");
  const changesPath = firstChangePath(input.item.changes);
  const editPreview =
    input.item.type === "fileChange"
      ? extractToolEditPreview(
          { path: changesPath, changes: input.item.changes },
          {
            path: changesPath,
            changes: input.item.changes,
            status: input.item.status,
            diff: input.item.diff,
          },
          changesPath
        )
      : undefined;
  const common = {
    eventId: input.eventId,
    conversationId: input.conversationId,
    toolCallId: id,
    title: itemTitle(input.item),
    toolKind: itemToolKind(input.item),
    status,
    detail: itemDetail(input.item),
    locations: changesPath ? [{ path: changesPath }] : undefined,
    editPreview,
    raw: input.item,
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

export function codexAppServerStatusFromTurn(params: CodexAppServerRecord):
  | {
      status: "idle" | "failed" | "interrupted";
      detail?: string;
    }
  | null {
  const turn = asRecord(params.turn);
  const status = turn?.status;
  const error = asRecord(turn?.error);
  const detail =
    asString(error?.message) ??
    compactJson(error?.codexErrorInfo) ??
    compactJson(error?.additionalDetails);
  if (status === "completed") {
    return { status: "idle", detail };
  }
  if (status === "interrupted") {
    return { status: "interrupted", detail };
  }
  if (status === "failed") {
    return { status: "failed", detail };
  }
  return null;
}

function permissionOptions(values: unknown, fallback: string[]): AgentPermissionOption[] {
  const rawValues = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : fallback;
  return rawValues.map((value) => {
    const lower = value.toLowerCase();
    const kind =
      lower.includes("decline") || lower.includes("reject")
        ? "reject_once"
        : lower.includes("cancel")
          ? "reject_once"
          : lower.includes("session") || lower.includes("always")
            ? "allow_always"
            : "allow_once";
    return {
      optionId: value,
      name:
        value === "acceptForSession"
          ? "Accept for session"
          : value === "accept"
            ? "Accept"
            : value === "decline"
              ? "Decline"
              : value === "cancel"
                ? "Cancel"
                : value,
      kind,
    };
  });
}

export function codexAppServerPermissionRequestFromServerRequest(
  input: PermissionRequestInput
): Extract<AgentEventInput, { kind: "permission_request" }> | null {
  const params = input.params ?? {};
  if (input.method === "item/commandExecution/requestApproval") {
    const command = commandText(params.command);
    return {
      eventId: input.eventId,
      conversationId: input.conversationId,
      kind: "permission_request",
      requestId: input.requestId,
      toolCallId: asString(params.itemId),
      title: "Approve command",
      detail: [asString(params.reason), command, asString(params.cwd)].filter(Boolean).join("\n"),
      options: permissionOptions(params.availableDecisions, [
        "accept",
        "acceptForSession",
        "decline",
        "cancel",
      ]),
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
      detail: [asString(params.reason), asString(params.grantRoot)].filter(Boolean).join("\n"),
      options: permissionOptions(params.availableDecisions, [
        "accept",
        "acceptForSession",
        "decline",
        "cancel",
      ]),
      raw: { method: input.method, params },
    };
  }
  if (input.method === "tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    return {
      eventId: input.eventId,
      conversationId: input.conversationId,
      kind: "permission_request",
      requestId: input.requestId,
      title: "Codex requests input",
      detail: compactJson(questions) ?? "Codex requested user input.",
      options: [],
      raw: { method: input.method, params },
    };
  }
  return null;
}

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
      return optionId ?? "cancel";
  }
}
