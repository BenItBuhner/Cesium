import { stripAgentTodoJsonAssistantContent } from "@/lib/agent-chat";
import type { ChatMessage } from "@/lib/types";
import type { MessageThreadSegment } from "./message-thread-rows";

export type SettledTurnContext = {
  settled: boolean;
  /** Insertion-ordered; O(1) membership for the per-row settled checks during render. */
  tailIndexSet: ReadonlySet<number>;
  lastAssistantIndex: number;
};

const EMPTY_SETTLED: SettledTurnContext = {
  settled: false,
  tailIndexSet: new Set(),
  lastAssistantIndex: -1,
};

/** True when the latest user turn has finished (not busy) and ends with an assistant reply. */
export function getSettledTurnContext(
  segments: MessageThreadSegment[],
  messages: ChatMessage[],
  conversationBusy: boolean
): SettledTurnContext {
  if (conversationBusy) {
    return EMPTY_SETTLED;
  }
  const lastTurn = [...segments].reverse().find((segment) => segment.type === "turn");
  if (!lastTurn || lastTurn.type !== "turn") {
    return EMPTY_SETTLED;
  }
  const assistantIndices = lastTurn.tailIndices.filter(
    (index) => messages[index]?.type === "assistant"
  );
  if (assistantIndices.length === 0) {
    return EMPTY_SETTLED;
  }
  return {
    settled: true,
    tailIndexSet: new Set(lastTurn.tailIndices),
    lastAssistantIndex: Math.max(...assistantIndices),
  };
}

/** Plain-text body of the last assistant bubble in a user turn (excludes prior assistant chunks). */
export function extractFinalAssistantResponseForTurn(
  messages: ChatMessage[],
  userMessageId: string
): string | null {
  const userIndex = messages.findIndex(
    (message) => message.type === "user" && message.id === userMessageId
  );
  if (userIndex < 0) {
    return null;
  }

  let lastAssistantIndex = -1;
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.type === "user") {
      break;
    }
    if (message.type === "assistant") {
      lastAssistantIndex = i;
    }
  }
  if (lastAssistantIndex < 0) {
    return null;
  }

  const cleaned = stripAgentTodoJsonAssistantContent(
    messages[lastAssistantIndex]!.content ?? ""
  ).trim();
  return cleaned || null;
}

/** Work rows in a settled turn that should minimize (everything before the final assistant). */
export function isSettledWorkIndex(index: number, context: SettledTurnContext): boolean {
  if (!context.settled) {
    return false;
  }
  if (!context.tailIndexSet.has(index)) {
    return false;
  }
  if (index >= context.lastAssistantIndex) {
    return false;
  }
  return true;
}
