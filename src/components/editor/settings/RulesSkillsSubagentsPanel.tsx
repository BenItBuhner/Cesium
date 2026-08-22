"use client";

import { PageIntro, SettingsNestedBreadcrumbs } from "@/components/editor/settings-ui";

export function RulesSkillsSubagentsPanel() {
  return (
    <>
      <SettingsNestedBreadcrumbs
        parentNav="plugins"
        parentLabel="Integrations"
        label="Rules, Skills, Subagents"
      />
      <PageIntro title="Rules, Skills, Subagents" />
    </>
  );
}
