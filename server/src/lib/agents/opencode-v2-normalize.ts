import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./json-coerce.js";
import {
  mapOpenCodeToolLocations,
  mapOpenCodeToolNameToAcpKind,
} from "./opencode-global-sse.js";
import { extractOpenCodeToolEditPreview } from "./tool-edit-preview.js";
import type { AgentEventInput, AgentToolCallStatus } from "./types.js";

type RecordValue = Record<string, unknown>;

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return asString(content);
  }
  const text = content
    .flatMap((entry) => {
      const record = asRecord(entry);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  const record = asRecord(error);
  if (!record) {
    return "OpenCode v2 tool failed.";
  }
  return (
    asString(record.message) ??
    asString(asRecord(record.data)?.message) ??
    asString(record.name) ??
    "OpenCode v2 tool failed."
  );
}

function parseToolInput(text: unknown): RecordValue {
  if (typeof text !== "string" || !text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed) ?? { value: parsed };
  } catch {
    return { raw: text };
  }
}

function mergeRawOutput(data: RecordValue): RecordValue {
  const output: RecordValue = {};
  // Beta servers carry tool UI metadata (`exit`, `truncated`, subagent
  // `sessionID`/`status`, shell `shellID`, ...) in `metadata`; keep it on the
  // event like the v1 adapter does so the UI can link subagent cards etc.
  const metadata = asRecord(data.metadata);
  if (metadata) {
    Object.assign(output, { metadata });
  }
  const structured = asRecord(data.structured);
  if (structured) {
    Object.assign(output, structured);
  }
  const result = data.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    Object.assign(output, result as RecordValue);
  } else if (result !== undefined) {
    output.result = result;
  }
  const detail = contentText(data.content);
  if (detail) {
    output.output = detail;
  }
  if (data.error !== undefined) {
    output.error = errorText(data.error);
  }
  return output;
}

function rememberBounded(set: Set<string>, value: string, limit = 2_000): void {
  if (set.size >= limit) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(value);
}

function toolStatus(type: string): AgentToolCallStatus {
  if (type === "session.tool.success") return "completed";
  if (type === "session.tool.failed") return "failed";
  if (type === "session.tool.input.started") return "pending";
  return "in_progress";
}

function questionOptions(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((option, index) => {
    const record = asRecord(option);
    const label = asString(record?.label);
    return label ? [{ id: `option-${index + 1}`, label }] : [];
  });
}

function formFieldOptions(field: RecordValue): Array<{ id: string; label: string }> {
  if (field.type === "boolean") {
    return [
      { id: "true", label: "Yes" },
      { id: "false", label: "No" },
    ];
  }
  if (!Array.isArray(field.options)) {
    return [];
  }
  return field.options.flatMap((option, index) => {
    const record = asRecord(option);
    const value = asString(record?.value);
    const label = asString(record?.label);
    return value && label ? [{ id: value || `option-${index + 1}`, label }] : [];
  });
}

export function openCodeV2EventSessionId(payload: RecordValue): string | undefined {
  const data = asRecord(payload.data);
  const durable = asRecord(payload.durable);
  return (
    asString(data?.sessionID) ??
    asString(asRecord(data?.form)?.sessionID) ??
    asString(asRecord(data?.session)?.id) ??
    asString(asRecord(data?.source)?.sessionID) ??
    asString(asRecord(asRecord(data?.info)?.metadata)?.sessionID) ??
    asString(durable?.aggregateID)
  );
}

export function openCodeV2PermissionReply(
  optionId: string | undefined,
  cancelled?: boolean
): "once" | "always" | "reject" {
  if (cancelled || optionId === "deny" || optionId === "reject") {
    return "reject";
  }
  return optionId === "allow_always" || optionId === "always" ? "always" : "once";
}

/**
 * Tool call identifier on `session.tool.*` events. The shipped v2 beta
 * (`ToolBase = { sessionID, assistantMessageID, id }`) uses `id`; `callID`
 * is kept for the pre-release dialect so older servers keep working.
 */
export function openCodeV2ToolCallId(data: RecordValue | undefined): string | undefined {
  return asString(data?.id) ?? asString(data?.callID);
}

/**
 * Child session spawned by a `subagent`/`task` tool call. The beta server
 * reports it via `session.tool.progress` / `session.tool.success` as
 * `metadata: { sessionID, status }`; the pre-release dialect used
 * `structured.sessionID` / `structured.childID`.
 */
export function openCodeV2ChildSessionId(payload: RecordValue): string | undefined {
  const data = asRecord(payload.data);
  const structured = asRecord(data?.structured);
  const fromStructured = asString(structured?.sessionID) ?? asString(structured?.childID);
  if (fromStructured) return fromStructured;
  const type = asString(payload.type);
  if (!type?.startsWith("session.tool.")) return undefined;
  const metadata = asRecord(data?.metadata);
  const candidate = asString(metadata?.sessionID) ?? asString(metadata?.childID);
  // Shell tools report `metadata.shellID`; only subagent progress/results carry a
  // child *session* id, which always differs from the emitting session.
  return candidate && candidate !== asString(data?.sessionID) ? candidate : undefined;
}

/**
 * Permission request payload from `permission.asked` (beta) or the
 * pre-release `permission.v2.asked` alias.
 */
export function readOpenCodeV2PermissionRequest(payload: RecordValue): RecordValue | null {
  if (payload.type !== "permission.asked" && payload.type !== "permission.v2.asked") {
    return null;
  }
  const data = asRecord(payload.data);
  return data && asString(data.id) ? data : null;
}

/**
 * Normalized `permission_request` for a v2 permission request, whether it
 * arrived as a `permission.asked` event or was discovered by polling
 * `GET /api/permission/request` (same `Permission.Request` shape).
 */
export function openCodeV2PermissionRequestEvent(input: {
  conversationId: string;
  request: RecordValue;
  raw?: unknown;
}): Extract<AgentEventInput, { kind: "permission_request" }> {
  const data = input.request;
  const action = asString(data.action) ?? "permission";
  const resources = Array.isArray(data.resources)
    ? data.resources.filter((value): value is string => typeof value === "string")
    : [];
  const save = Array.isArray(data.save)
    ? data.save.filter((value): value is string => typeof value === "string")
    : [];
  const message = asString(data.message);
  // write/edit asks carry `metadata.files[]` ({ file, status, additions, deletions, patch }).
  const files = Array.isArray(asRecord(data.metadata)?.files)
    ? (asRecord(data.metadata)!.files as unknown[]).flatMap((entry) => {
        const file = asRecord(entry);
        const name = asString(file?.file) ?? asString(file?.path);
        if (!name) return [];
        const additions = typeof file?.additions === "number" ? file.additions : undefined;
        const deletions = typeof file?.deletions === "number" ? file.deletions : undefined;
        const counts =
          additions != null || deletions != null ? ` (+${additions ?? 0} -${deletions ?? 0})` : "";
        return [`${asString(file?.status) ?? "change"} ${name}${counts}`];
      })
    : [];
  const detailLines = [
    ...(message ? [message] : []),
    ...resources.filter((resource) => !files.some((line) => line.includes(resource))),
    ...files,
    ...(save.length > 0 ? [`Allow Always remembers: ${save.join(", ")}`] : []),
  ];
  return {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    kind: "permission_request",
    requestId: asString(data.id)!,
    title: `OpenCode requests ${action}`,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    toolCallId: openCodeV2PermissionToolCallId(data),
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    raw: input.raw ?? input.request,
  };
}

/**
 * Tool call that raised a permission. The beta uses `source: { type: "tool",
 * messageID, id }`; the pre-release dialect used `source.callID`.
 */
export function openCodeV2PermissionToolCallId(data: RecordValue): string | undefined {
  const source = asRecord(data.source);
  const callId = asString(source?.callID) ?? asString(source?.id);
  const sessionId = asString(data.sessionID);
  return callId ? `opencode-v2:${sessionId ?? "global"}:${callId}` : undefined;
}

export type OpenCodeV2QuestionRequest = {
  id: string;
  sessionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
};

export function readOpenCodeV2QuestionRequest(
  payload: RecordValue
): OpenCodeV2QuestionRequest | null {
  if (payload.type !== "question.asked" && payload.type !== "question.v2.asked") {
    return null;
  }
  const data = asRecord(payload.data);
  const id = asString(data?.id);
  const sessionId = asString(data?.sessionID);
  if (!id || !sessionId || !Array.isArray(data?.questions)) {
    return null;
  }
  const questions = data.questions.flatMap((question) => {
    const record = asRecord(question);
    const text = asString(record?.question);
    if (!text) return [];
    return [
      {
        question: text,
        header: asString(record?.header) ?? text,
        options: Array.isArray(record?.options)
          ? record.options.flatMap((option) => {
              const row = asRecord(option);
              const label = asString(row?.label);
              return label
                ? [{ label, ...(asString(row?.description) ? { description: asString(row?.description) } : {}) }]
                : [];
            })
          : [],
        ...(record?.multiple === true ? { multiple: true } : {}),
      },
    ];
  });
  return questions.length > 0 ? { id, sessionId, questions } : null;
}

export type OpenCodeV2FormField = {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  multiple?: boolean;
};

export type OpenCodeV2FormRequest = {
  id: string;
  sessionId: string;
  title: string;
  fields: OpenCodeV2FormField[];
  location?: { directory?: string; workspaceID?: string };
  /** `metadata.kind` ("question" for the question tool). */
  kind?: string;
};

/**
 * Human prompt for a form field. The question tool publishes its questions as
 * a form whose field `title` is a short header ("Color Preference") and whose
 * `description` holds the actual question ("Which color do you prefer?").
 */
export function openCodeV2FormFieldPrompt(field: OpenCodeV2FormField, formKind?: string): string {
  if (formKind === "question" && field.description) {
    return field.description;
  }
  return field.title ?? field.description ?? field.key;
}

/** Top-level prompt for a form: a single question reads as the question itself. */
export function openCodeV2FormPrompt(form: OpenCodeV2FormRequest): string {
  if (form.fields.length === 1) {
    return openCodeV2FormFieldPrompt(form.fields[0]!, form.kind);
  }
  return form.title;
}

export function readOpenCodeV2FormRequest(payload: RecordValue): OpenCodeV2FormRequest | null {
  if (payload.type !== "form.created") {
    return null;
  }
  const form = asRecord(asRecord(payload.data)?.form);
  const id = asString(form?.id);
  const sessionId = asString(form?.sessionID);
  if (!id || !sessionId || !Array.isArray(form?.fields)) {
    return null;
  }
  const fields = form.fields.flatMap((field) => {
    const record = asRecord(field);
    const key = asString(record?.key);
    const type = asString(record?.type);
    if (!key || !type || type === "external") return [];
    const options = Array.isArray(record?.options)
      ? record.options.flatMap((option) => {
          const row = asRecord(option);
          const value = asString(row?.value);
          const label = asString(row?.label);
          return value && label ? [{ value, label }] : [];
        })
      : undefined;
    return [
      {
        key,
        type,
        ...(asString(record?.title) ? { title: asString(record?.title) } : {}),
        ...(asString(record?.description) ? { description: asString(record?.description) } : {}),
        ...(options ? { options } : {}),
        ...(type === "multiselect" ? { multiple: true } : {}),
      },
    ];
  });
  const location = asRecord(payload.location);
  const kind = asString(asRecord(form.metadata)?.kind);
  return fields.length > 0
    ? {
        id,
        sessionId,
        title: asString(form.title) ?? "OpenCode form",
        fields,
        ...(kind ? { kind } : {}),
        ...(location
          ? {
              location: {
                ...(asString(location.directory) ? { directory: asString(location.directory) } : {}),
                ...(asString(location.workspaceID) ? { workspaceID: asString(location.workspaceID) } : {}),
              },
            }
          : {}),
      }
    : null;
}

export class OpenCodeV2EventNormalizer {
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, RecordValue>();
  private readonly emittedText = new Map<string, string>();
  private readonly emittedReasoning = new Map<string, string>();
  /** Shell processes spawned on behalf of a `session.tool.*` call (see `shell.*` handling). */
  private readonly toolOwnedShells = new Set<string>();
  /** Shells / PTYs this conversation saw created without an owning tool call. */
  private readonly standaloneShells = new Set<string>();
  /** Last status emitted per tool call (`${sessionId}:${callId}`), for reconciliation. */
  private readonly toolStatuses = new Map<string, AgentToolCallStatus>();

  /**
   * Re-derive tool state from `GET /api/session/:id/message` after the volatile
   * event stream dropped events (reconnect). Emits a `tool_call`/`tool_call_update`
   * for every tool part whose status differs from what was last streamed, so no
   * card stays stuck in "running" and no completed call goes unreported.
   */
  reconcileMessages(input: {
    conversationId: string;
    sessionId: string;
    messages: RecordValue[];
    childSessionId?: string;
  }): AgentEventInput[] {
    const events: AgentEventInput[] = [];
    for (const message of input.messages) {
      if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
      const assistantMessageId = asString(message.id);
      for (const entry of message.content) {
        const part = asRecord(entry);
        if (part?.type !== "tool") continue;
        const callId = asString(part.id) ?? asString(part.callID);
        const state = asRecord(part.state);
        const status = asString(state?.status);
        if (!callId || !state || !status) continue;
        const key = `${input.sessionId}:${callId}`;
        const known = this.toolStatuses.get(key);
        const target: AgentToolCallStatus =
          status === "completed"
            ? "completed"
            : status === "error"
              ? "failed"
              : status === "pending"
                ? "pending"
                : "in_progress";
        if (known === target) continue;
        if (known === "completed" || known === "failed") continue;
        const type =
          target === "completed"
            ? "session.tool.success"
            : target === "failed"
              ? "session.tool.failed"
              : target === "pending"
                ? "session.tool.input.started"
                : "session.tool.called";
        const name = asString(part.name) ?? this.toolNames.get(key);
        if (name && !this.toolNames.has(key)) this.toolNames.set(key, name);
        const data: RecordValue = {
          sessionID: input.sessionId,
          ...(assistantMessageId ? { assistantMessageID: assistantMessageId } : {}),
          id: callId,
          ...(name ? { name } : {}),
          ...(asRecord(state.input) ? { input: state.input } : {}),
          ...(state.content !== undefined ? { content: state.content } : {}),
          ...(asRecord(state.metadata) ? { metadata: state.metadata } : {}),
          ...(state.error !== undefined ? { error: state.error } : {}),
        };
        const payload: RecordValue = {
          type,
          data,
          reconciled: true,
        };
        if (known === undefined && target !== "pending") {
          // Never streamed at all: open the card before completing it.
          events.push(
            ...this.normalizeTool({
              conversationId: input.conversationId,
              payload: { ...payload, type: "session.tool.input.started" },
              type: "session.tool.input.started",
              data,
              childSessionId: input.childSessionId,
            })
          );
        }
        events.push(
          ...this.normalizeTool({
            conversationId: input.conversationId,
            payload,
            type,
            data,
            childSessionId: input.childSessionId,
          })
        );
      }
    }
    return events;
  }

  normalize(input: {
    conversationId: string;
    rootSessionId: string;
    payload: RecordValue;
    rootMessageId?: string;
    childSessionId?: string;
  }): AgentEventInput[] {
    const type = asString(input.payload.type);
    const data = asRecord(input.payload.data);
    if (!type || !data) {
      return [];
    }
    const sessionId = openCodeV2EventSessionId(input.payload);
    const isChild = Boolean(input.childSessionId && sessionId === input.childSessionId);

    if (type === "session.text.delta" || type === "session.text.ended") {
      const assistantMessageId = asString(data.assistantMessageID);
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      const nextPiece = type.endsWith(".delta") ? asString(data.delta) : asString(data.text);
      const messageId = isChild
        ? `opencode-subagent:${input.childSessionId}:${assistantMessageId ?? ordinal}`
        : input.rootMessageId;
      if (!messageId || !assistantMessageId || !nextPiece) {
        return [];
      }
      const key = `${sessionId}:${assistantMessageId}:${ordinal}`;
      const previous = this.emittedText.get(key) ?? "";
      const delta =
        type.endsWith(".delta")
          ? nextPiece
          : previous && nextPiece.startsWith(previous)
            ? nextPiece.slice(previous.length)
            : previous === nextPiece
              ? ""
              : nextPiece;
      this.emittedText.set(key, type.endsWith(".delta") ? previous + nextPiece : nextPiece);
      return delta
        ? [
            {
              eventId: randomUUID(),
              conversationId: input.conversationId,
              kind: "assistant_message_chunk",
              messageId,
              text: delta,
              raw: input.payload,
            },
          ]
        : [];
    }

    if (type === "session.reasoning.delta" || type === "session.reasoning.ended") {
      if (isChild || !input.rootMessageId) {
        return [];
      }
      const assistantMessageId = asString(data.assistantMessageID);
      const ordinal = typeof data.ordinal === "number" ? data.ordinal : 0;
      const nextPiece = type.endsWith(".delta") ? asString(data.delta) : asString(data.text);
      if (!assistantMessageId || !nextPiece) {
        return [];
      }
      const key = `${sessionId}:${assistantMessageId}:${ordinal}`;
      const previous = this.emittedReasoning.get(key) ?? "";
      const delta =
        type.endsWith(".delta")
          ? nextPiece
          : previous && nextPiece.startsWith(previous)
            ? nextPiece.slice(previous.length)
            : previous === nextPiece
              ? ""
              : nextPiece;
      this.emittedReasoning.set(key, type.endsWith(".delta") ? previous + nextPiece : nextPiece);
      return delta
        ? [
            {
              eventId: randomUUID(),
              conversationId: input.conversationId,
              kind: "reasoning",
              messageId: `${input.rootMessageId}-reasoning`,
              text: delta,
              raw: input.payload,
            },
          ]
        : [];
    }

    if (type.startsWith("session.tool.")) {
      return this.normalizeTool({
        conversationId: input.conversationId,
        payload: input.payload,
        type,
        data,
        childSessionId: isChild ? input.childSessionId : undefined,
      });
    }

    if (
      type === "session.shell.started" ||
      type === "session.shell.ended" ||
      type === "session.next.shell.started" ||
      type === "session.next.shell.ended"
    ) {
      const shell = asRecord(data.shell);
      const shellId =
        asString(shell?.id) ?? asString(data.callID) ?? asString(data.id);
      if (!sessionId || !shellId) return [];
      const ended = type.endsWith(".ended") || type.endsWith(".exited");
      const output = asRecord(data.output);
      const detail = ended
        ? asString(data.output) ?? asString(output?.output)
        : asString(data.command) ?? asString(shell?.command);
      const status: AgentToolCallStatus = ended
        ? shell?.status === "exited" && (shell.exit == null || shell.exit === 0)
          ? "completed"
          : asString(data.output) != null
            ? "completed"
            : "failed"
        : "in_progress";
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: ended ? "tool_call_update" : "tool_call",
          toolCallId: `opencode-v2-shell:${sessionId}:${shellId}`,
          title: asString(data.command) ?? asString(shell?.command) ?? "shell",
          toolKind: "terminal",
          status,
          detail,
          ...(isChild ? { openCodeSubagentSessionId: input.childSessionId } : {}),
          raw: input.payload,
        },
      ];
    }

    if (
      type === "pty.created" ||
      type === "pty.updated" ||
      type === "pty.exited" ||
      type === "pty.deleted" ||
      type === "shell.created" ||
      type === "shell.exited" ||
      type === "shell.deleted"
    ) {
      const info = asRecord(data.info) ?? data;
      const ptyId = asString(info.id) ?? asString(data.id);
      if (!ptyId) return [];
      if (type.startsWith("shell.")) {
        // The beta wraps every `shell` tool call in a shell process and emits
        // `shell.created` / `shell.exited` for it (`info.metadata.sessionID`).
        // The `session.tool.*` card already shows that command and its output,
        // so a second terminal card per command is noise. Standalone shells
        // (no owning session) still get their own card.
        if (type === "shell.created") {
          if (asString(asRecord(info.metadata)?.sessionID)) {
            rememberBounded(this.toolOwnedShells, ptyId);
            return [];
          }
          rememberBounded(this.standaloneShells, ptyId);
        } else if (this.toolOwnedShells.has(ptyId)) {
          if (type !== "shell.exited") this.toolOwnedShells.delete(ptyId);
          return [];
        } else if (!this.standaloneShells.has(ptyId)) {
          // `shell.exited` / `shell.deleted` carry no session: on a server shared
          // by several conversations this may be someone else's shell. Only
          // render lifecycle updates for shells this conversation saw created.
          return [];
        }
      } else if (type !== "pty.created" && !this.standaloneShells.has(ptyId)) {
        return [];
      } else if (type === "pty.created") {
        rememberBounded(this.standaloneShells, ptyId);
      }
      const ended = type.endsWith(".exited") || type.endsWith(".deleted");
      const command = asString(info.command) ?? asString(info.title) ?? type.split(".")[0] ?? "pty";
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: type.endsWith(".created") ? "tool_call" : "tool_call_update",
          toolCallId: `opencode-v2-${type.startsWith("pty.") ? "pty" : "shell"}:${ptyId}`,
          title: command,
          toolKind: "terminal",
          status: ended ? "completed" : "in_progress",
          detail: asString(info.cwd) ?? asString(info.message) ?? command,
          raw: input.payload,
        },
      ];
    }

    const permission = readOpenCodeV2PermissionRequest(input.payload);
    if (permission) {
      return [
        openCodeV2PermissionRequestEvent({
          conversationId: input.conversationId,
          request: permission,
          raw: input.payload,
        }),
      ];
    }

    if (type === "session.retry.scheduled" || type === "session.step.failed") {
      // OpenCode retries transient provider failures itself; surface them as
      // warnings instead of silently stalling (the turn is still running).
      const attempt = typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : "";
      const message = errorText(data.error);
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "system",
          level: "warning",
          text:
            type === "session.retry.scheduled"
              ? `OpenCode hit a transient provider error and is retrying${attempt}: ${message}`
              : `OpenCode step failed: ${message}`,
          raw: input.payload,
        },
      ];
    }

    const question = readOpenCodeV2QuestionRequest(input.payload);
    if (question) {
      const questions = question.questions.map((entry, index) => ({
        id: `question-${index + 1}`,
        prompt: entry.question,
        options: questionOptions(entry.options),
        allowMultiple: entry.multiple,
      }));
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "question",
          questionId: question.id,
          prompt: question.questions.length === 1 ? question.questions[0]!.question : "OpenCode questions",
          options: questions[0]?.options ?? [],
          questions,
          allowMultiple: question.questions.length === 1 && question.questions[0]?.multiple,
          status: "pending",
          raw: input.payload,
        },
      ];
    }

    const form = readOpenCodeV2FormRequest(input.payload);
    if (form) {
      const questions = form.fields.map((field) => ({
        id: field.key,
        prompt: openCodeV2FormFieldPrompt(field, form.kind),
        options: formFieldOptions({
          type: field.type,
          options: field.options,
        }),
        allowMultiple: field.multiple,
      }));
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "question",
          questionId: form.id,
          prompt: openCodeV2FormPrompt(form),
          options: questions[0]?.options ?? [],
          questions,
          allowMultiple: questions.length === 1 && questions[0]?.allowMultiple,
          status: "pending",
          raw: input.payload,
        },
      ];
    }

    return [];
  }

  private normalizeTool(input: {
    conversationId: string;
    payload: RecordValue;
    type: string;
    data: RecordValue;
    childSessionId?: string;
  }): AgentEventInput[] {
    const callId = openCodeV2ToolCallId(input.data);
    const sessionId = asString(input.data.sessionID);
    if (!callId || !sessionId) {
      return [];
    }
    const cacheKey = `${sessionId}:${callId}`;
    if (input.type === "session.tool.input.started") {
      this.toolNames.set(cacheKey, asString(input.data.name) ?? "tool");
    } else if (input.type === "session.tool.input.ended") {
      this.toolInputs.set(cacheKey, parseToolInput(input.data.text));
    } else if (input.type === "session.tool.called") {
      this.toolInputs.set(cacheKey, asRecord(input.data.input) ?? {});
    }
    if (input.type === "session.tool.input.delta" || input.type === "session.tool.input.ended") {
      return [];
    }
    const name = this.toolNames.get(cacheKey) ?? asString(input.data.name) ?? "tool";
    const rawInput = this.toolInputs.get(cacheKey) ?? asRecord(input.data.input) ?? {};
    const status = toolStatus(input.type);
    this.toolStatuses.set(cacheKey, status);
    if (this.toolStatuses.size > 5_000) {
      const oldest = this.toolStatuses.keys().next().value;
      if (oldest) this.toolStatuses.delete(oldest);
    }
    const kind = mapOpenCodeToolNameToAcpKind(name);
    const locations = mapOpenCodeToolLocations(name, rawInput);
    const rawOutput = mergeRawOutput(input.data);
    const detail =
      contentText(input.data.content) ??
      (input.type === "session.tool.failed" ? errorText(input.data.error) : undefined);
    const title =
      (name === "subagent" || name === "task") && typeof rawInput.description === "string"
        ? rawInput.description
        : name;
    const editPreview =
      kind === "edit" ? extractOpenCodeToolEditPreview(name, rawInput, rawOutput) : undefined;
    const raw = {
      ...input.payload,
      tool: name,
      title: name,
      rawInput,
      input: rawInput,
      structured: input.data.structured,
      rawOutput,
    };
    const common = {
      eventId: randomUUID(),
      conversationId: input.conversationId,
      toolCallId: `opencode-v2:${sessionId}:${callId}`,
      title,
      toolKind: kind,
      status,
      detail,
      locations: locations.length > 0 ? locations : undefined,
      editPreview,
      ...(input.childSessionId
        ? { openCodeSubagentSessionId: input.childSessionId }
        : {}),
      raw,
    };
    if (input.type === "session.tool.input.started") {
      return [{ ...common, kind: "tool_call" }];
    }
    return [{ ...common, kind: "tool_call_update" }];
  }
}
