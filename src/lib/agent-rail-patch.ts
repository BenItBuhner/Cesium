import type {
  AgentConversationGroup,
  AgentConversationRecord,
  AgentRailConversationSummary,
} from "@/lib/agent-types";

export function agentRecordToRailSummary(
  c: AgentConversationRecord
): AgentRailConversationSummary {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastEventSeq: c.lastEventSeq,
    status: c.status,
    archivedAt: c.archivedAt ?? null,
    backendId: c.config.backendId,
    mode: c.config.mode,
    experimental: c.experimental,
    hasPendingPermission: c.pendingPermission != null,
  };
}

/** Stable ordering: recency first, then creation time, then id (never title — renames must not reshuffle ties). */
function compareRailOrder(
  a: AgentRailConversationSummary,
  b: AgentRailConversationSummary
): number {
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id.localeCompare(b.id);
}

function sortRailSummaries(list: AgentRailConversationSummary[]): AgentRailConversationSummary[] {
  return [...list].sort(compareRailOrder);
}

/** Merge a live server record into cross-workspace rail groups (in-place copy). */
export function patchAgentConversationGroups(
  groups: AgentConversationGroup[],
  record: AgentConversationRecord
): AgentConversationGroup[] {
  const summary = agentRecordToRailSummary(record);
  let touched = false;
  const next = groups.map((group) => {
    if (group.workspace.id !== record.workspaceId) {
      return group;
    }
    touched = true;
    const idx = group.conversations.findIndex((c) => c.id === record.id);
    if (idx >= 0) {
      const prev = group.conversations[idx]!;
      const replaced = group.conversations.slice();
      replaced[idx] = summary;
      if (summary.updatedAt === prev.updatedAt) {
        return { ...group, conversations: replaced };
      }
      return { ...group, conversations: sortRailSummaries(replaced) };
    }
    return { ...group, conversations: sortRailSummaries([...group.conversations, summary]) };
  });
  return touched ? next : groups;
}

export function removeConversationFromAgentGroups(
  groups: AgentConversationGroup[],
  conversationId: string,
  workspaceId: string
): AgentConversationGroup[] {
  return groups.map((group) =>
    group.workspace.id !== workspaceId
      ? group
      : {
          ...group,
          conversations: group.conversations.filter((c) => c.id !== conversationId),
        }
  );
}

export function patchAgentConversationTitleInGroups(
  groups: AgentConversationGroup[],
  conversationId: string,
  title: string
): AgentConversationGroup[] {
  return groups.map((group) => ({
    ...group,
    conversations: group.conversations.map((c) =>
      c.id === conversationId ? { ...c, title } : c
    ),
  }));
}
