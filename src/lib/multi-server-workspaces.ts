import type {
  AgentConversationGroup,
  AgentRailRepositoryInfo,
} from "@/lib/agent-types";
import type { WorkspaceSortMode } from "@/lib/global-settings";
import type { DirectoryWorkspaceRecord } from "@/contexts/WorkspaceDirectoryContext";

export function getRepositoryGroupingKey(input: {
  repository?: AgentRailRepositoryInfo;
  serverId: string;
  fallbackRoot: string;
}): string {
  const { repository, serverId, fallbackRoot } = input;
  if (repository?.repositoryId) {
    return `remote:${repository.repositoryId}`;
  }
  return `machine:${serverId}:${repository?.repoKey ?? repository?.repoRoot ?? fallbackRoot}`;
}

export function filterGroupsByMachine(
  groups: AgentConversationGroup[],
  hiddenServerIds: readonly string[]
): AgentConversationGroup[] {
  if (hiddenServerIds.length === 0) {
    return groups;
  }
  const hidden = new Set(hiddenServerIds);
  return groups.filter((group) => !group.serverId || !hidden.has(group.serverId));
}

export function compareMachineWorkspace(
  a: Pick<DirectoryWorkspaceRecord, "serverLabel" | "name" | "workspaceKey">,
  b: Pick<DirectoryWorkspaceRecord, "serverLabel" | "name" | "workspaceKey">
): number {
  return (
    a.serverLabel.localeCompare(b.serverLabel, undefined, { sensitivity: "base" }) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.workspaceKey.localeCompare(b.workspaceKey)
  );
}

export function sortDirectoryWorkspaces(
  workspaces: DirectoryWorkspaceRecord[],
  mode: WorkspaceSortMode
): DirectoryWorkspaceRecord[] {
  return [...workspaces].sort((a, b) => {
    if (mode === "machine") {
      return compareMachineWorkspace(a, b);
    }
    if (mode === "alphabetical") {
      return (
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        compareMachineWorkspace(a, b)
      );
    }
    return (
      b.lastOpenedAt - a.lastOpenedAt ||
      b.updatedAt - a.updatedAt ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.workspaceKey.localeCompare(b.workspaceKey)
    );
  });
}

export type RepositoryWorkspaceSection = {
  key: string;
  label: string;
  items: DirectoryWorkspaceRecord[];
  machineCount: number;
};

export function groupDirectoryWorkspacesByRepository(
  workspaces: DirectoryWorkspaceRecord[]
): RepositoryWorkspaceSection[] {
  const sections = new Map<string, RepositoryWorkspaceSection>();
  for (const workspace of workspaces) {
    const repositoryKey = workspace.repository?.isGitRepo
      ? getRepositoryGroupingKey({
          repository: workspace.repository,
          serverId: workspace.serverId,
          fallbackRoot: workspace.root,
        })
      : `workspace:${workspace.workspaceKey}`;
    const existing = sections.get(repositoryKey);
    if (existing) {
      existing.items.push(workspace);
      existing.machineCount = new Set(existing.items.map((item) => item.serverId)).size;
      continue;
    }
    const repositoryName =
      workspace.repository?.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.name;
    sections.set(repositoryKey, {
      key: repositoryKey,
      label: repositoryName,
      items: [workspace],
      machineCount: 1,
    });
  }
  return [...sections.values()];
}
