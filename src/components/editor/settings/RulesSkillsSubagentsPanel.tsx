"use client";

import { SettingsNestedBreadcrumbs } from "@/components/editor/settings-ui";

export function RulesSkillsSubagentsPanel() {
  return (
    <SettingsNestedBreadcrumbs
      parentNav="plugins"
      parentLabel="Integrations"
      label="Rules, Skills, Subagents"
    />
  );
}
