import { randomUUID } from "node:crypto";
import type { AgentEventInput } from "../types.js";
import { extractToolEditPreview } from "../tool-edit-preview.js";
import {
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "../tool-normalize.js";
import { clampDetail, extractToolOutputText } from "./reader-utils.js";

/**
 * Imported tool events go through the exact same normalization pipeline the
 * live providers use (`tool-normalize.ts` + `tool-edit-preview.ts`), so an
 * imported transcript renders indistinguishably from a native one: human tool
 * titles ("Run npm test", "Update file.ts"), readable result details instead
 * of raw JSON, file locations, and diff previews for edits.
 */

/** Coerce harness-native result payloads into the record shape the shared normalizers expect. */
function coerceResultPayload(result: unknown): unknown {
  if (result == null) {
    return undefined;
  }
  if (typeof result === "string") {
    return { output: result };
  }
  if (Array.isArray(result)) {
    const text = extractToolOutputText(result);
    return text ? { output: text } : undefined;
  }
  return result;
}

export function importedToolCallEvent(input: {
  conversationId: string;
  toolCallId: string;
  name: string;
  toolInput?: unknown;
  status?: "completed" | "failed" | "in_progress";
  createdAt: number;
}): AgentEventInput {
  const payload = { input: input.toolInput };
  const kind = inferCanonicalToolKind({ name: input.name, input: input.toolInput });
  const detail = clampDetail(detailForToolPayload(payload));
  const locations = locationsForToolPayload(payload);
  const editPreview = extractToolEditPreview(input.toolInput, undefined);
  return {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    kind: "tool_call",
    toolCallId: input.toolCallId,
    title: titleForCanonicalTool({ name: input.name, kind, payload }),
    toolKind: kind,
    status: input.status ?? "completed",
    ...(detail ? { detail } : {}),
    ...(locations ? { locations } : {}),
    ...(editPreview ? { editPreview } : {}),
    raw: { name: input.name, input: input.toolInput },
    createdAt: input.createdAt,
  };
}

export function importedToolResultEvent(input: {
  conversationId: string;
  toolCallId: string;
  name: string;
  toolInput?: unknown;
  result?: unknown;
  isError?: boolean;
  createdAt: number;
}): AgentEventInput {
  const result = coerceResultPayload(input.result);
  const payload = { input: input.toolInput, result };
  const kind = inferCanonicalToolKind({ name: input.name, input: input.toolInput, result });
  const detail = clampDetail(detailForToolPayload(payload));
  const locations = locationsForToolPayload(payload);
  const editPreview = extractToolEditPreview(input.toolInput, result);
  return {
    eventId: randomUUID(),
    conversationId: input.conversationId,
    kind: "tool_call_update",
    toolCallId: input.toolCallId,
    title: titleForCanonicalTool({ name: input.name, kind, payload }),
    toolKind: kind,
    status: input.isError ? "failed" : "completed",
    ...(detail ? { detail } : {}),
    ...(locations ? { locations } : {}),
    ...(editPreview ? { editPreview } : {}),
    raw: { name: input.name, input: input.toolInput, result: input.result },
    createdAt: input.createdAt,
  };
}
