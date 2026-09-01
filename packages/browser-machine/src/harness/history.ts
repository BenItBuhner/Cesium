/**
 * Rebuild adapter messages from the stored event log. The browser harness
 * writes its own bookkeeping into `raw` on tool events, so reconstruction is
 * lossless for turns produced here.
 */
import type { ImageAttachment, AgentStoredEvent } from "@cesium/core";
import type { AdapterContentPart, AdapterMessage } from "./adapters";

type ToolRaw = { callId?: string; name?: string; argsJson?: string };
type ToolResultRaw = { result?: string };

/** Mirrors the engine's per-tool result cap when feeding results back to the model. */
const MAX_TOOL_RESULT_CHARS = 12_000;

function capToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n[Tool result truncated at ${MAX_TOOL_RESULT_CHARS} characters.]`;
}

function attachmentParts(attachments: ImageAttachment[] | undefined): AdapterContentPart[] {
  const parts: AdapterContentPart[] = [];
  for (const attachment of attachments ?? []) {
    if ((attachment.kind ?? "image") === "image" && attachment.data) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
      });
    } else if (attachment.savedPath) {
      parts.push({
        type: "text",
        text: `[Attached file saved at ${attachment.savedPath}${attachment.name ? ` (${attachment.name})` : ""}]`,
      });
    }
  }
  return parts;
}

export function buildHistoryFromEvents(input: {
  events: AgentStoredEvent[];
  systemPrompt: string;
  supportsImages: boolean;
}): AdapterMessage[] {
  const messages: AdapterMessage[] = [{ role: "system", content: input.systemPrompt }];

  let assistantText = "";
  let assistantMessageId: string | null = null;
  const pendingToolCalls: Array<{ id: string; name: string; argsJson: string }> = [];
  const pendingToolResults: Array<{ id: string; result: string }> = [];

  const flushAssistant = (): void => {
    if (!assistantText && pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: assistantText || null,
      ...(pendingToolCalls.length > 0
        ? {
            tool_calls: pendingToolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.argsJson },
            })),
          }
        : {}),
    });
    for (const result of pendingToolResults) {
      messages.push({ role: "tool", tool_call_id: result.id, content: result.result });
    }
    assistantText = "";
    assistantMessageId = null;
    pendingToolCalls.length = 0;
    pendingToolResults.length = 0;
  };

  for (const event of input.events) {
    switch (event.kind) {
      case "user_message": {
        flushAssistant();
        const parts = input.supportsImages ? attachmentParts(event.attachments) : [];
        if (parts.length > 0) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: event.content }, ...parts],
          });
        } else {
          const fileNotes = (event.attachments ?? [])
            .filter((attachment) => attachment.kind === "file" && attachment.savedPath)
            .map((attachment) => `[Attached file saved at ${attachment.savedPath}]`)
            .join("\n");
          messages.push({
            role: "user",
            content: fileNotes ? `${event.content}\n\n${fileNotes}` : event.content,
          });
        }
        break;
      }
      case "system_reminder": {
        flushAssistant();
        const text = event.text.trimStart().startsWith("<system-reminder>")
          ? event.text
          : `<system-reminder>\n${event.text}\n</system-reminder>`;
        messages.push({ role: "user", content: text });
        break;
      }
      case "assistant_message_chunk": {
        if (assistantMessageId !== null && assistantMessageId !== event.messageId) {
          flushAssistant();
        }
        // A new burst of text after tool results means a new assistant message.
        if (pendingToolResults.length > 0) {
          flushAssistant();
        }
        assistantMessageId = event.messageId;
        assistantText += event.text;
        break;
      }
      case "assistant_message_end": {
        break;
      }
      case "tool_call": {
        const raw = (event.raw ?? {}) as ToolRaw;
        if (raw.name) {
          pendingToolCalls.push({
            id: raw.callId ?? event.toolCallId,
            name: raw.name,
            argsJson: raw.argsJson ?? "{}",
          });
        }
        break;
      }
      case "tool_call_update": {
        const raw = (event.raw ?? {}) as ToolResultRaw & ToolRaw;
        if (
          (event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled") &&
          raw.result !== undefined
        ) {
          const matching = pendingToolCalls.find(
            (call) => call.id === (raw.callId ?? event.toolCallId)
          );
          pendingToolResults.push({
            id: matching?.id ?? raw.callId ?? event.toolCallId,
            result: capToolResult(raw.result),
          });
        }
        break;
      }
      case "compression_summary": {
        flushAssistant();
        messages.push({
          role: "user",
          content: `<system-reminder>\nEarlier conversation was compressed. Summary:\n${event.summary}\n</system-reminder>`,
        });
        break;
      }
      default:
        break;
    }
  }
  flushAssistant();
  return messages;
}
