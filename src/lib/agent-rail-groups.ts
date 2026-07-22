import type {
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import type { AgentRailGroupByMode } from "@/lib/global-settings";

export function groupAgentRailGroups(
  groups: AgentConversationGroup[],
  mode: AgentRailGroupByMode,
  now = Date.now()
): AgentConversationGroup[] {
  if (mode === "workspace") {
    // Compound workspaceKey (serverId:workspaceId) prevents same-id workspaces
    // from different servers from merging, but the input array may legitimately
    // contain duplicates if a server returned a workspace and the directory
    // also injected a placeholder. Dedupe on workspaceKey, preferring the
    // entry with conversations.
    const byKey = new Map<string, AgentConversationGroup>();
    for (const group of groups) {
      const key = group.workspaceKey ?? `${group.serverId ?? "local"}:${group.workspace.id}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, group);
        continue;
      }
      if (existing.conversations.length === 0 && group.conversations.length > 0) {
        byKey.set(key, group);
      }
    }
    return [...byKey.values()];
  }
  const map = new Map<string, AgentConversationGroup>();
  const addToGroup = (
    key: string,
    label: string,
    group: AgentConversationGroup,
    conversations: AgentRailConversationSummary[]
  ) => {
    const existing = map.get(key);
    if (existing) {
      existing.conversations.push(...conversations);
      existing.serverIds = [
        ...new Set([
          ...(existing.serverIds ?? (existing.serverId ? [existing.serverId] : [])),
          ...(group.serverIds ?? (group.serverId ? [group.serverId] : [])),
        ]),
      ];
      return;
    }
    map.set(key, {
      ...group,
      workspace: {
        ...group.workspace,
        id: key,
        name: label,
      },
      conversations: [...conversations],
      serverIds: group.serverIds ?? (group.serverId ? [group.serverId] : undefined),
    });
  };

  for (const group of groups) {
    // ALWAYS prefix non-workspace grouping keys with the source server so
    // identically-named buckets (e.g. "Today", "main", "idle") from server A
    // never absorb conversations from server B.
    const serverPrefix = group.serverId ?? "local";

    if (mode === "repository") {
      if (group.conversations.length === 0 && group.repositoryKey) {
        const label =
          group.repository?.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1) ??
          group.workspace.name;
        addToGroup(group.repositoryKey, label, group, []);
        continue;
      }
      const byRepo = new Map<string, AgentRailConversationSummary[]>();
      for (const conversation of group.conversations) {
        const repoKey =
          conversation.repositoryKey ??
          group.repositoryKey ??
          `${serverPrefix}:${group.workspace.root}`;
        const list = byRepo.get(repoKey) ?? [];
        list.push(conversation);
        byRepo.set(repoKey, list);
      }
      for (const [repoKey, conversations] of byRepo) {
        const first = conversations[0];
        const label =
          first?.repository?.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1) ??
          group.repository?.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1) ??
          group.workspace.name;
        addToGroup(repoKey, label, group, conversations);
      }
      continue;
    }

    if (mode === "server") {
      const key = `server:${serverPrefix}`;
      addToGroup(key, group.serverLabel ?? "This device", group, group.conversations);
      continue;
    }

    if (mode === "status") {
      const byStatus = new Map<string, AgentRailConversationSummary[]>();
      for (const conversation of group.conversations) {
        const list = byStatus.get(conversation.status) ?? [];
        list.push(conversation);
        byStatus.set(conversation.status, list);
      }
      for (const [status, conversations] of byStatus) {
        addToGroup(
          `status:${serverPrefix}:${status}`,
          status.replace(/_/g, " "),
          group,
          conversations
        );
      }
      continue;
    }

    if (mode === "updated") {
      const byUpdated = new Map<string, AgentRailConversationSummary[]>();
      for (const conversation of group.conversations) {
        const ageDays = (now - conversation.updatedAt) / 86_400_000;
        const key = ageDays <= 1 ? "today" : ageDays <= 7 ? "week" : "older";
        const list = byUpdated.get(key) ?? [];
        list.push(conversation);
        byUpdated.set(key, list);
      }
      for (const [bucket, conversations] of byUpdated) {
        const label = bucket === "today" ? "Today" : bucket === "week" ? "This week" : "Older";
        addToGroup(`updated:${serverPrefix}:${bucket}`, label, group, conversations);
      }
    }
  }

  return [...map.values()].map((group) => ({
    ...group,
    conversations: [...group.conversations].sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}
