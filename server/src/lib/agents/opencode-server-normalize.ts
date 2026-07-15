import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./json-coerce.js";
import { openCodeToolPartToAcpSessionUpdate } from "./opencode-global-sse.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import type { AgentEventInput, AgentPlanEntry, AgentToolCallStatus } from "./types.js";

type RecordValue = Record<string, unknown>;

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asString(record.text) ?? asString(record.content) ?? asString(record.value);
}

function partText(part: RecordValue): string | undefined {
  return (
    asString(part.text) ??
    asString(part.content) ??
    contentText(part.content) ??
    contentText(asRecord(part.state)?.text) ??
    contentText(asRecord(part.state)?.output)
  );
}

function normalizeStatus(value: unknown, fallback: AgentToolCallStatus): AgentToolCallStatus {
  switch (value) {
    case "pending":
      return "pending";
    case "running":
    case "in_progress":
      return "in_progress";
    case "completed":
    case "success":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    default:
      return fallback;
  }
}

function detailFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return contentText(content);
  }
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return contentText(record?.content) ?? contentText(entry);
    })
    .filter(Boolean)
    .join("\n")
    .trim() || undefined;
}

function toolEventFromAcpUpdate(input: {
  update: RecordValue;
  conversationId: string;
  raw: unknown;
  emitAsUpdate?: boolean;
}): AgentEventInput | null {
  const toolCallId = asString(input.update.toolCallId);
  if (!toolCallId) {
    return null;
  }
  const status = normalizeStatus(input.update.status, input.emitAsUpdate ? "in_progress" : "pending");
  const title = asString(input.update.title) ?? "Tool";
  const toolKind = asString(input.update.kind) ?? "tool";
  const rawInput = input.update.rawInput;
  const rawOutput = input.update.rawOutput;
  const editPreview =
    toolKind === "edit" ? extractToolEditPreview(rawInput, rawOutput) : undefined;
  const common = {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    toolCallId,
    title,
    toolKind,
    status,
    detail: detailFromContent(input.update.content) ?? detailFromContent(rawOutput),
    locations: Array.isArray(input.update.locations)
      ? (input.update.locations as Array<{ path: string }>)
      : undefined,
    editPreview,
    raw: input.raw,
  };
  return input.emitAsUpdate
    ? { ...common, kind: "tool_call_update" }
    : { ...common, kind: "tool_call" };
}

function planEntriesFromTodos(todos: unknown): AgentPlanEntry[] {
  if (!Array.isArray(todos)) {
    return [];
  }
  return todos.flatMap((todo, index) => {
    const record = asRecord(todo);
    const content = asString(record?.content) ?? asString(record?.text) ?? asString(record?.title);
    if (!content) {
      return [];
    }
    const rawStatus = asString(record?.status)?.toLowerCase();
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "blocked" || rawStatus === "stuck"
          ? "blocked"
        : rawStatus === "in_progress" || rawStatus === "running"
          ? "in_progress"
          : "pending";
    return [
      {
        id: asString(record?.id) ?? `opencode-server-todo-${index}`,
        content,
        status,
      },
    ];
  });
}

export function normalizeOpenCodeServerMessage(input: {
  conversationId: string;
  messageId: string;
  response: { info?: RecordValue; parts?: RecordValue[] };
}): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  const messageId = input.messageId;
  const role = asString(input.response.info?.role);
  for (const part of input.response.parts ?? []) {
    if (part.type === "tool") {
      const update = openCodeToolPartToAcpSessionUpdate(part);
      const event = update
        ? toolEventFromAcpUpdate({
            update,
            conversationId: input.conversationId,
            raw: part,
            emitAsUpdate: update.sessionUpdate === "tool_call_update",
          })
        : null;
      if (event) {
        events.push(event);
      }
      continue;
    }
    if (part.type === "reasoning") {
      const text = partText(part);
      if (text) {
        events.push({
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "reasoning",
          messageId: `${messageId}-reasoning`,
          text,
          raw: part,
        });
      }
      continue;
    }
    const text = partText(part);
    if (text && part.type === "text" && role !== "user") {
      events.push({
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "assistant_message_chunk",
        messageId,
        text,
        raw: part,
      });
    }
    const entries = planEntriesFromTodos(part.todos ?? asRecord(part.state)?.todos);
    if (entries.length > 0) {
      events.push({
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "plan",
        planId: `${input.conversationId}-opencode-server-todos`,
        entries,
        raw: part,
      });
    }
  }
  return events;
}

export function normalizeOpenCodeServerEvent(input: {
  conversationId: string;
  rootSessionId: string;
  payload: RecordValue;
  allowChildSessionEvents?: boolean;
}): AgentEventInput[] {
  const type = asString(input.payload.type);
  const properties = asRecord(input.payload.properties);
  if (!type || !properties) {
    return [];
  }
  const sessionID = asString(properties.sessionID) ?? asString(asRecord(properties.part)?.sessionID);
  const childSessionId = sessionID && sessionID !== input.rootSessionId ? sessionID : undefined;
  if (childSessionId && !input.allowChildSessionEvents) {
    return [];
  }
  if (type === "message.part.delta" && properties.field === "text") {
    // The native server emits text deltas for user/noReply seed messages too.
    // OpenCode Server's prompt harness handles assistant text updates only after
    // it has identified the active assistant message, so this generic normalizer
    // intentionally ignores raw text deltas to avoid echoing seed/user content.
    return [];
  }
  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    if (!part) {
      return [];
    }
    const update = openCodeToolPartToAcpSessionUpdate(part);
    if (update) {
      const event = toolEventFromAcpUpdate({
        update,
        conversationId: input.conversationId,
        raw: input.payload,
        emitAsUpdate: update.sessionUpdate === "tool_call_update",
      });
      if (!event) {
        return [];
      }
      return childSessionId && (event.kind === "tool_call" || event.kind === "tool_call_update")
        ? [{ ...event, openCodeSubagentSessionId: childSessionId }]
        : [event];
    }
    // Non-tool text updates include user/noReply seed content. The provider
    // session handles active assistant text separately once it knows the message id.
  }
  if (type === "permission.updated") {
    const permission = asRecord(properties.permission) ?? properties;
    const id = asString(permission.id) ?? asString(permission.permissionID);
    if (!id) {
      return [];
    }
    return [
      {
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "permission_request",
        requestId: id,
        title: asString(permission.title) ?? "OpenCode permission",
        detail: asString(permission.description) ?? asString(permission.message),
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        raw: input.payload,
      },
    ];
  }
  if (type === "session.error" || type === "message.error") {
    return [
      {
        eventId: randomUUID(),
        conversationId: input.conversationId,
        kind: "system",
        level: "error",
        text: asString(properties.message) ?? "OpenCode Server emitted an error.",
        raw: input.payload,
      },
    ];
  }
  return [];
}

export function openCodeServerPermissionResponse(optionId: string | undefined, cancelled?: boolean): RecordValue {
  if (cancelled || optionId === "deny") {
    return { response: "deny" };
  }
  return { response: "allow", remember: optionId === "allow_always" };
}
