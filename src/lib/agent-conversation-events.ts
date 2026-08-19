import type { AgentConversationRecord } from "@/lib/agent-types";

/**
 * One event carries every record from a coalesce window so listeners (the
 * rail) can patch all of them in a single state update instead of one
 * re-render per running agent.
 */
export const AGENT_CONVERSATIONS_UPSERTED_BATCH_EVENT =
  "opencursor:agent_conversations_upserted_batch";

export const AGENT_CONVERSATION_DELETED_EVENT = "opencursor:agent_conversation_deleted";

export type AgentConversationDeletedDetail = {
  conversationId: string;
  workspaceId: string;
  serverId?: string;
};

export type AgentConversationUpsertedDetail = AgentConversationRecord & {
  serverId?: string;
};

export type AgentConversationsUpsertedBatchDetail = {
  conversations: AgentConversationUpsertedDetail[];
};

export function dispatchAgentConversationUpserted(
  conversation: AgentConversationRecord,
  serverId?: string
): void {
  dispatchAgentConversationsUpsertedBatch([conversation], serverId);
}

export function dispatchAgentConversationsUpsertedBatch(
  conversations: AgentConversationRecord[],
  serverId?: string
): void {
  if (typeof window === "undefined" || conversations.length === 0) {
    return;
  }
  const detailed = serverId
    ? conversations.map((conversation) => ({ ...conversation, serverId }))
    : conversations;
  window.dispatchEvent(
    new CustomEvent<AgentConversationsUpsertedBatchDetail>(
      AGENT_CONVERSATIONS_UPSERTED_BATCH_EVENT,
      { detail: { conversations: detailed } }
    )
  );
}

export function dispatchAgentConversationDeleted(detail: AgentConversationDeletedDetail): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AgentConversationDeletedDetail>(AGENT_CONVERSATION_DELETED_EVENT, {
      detail,
    })
  );
}
