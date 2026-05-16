import type { AgentStoredEvent } from "./protocol";

export type ChatMessageKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "status";

export type ProjectedChatMessage = {
  id: string;
  kind: ChatMessageKind;
  text?: string;
  status?: string;
  toolCallId?: string;
  title?: string;
  createdAt: number;
};

export function projectAgentEventToMessage(event: AgentStoredEvent): ProjectedChatMessage | null {
  switch (event.kind) {
    case "user_message":
      return {
        id: event.messageId,
        kind: "user",
        text: event.displayContent ?? event.content,
        createdAt: event.createdAt,
      };
    case "assistant_message_chunk":
      return {
        id: event.messageId,
        kind: "assistant",
        text: event.text,
        createdAt: event.createdAt,
      };
    case "reasoning":
      return {
        id: event.messageId,
        kind: "reasoning",
        text: event.text,
        createdAt: event.createdAt,
      };
    case "tool_call":
    case "tool_call_update":
      return {
        id: event.toolCallId,
        kind: "tool",
        toolCallId: event.toolCallId,
        title: event.title,
        status: event.status,
        createdAt: event.createdAt,
      };
    case "status":
      return {
        id: event.eventId,
        kind: "status",
        status: event.status,
        text: event.message,
        createdAt: event.createdAt,
      };
    case "assistant_message_end":
      return null;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
