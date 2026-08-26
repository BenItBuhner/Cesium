/** Public Agent Skills catalog row (SKILL.md / agentskills.io). */

export const WORKSPACE_SKILL_SOURCES = [
  "agents",
  "cursor",
  "claude",
  "codex",
  "opencode",
] as const;

export type WorkspaceSkillSource = (typeof WORKSPACE_SKILL_SOURCES)[number];

export const WORKSPACE_SKILL_SOURCE_FOLDERS: Record<WorkspaceSkillSource, string> = {
  agents: ".agents/skills",
  cursor: ".cursor/skills",
  claude: ".claude/skills",
  codex: ".codex/skills",
  opencode: ".opencode/skills",
};

export const WORKSPACE_SKILL_SOURCE_LABELS: Record<WorkspaceSkillSource, string> = {
  agents: "Agents",
  cursor: "Cursor",
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

export type WorkspaceSkillCatalogItem = {
  name: string;
  description: string;
  /** Workspace-relative path to SKILL.md */
  relativePath: string;
  source: WorkspaceSkillSource;
  /** When true, skill is user-invoked only (Cursor disable-model-invocation). */
  disableModelInvocation: boolean;
};

export function isWorkspaceSkillSource(value: string): value is WorkspaceSkillSource {
  return (WORKSPACE_SKILL_SOURCES as readonly string[]).includes(value);
}

export function formatWorkspaceSkillSource(source: WorkspaceSkillSource): string {
  return `${WORKSPACE_SKILL_SOURCE_LABELS[source]} · ${WORKSPACE_SKILL_SOURCE_FOLDERS[source]}`;
}

export function workspaceSkillEnabledLabel(disableModelInvocation: boolean): string {
  return disableModelInvocation ? "User-invoked only" : "Enabled";
}
