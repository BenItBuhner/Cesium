import type {
  AgentBackendInfo,
  AgentConversationOrigin,
  AgentConversationRecord,
} from "./protocol";

export type SideChatOrigin = Extract<AgentConversationOrigin, { kind: "side-chat" }>;

type ConversationLike = Pick<
  AgentConversationRecord,
  "origin" | "lastEventSeq" | "capabilities" | "config"
>;

/** The side-chat origin of a conversation, or `null` for ordinary chats. */
export function sideChatOriginOf(
  conversation: Pick<AgentConversationRecord, "origin"> | null | undefined
): SideChatOrigin | null {
  const origin = conversation?.origin;
  return origin && origin.kind === "side-chat" ? origin : null;
}

export function isSideChatConversation(
  conversation: Pick<AgentConversationRecord, "origin"> | null | undefined
): boolean {
  return sideChatOriginOf(conversation) !== null;
}

/**
 * Whether `/side` may be offered from this conversation's composer: the
 * harness must support side chats, the chat needs at least one message so the
 * seed has something to say, and side chats never nest.
 */
export function canOpenSideChat(
  conversation: ConversationLike | null | undefined,
  backend?: Pick<AgentBackendInfo, "capabilities"> | null
): boolean {
  if (!conversation) {
    return false;
  }
  if (isSideChatConversation(conversation)) {
    return false;
  }
  const supports =
    backend?.capabilities?.supportsSideChats ?? conversation.capabilities?.supportsSideChats;
  if (supports !== true) {
    return false;
  }
  return conversation.lastEventSeq > 0;
}

/** Side chats attached to `parentConversationId`, oldest first. */
export function listSideChatsOf<T extends Pick<AgentConversationRecord, "origin" | "createdAt">>(
  conversations: Iterable<T>,
  parentConversationId: string
): T[] {
  const out: T[] = [];
  for (const conversation of conversations) {
    if (sideChatOriginOf(conversation)?.parentConversationId === parentConversationId) {
      out.push(conversation);
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
