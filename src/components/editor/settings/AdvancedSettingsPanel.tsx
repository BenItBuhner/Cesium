"use client";

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useSettingsEngineAvailability } from "@/hooks/useSettingsEngineAvailability";
import {
  PageIntro,
  SettingsLinkRow,
  SettingsSection,
} from "@/components/editor/settings-ui";

export function AdvancedSettingsPanel() {
  const { enginePagesVisible } = useSettingsEngineAvailability();
  const { updateWorkspaceSession } = useWorkspace();

  const openNav = (activeNav: string) => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav,
      },
    }));
  };

  return (
    <>
      <PageIntro title="Advanced" />
      <SettingsSection title="Maintenance">
        <SettingsLinkRow
          searchId="export-link"
          title="Import & export"
          description="Back up or restore theme, shortcuts, workspace app settings, and more as JSON."
          onClick={() => openNav("exportImport")}
          border={enginePagesVisible}
        />
        {enginePagesVisible ? (
          <>
            <SettingsLinkRow
              searchId="storage-link"
              title="Storage"
              description="See the current driver and migrate between file storage and Postgres."
              onClick={() => openNav("storage")}
            />
            <SettingsLinkRow
              searchId="updates-link"
              title="Updates"
              description="Check for new builds and apply an in-place update on this server."
              onClick={() => openNav("updates")}
              border={false}
            />
          </>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Experiments">
        <SettingsLinkRow
          searchId="beta-link"
          title="Beta"
          description="Optional experimental features such as the new browser and iPad input."
          onClick={() => openNav("beta")}
          border={false}
        />
      </SettingsSection>
    </>
  );
}
