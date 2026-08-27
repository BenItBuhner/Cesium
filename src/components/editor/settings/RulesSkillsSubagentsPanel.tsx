"use client";

import {
  formatWorkspaceSkillSource,
  workspaceSkillEnabledLabel,
} from "@cesium/core";
import {
  PageIntro,
  SettingsCallout,
  SettingsEmptyState,
  SettingsNestedBreadcrumbs,
  SettingsRow,
  SettingsSection,
  tagClass,
} from "@/components/editor/settings-ui";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceSkillCatalog } from "@/hooks/useWorkspaceSkillCatalog";

export function RulesSkillsSubagentsPanel() {
  const { activeWorkspaceId } = useWorkspace();
  const { skills, loading, error } = useWorkspaceSkillCatalog(activeWorkspaceId);

  return (
    <>
      <SettingsNestedBreadcrumbs
        parentNav="plugins"
        parentLabel="Integrations"
        label="Rules, Skills, Subagents"
      />
      <PageIntro title="Rules, Skills, Subagents" />

      <SettingsSection title="Skills">
        {!activeWorkspaceId ? (
          <SettingsEmptyState>Open a workspace to list discovered skills.</SettingsEmptyState>
        ) : loading ? (
          <SettingsEmptyState>Loading skills…</SettingsEmptyState>
        ) : error ? (
          <div className="px-[16px] py-[14px]">
            <SettingsCallout tone="danger">{error}</SettingsCallout>
          </div>
        ) : skills.length === 0 ? (
          <SettingsEmptyState>
            No skills in this workspace. Add a SKILL.md under .agents/skills, .cursor/skills,
            .claude/skills, .codex/skills, or .opencode/skills.
          </SettingsEmptyState>
        ) : (
          skills.map((skill, index) => (
            <SettingsRow
              key={`${skill.source}:${skill.relativePath}`}
              title={skill.name}
              description={`${formatWorkspaceSkillSource(skill.source)} · ${skill.relativePath}${
                skill.description ? ` — ${skill.description}` : ""
              }`}
              border={index < skills.length - 1}
              searchId={index === 0 ? "skills" : undefined}
              titleExtra={
                <span className={tagClass}>
                  {workspaceSkillEnabledLabel(skill.disableModelInvocation)}
                </span>
              }
              trailing={null}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}
