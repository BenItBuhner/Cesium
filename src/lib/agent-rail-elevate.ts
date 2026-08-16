import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import {
  agentRailConversationNeedsAttention,
  compareAgentRailByStatusPriority,
  type AgentRailStatusContext,
} from "@/lib/agent-rail-status";
import { getRailConversationKey } from "@/lib/agent-rail-bulk-select";

export type AgentRailElevateContext = {
  unreadCompletionByConversationId?: Record<string, true>;
  acknowledgedFailureByConversationId?: Record<string, true>;
};

export function agentRailStatusContextForConversation(
  conversation: Pick<AgentRailConversationSummary, "id">,
  ctx: AgentRailElevateContext
): AgentRailStatusContext {
  return {
    unreadCompletion: Boolean(ctx.unreadCompletionByConversationId?.[conversation.id]),
    acknowledgedFailure: Boolean(ctx.acknowledgedFailureByConversationId?.[conversation.id]),
  };
}

export function conversationHasAttentionHome(
  conversation: Pick<
    AgentRailConversationSummary,
    "id" | "status" | "hasPendingPermission" | "hasPendingQuestion"
  >,
  ctx: AgentRailElevateContext = {}
): boolean {
  return agentRailConversationNeedsAttention(
    conversation,
    agentRailStatusContextForConversation(conversation, ctx)
  );
}

function collectFromGroups(
  groups: AgentConversationGroup[],
  ctx: AgentRailElevateContext
): Map<string, AgentRailConversationSummary> {
  const byKey = new Map<string, AgentRailConversationSummary>();
  for (const group of groups) {
    for (const conversation of group.conversations) {
      if (conversationHasAttentionHome(conversation, ctx)) {
        byKey.set(getRailConversationKey(conversation), conversation);
      }
    }
  }
  return byKey;
}

/**
 * Cross-workspace inbox: permission, question, or unread failure.
 * Attention wins over pinned — each conversation has one home.
 */
export function collectAttentionConversations(
  groups: AgentConversationGroup[],
  extra: AgentRailConversationSummary[],
  ctx: AgentRailElevateContext = {}
): AgentRailConversationSummary[] {
  const byKey = collectFromGroups(groups, ctx);
  for (const conversation of extra) {
    if (conversationHasAttentionHome(conversation, ctx)) {
      byKey.set(getRailConversationKey(conversation), conversation);
    }
  }
  return [...byKey.values()].sort((a, b) => compareAgentRailByStatusPriority(a, b, ctx));
}

export function attentionConversationIdSet(
  conversations: AgentRailConversationSummary[]
): Set<string> {
  return new Set(conversations.map((conversation) => conversation.id));
}

/** Strip attention rows from the pinned list so they only appear in Needs attention. */
export function stripAttentionFromPinned(
  pinned: AgentRailConversationSummary[],
  attentionIds: Set<string>
): AgentRailConversationSummary[] {
  if (attentionIds.size === 0) {
    return pinned;
  }
  return pinned.filter((conversation) => !attentionIds.has(conversation.id));
}

/**
 * Remove elevated rows from home groups. Attention first, then pins.
 * Empty groups stay so a scoped workspace with only attention chats still has a header.
 */
export function stripElevatedFromGroups(
  groups: AgentConversationGroup[],
  attentionIds: Set<string>,
  pinnedIds: Set<string>
): AgentConversationGroup[] {
  if (attentionIds.size === 0 && pinnedIds.size === 0) {
    return groups;
  }
  return groups.map((group) => ({
    ...group,
    conversations: group.conversations.filter(
      (conversation) =>
        !attentionIds.has(conversation.id) && !pinnedIds.has(conversation.id)
    ),
  }));
}
