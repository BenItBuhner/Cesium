import { randomUUID } from "node:crypto";
import {
  compactToolJson,
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "./tool-normalize.js";
import type {
  AgentEventInput,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentToolCallStatus,
} from "./types.js";
import type { GoogleAntigravityEvent } from "./google-antigravity-cli-session.js";

export type GoogleAntigravityToolSnapshot = {
  toolCallId: string;
  title: string;
  toolKind: string;
  input?: unknown;
};

export type GoogleAntigravityPlanArtifactInput = {
  title: string;
  overview?: string;
  markdown?: string;
  entries?: AgentPlanEntry[];
  path?: string | null;
};

function createdAt(event: GoogleAntigravityEvent): number | undefined {
  const parsed = Date.parse(event.at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function permissionOptions(): AgentPermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
  ];
}

function canonicalToolKind(toolName: string, args?: unknown, result?: unknown): string {
  switch (toolName) {
    case "view_file":
      return "read";
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return "edit";
    case "list_dir":
    case "find_by_name":
      return "search";
    case "grep_search":
      return "grep";
    case "search_web":
      return "search_web";
    case "read_url_content":
      return "fetch";
    case "run_command":
      return "terminal";
    case "manage_task":
      return "todo";
    case "ask_permission":
    case "ask_question":
      return "question";
    case "invoke_subagent":
      return "task";
    default:
      return inferCanonicalToolKind({ name: toolName, input: args, result });
  }
}

function toolTitle(toolName: string, toolKind: string, input?: unknown, result?: unknown): string {
  if (toolName === "manage_task") {
    return "Update plan";
  }
  if (toolName === "invoke_subagent") {
    return "Invoke subagent";
  }
  if (toolName === "generate_image") {
    return "Generate image";
  }
  return titleForCanonicalTool({
    name: toolName,
    kind: toolKind,
    payload: { input, result },
  });
}

export function antigravityToolCallId(event: Pick<Extract<GoogleAntigravityEvent, { stepIdx: number }>, "sessionId" | "stepIdx">): string {
  const suffix = event.stepIdx >= 0 ? String(event.stepIdx) : randomUUID();
  return `antigravity-tool-${event.sessionId ?? "session"}-${suffix}`;
}

export function antigravityToolSnapshotFromEvent(
  event: Extract<GoogleAntigravityEvent, { type: "tool.proposed" }>
): GoogleAntigravityToolSnapshot {
  const toolKind = canonicalToolKind(event.toolName, event.args);
  return {
    toolCallId: antigravityToolCallId(event),
    title: toolTitle(event.toolName, toolKind, event.args),
    toolKind,
    input: event.args,
  };
}

export function antigravityStartToolEvent(input: {
  event: Extract<GoogleAntigravityEvent, { type: "tool.proposed" }>;
  conversationId: string;
  snapshot: GoogleAntigravityToolSnapshot;
}): AgentEventInput {
  return {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    createdAt: createdAt(input.event),
    kind: "tool_call",
    toolCallId: input.snapshot.toolCallId,
    title: input.snapshot.title,
    toolKind: input.snapshot.toolKind,
    status: "in_progress",
    detail: detailForToolPayload({ input: input.event.args }),
    locations: locationsForToolPayload({ input: input.event.args }),
    raw: input.event,
  };
}

export function antigravityFinishToolEvent(input: {
  event: Extract<GoogleAntigravityEvent, { type: "tool.finished" | "tool.failed" }>;
  conversationId: string;
  snapshot?: GoogleAntigravityToolSnapshot;
}): AgentEventInput {
  const failed = input.event.type === "tool.failed";
  const error = input.event.type === "tool.failed" ? input.event.error : undefined;
  const result = error ? { error } : undefined;
  const status: AgentToolCallStatus = failed ? "failed" : "completed";
  return {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    createdAt: createdAt(input.event),
    kind: "tool_call_update",
    toolCallId:
      input.snapshot?.toolCallId ??
      antigravityToolCallId({
        sessionId: input.event.sessionId,
        stepIdx: input.event.stepIdx,
      }),
    title: input.snapshot?.title,
    toolKind: input.snapshot?.toolKind,
    status,
    detail: error ?? detailForToolPayload({ input: input.snapshot?.input, result }),
    locations: locationsForToolPayload({ input: input.snapshot?.input, result }),
    raw: input.event,
  };
}

export function antigravityEventToAgentEvents(input: {
  event: GoogleAntigravityEvent;
  conversationId: string;
  assistantMessageId: string;
}): AgentEventInput[] {
  const { event, conversationId, assistantMessageId } = input;
  const base = {
    eventId: randomUUID(),
    conversationId,
    createdAt: createdAt(event),
    raw: event,
  };

  switch (event.type) {
    case "session.started":
      return [
        {
          ...base,
          kind: "status",
          status: "idle",
          detail: `Antigravity session started: ${event.command.join(" ")}`,
        },
      ];
    case "session.ready":
      return [{ ...base, kind: "status", status: "idle", detail: "Antigravity session ready." }];
    case "auth.required":
      return [
        {
          ...base,
          kind: "system",
          level: "warning",
          text: `Google Antigravity CLI auth is required. ${event.message.trim()}`,
        },
        {
          ...base,
          eventId: randomUUID(),
          kind: "status",
          status: "failed",
          detail: "Antigravity CLI requires ambient Google/Antigravity authentication.",
        },
      ];
    case "text.delta":
      return event.text
        ? [{ ...base, kind: "assistant_message_chunk", messageId: assistantMessageId, text: event.text }]
        : [];
    case "text.final":
      return [{ ...base, kind: "assistant_message_end", messageId: assistantMessageId, stopReason: "stop" }];
    case "thought.delta":
      return event.text
        ? [{ ...base, kind: "reasoning", messageId: assistantMessageId, text: event.text }]
        : [];
    case "permission.requested": {
      const title = event.action ? `Permission requested: ${event.action}` : "Permission requested";
      const detail = [event.target, event.reason].filter(Boolean).join("\n\n") || undefined;
      return [
        {
          ...base,
          kind: "permission_request",
          requestId: antigravityPermissionRequestId(event),
          title,
          detail,
          options: permissionOptions(),
        },
        {
          ...base,
          eventId: randomUUID(),
          kind: "status",
          status: "awaiting_permission",
          detail: title,
        },
      ];
    }
    case "subagent.spawned":
    case "subagent.updated":
    case "subagent.completed":
      return [
        {
          ...base,
          kind: "subagent",
          subagentId: antigravitySubagentId(event),
          title: subagentTitle(event.payload),
          meta: compactToolJson(event.payload, 240),
          status: event.type === "subagent.completed" ? "completed" : "running",
          transcript: [],
          recentActivity: event.type.replace("subagent.", ""),
        },
      ];
    case "artifact.created":
      return [
        {
          ...base,
          kind: "plan_file",
          path: event.path,
          title: "Antigravity artifact",
          previewMode: "preview",
        },
      ];
    case "conversation.renamed":
      return [{ ...base, kind: "system", level: "info", text: `Conversation renamed: ${event.title}` }];
    case "conversation.resumable":
      return [
        {
          ...base,
          kind: "system",
          level: "info",
          text: `Antigravity conversation can be resumed with id ${event.conversationId}.`,
        },
      ];
    case "session.stopped": {
      const status = event.reason && !/complete|success|stop|idle/i.test(event.reason) ? "failed" : "idle";
      return [{ ...base, kind: "status", status, detail: `Antigravity session stopped: ${event.reason}` }];
    }
    case "error":
      return [
        { ...base, kind: "system", level: "warning", text: event.error.message },
      ];
    case "prompt.submitted":
    case "tool.proposed":
    case "tool.finished":
    case "tool.failed":
      return [];
    default: {
      const exhaustive: never = event;
      return [{ ...base, kind: "system", level: "info", text: `Unhandled Antigravity event: ${String(exhaustive)}` }];
    }
  }
}

export function antigravityPermissionRequestId(
  event: Extract<GoogleAntigravityEvent, { type: "permission.requested" }>
): string {
  return `antigravity-permission-${event.sessionId ?? "session"}-${event.action ?? "request"}-${event.target ?? ""}`;
}

export function antigravityPlanArtifactFromTool(
  toolName: string,
  args: Record<string, unknown>
): GoogleAntigravityPlanArtifactInput | null {
  if (toolName !== "manage_task") {
    return null;
  }
  const title =
    stringValue(args.title) ??
    stringValue(args.name) ??
    stringValue(args.planTitle) ??
    "Antigravity Plan";
  const overview = stringValue(args.overview) ?? stringValue(args.description);
  const markdown =
    markdownValue(args.markdown) ??
    markdownValue(args.plan) ??
    markdownValue(args.planner_output) ??
    markdownValue(args.output);
  const path = stringValue(args.path) ?? stringValue(args.file_path) ?? null;
  const entries =
    entriesFromArray(args.tasks) ??
    entriesFromArray(args.entries) ??
    entriesFromArray(args.todos) ??
    entriesFromSingleTask(args.task);

  if (!markdown && (!entries || entries.length === 0) && !overview) {
    return null;
  }
  return {
    title,
    overview,
    markdown,
    entries,
    path,
  };
}

function entriesFromArray(value: unknown): AgentPlanEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: AgentPlanEntry[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string" && item.trim()) {
      entries.push({ id: `task-${index + 1}`, content: item.trim(), status: "pending" });
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const record = item as Record<string, unknown>;
    const content =
      stringValue(record.content) ??
      stringValue(record.title) ??
      stringValue(record.description) ??
      stringValue(record.task);
    if (!content) {
      return;
    }
    entries.push({
      id: stringValue(record.id) ?? `task-${index + 1}`,
      content,
      status: planStatus(record.status),
      priority: stringValue(record.priority),
    });
  });
  return entries.length > 0 ? entries : undefined;
}

function entriesFromSingleTask(value: unknown): AgentPlanEntry[] | undefined {
  const entries = entriesFromArray(value ? [value] : undefined);
  return entries;
}

function planStatus(value: unknown): AgentPlanEntry["status"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["completed", "done", "success"].includes(normalized)) return "completed";
  if (["in_progress", "in-progress", "running", "active"].includes(normalized)) return "in_progress";
  if (["blocked", "failed"].includes(normalized)) return "blocked";
  return "pending";
}

function markdownValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^#|\n\s*[-*]\s+\[[ x!~]\]/i.test(trimmed) || trimmed.includes("\n")
    ? trimmed
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function subagentTitle(payload: Record<string, unknown>): string {
  return (
    stringValue(payload.name) ??
    stringValue(payload.title) ??
    stringValue(payload.description) ??
    stringValue(payload.subagent_type) ??
    "Antigravity subagent"
  );
}

function antigravitySubagentId(event: Extract<GoogleAntigravityEvent, { type: "subagent.spawned" | "subagent.updated" | "subagent.completed" }>): string {
  const payloadId =
    stringValue(event.payload.id) ??
    stringValue(event.payload.sessionId) ??
    stringValue(event.payload.conversationId);
  return payloadId ?? `antigravity-subagent-${event.sessionId ?? "session"}`;
}
