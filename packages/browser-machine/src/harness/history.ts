/**
 * Rebuild adapter messages from the stored event log with the normalizer the
 * server harness uses, then map them onto the OpenAI chat shape the browser
 * adapters send. The harness rebuilds before every model call, so each
 * request is exactly what this returns for the log at that point.
 */
import {
  normalizeEventsToHistory,
  type AgentStoredEvent,
  type CesiumHistoryMessage,
} from "@cesium/core";
import type { AdapterContentPart, AdapterMessage } from "./adapters";

function fileNotes(event: Extract<AgentStoredEvent, { kind: "user_message" }>): string {
  return (event.attachments ?? [])
    .filter((attachment) => attachment.kind === "file" && attachment.savedPath)
    .map((attachment) => `[Attached file saved at ${attachment.savedPath}]`)
    .join("\n");
}

/**
 * Browser-only event conventions, expressed in the shared shape: the context
 * reminder has always gone out as its own tagged user message right after the
 * prompt (an inline reminder at its position), and saved file attachments as
 * notes on the prompt text.
 */
function toSharedShape(event: AgentStoredEvent): AgentStoredEvent {
  if (event.kind === "system_reminder") {
    const text = event.text.trimStart().startsWith("<system-reminder>")
      ? event.text
      : `<system-reminder>\n${event.text}\n</system-reminder>`;
    return { ...event, text, placement: "inline", targetMessageId: undefined };
  }
  if (event.kind === "user_message") {
    const notes = fileNotes(event);
    return notes ? { ...event, content: `${event.content}\n\n${notes}` } : event;
  }
  return event;
}

function toAdapterMessage(message: CesiumHistoryMessage, supportsImages: boolean): AdapterMessage {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  const images = supportsImages ? (message.images ?? []) : [];
  if (images.length === 0) {
    return { role: message.role, content: message.content };
  }
  const parts: AdapterContentPart[] = [
    ...(message.content.trim() ? [{ type: "text" as const, text: message.content }] : []),
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ];
  return { role: message.role, content: parts };
}

export function buildHistoryFromEvents(input: {
  events: AgentStoredEvent[];
  systemPrompt: string;
  supportsImages: boolean;
}): AdapterMessage[] {
  return normalizeEventsToHistory(input.events.map(toSharedShape), input.systemPrompt).map(
    (message) => toAdapterMessage(message, input.supportsImages)
  );
}
