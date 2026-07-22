import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./json-coerce.js";
import {
  mapOpenCodeToolLocations,
  mapOpenCodeToolNameToAcpKind,
} from "./opencode-global-sse.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
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

export function openCodeV2ChildSessionId(payload: RecordValue): string | undefined {
  const data = asRecord(payload.data);
  const structured = asRecord(data?.structured);
  return asString(structured?.sessionID) ?? asString(structured?.childID);
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
  if (payload.type !== "question.v2.asked") {
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
};

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
  return fields.length > 0
    ? {
        id,
        sessionId,
        title: asString(form.title) ?? "OpenCode form",
        fields,
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

    if (type === "session.shell.started" || type === "session.shell.ended") {
      const shell = asRecord(data.shell);
      const shellId = asString(shell?.id);
      if (!sessionId || !shellId) return [];
      const ended = type.endsWith(".ended");
      const output = asRecord(data.output);
      const detail = ended ? asString(output?.output) : asString(shell?.command);
      const status: AgentToolCallStatus = ended
        ? shell?.status === "exited" && (shell.exit == null || shell.exit === 0)
          ? "completed"
          : "failed"
        : "in_progress";
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: ended ? "tool_call_update" : "tool_call",
          toolCallId: `opencode-v2-shell:${sessionId}:${shellId}`,
          title: asString(shell?.command) ?? "shell",
          toolKind: "terminal",
          status,
          detail,
          ...(isChild ? { openCodeSubagentSessionId: input.childSessionId } : {}),
          raw: input.payload,
        },
      ];
    }

    if (type === "permission.v2.asked") {
      const requestId = asString(data.id);
      if (!requestId) return [];
      const action = asString(data.action) ?? "permission";
      const resources = Array.isArray(data.resources)
        ? data.resources.filter((value): value is string => typeof value === "string")
        : [];
      return [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "permission_request",
          requestId,
          title: `OpenCode requests ${action}`,
          detail: resources.length > 0 ? resources.join("\n") : undefined,
          toolCallId: asString(asRecord(data.source)?.callID)
            ? `opencode-v2:${asString(data.sessionID) ?? "global"}:${asString(asRecord(data.source)?.callID)}`
            : undefined,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
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
        prompt: field.title ?? field.description ?? field.key,
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
          prompt: form.title,
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
    const callId = asString(input.data.callID);
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
    const name = this.toolNames.get(cacheKey) ?? "tool";
    const rawInput = this.toolInputs.get(cacheKey) ?? asRecord(input.data.input) ?? {};
    const status = toolStatus(input.type);
    const kind = mapOpenCodeToolNameToAcpKind(name);
    const locations = mapOpenCodeToolLocations(name, rawInput);
    const rawOutput = mergeRawOutput(input.data);
    const detail =
      contentText(input.data.content) ??
      (input.type === "session.tool.failed" ? errorText(input.data.error) : undefined);
    const title =
      name === "subagent" && typeof rawInput.description === "string"
        ? rawInput.description
        : name;
    const editPreview =
      kind === "edit" ? extractToolEditPreview(rawInput, rawOutput) : undefined;
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
