"use client";

import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  PageIntro,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  settingsSelectTriggerClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  QUICK_OPEN_SCOPE_IDS,
  QUICK_OPEN_SCOPE_LABELS,
  QUICK_SWITCHER_SCOPE_IDS,
  QUICK_SWITCHER_SCOPE_LABELS,
  normalizeQuickOpenScope,
  normalizeQuickSwitcherScope,
} from "@/lib/quick-open-scopes";
import { DesktopNativeSettings } from "./DesktopNativeSettings";
import { MobileNativeSettings } from "./MobileNativeSettings";

export function GeneralSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { updateWorkspaceSession } = useWorkspace();
  const general = settings.general;

  const patchGeneral = (patch: Partial<typeof general>) => {
    updateSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        ...patch,
      },
    }));
  };

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
      <PageIntro title="General" />
      <SettingsSection title="Preferences">
        <SettingsLinkRow
          searchId="appearance-link"
          title="Appearance & themes"
          description="Themes, layout, chat design, the new chat page, and conversation list presets."
          onClick={() => openNav("appearance")}
        />
        <SettingsLinkRow
          searchId="shortcuts-link"
          title="Keyboard Shortcuts"
          description="Customize keyboard shortcuts for commands and workflows."
          onClick={() => openNav("keyboardShortcuts")}
        />
        <SettingsLinkRow
          searchId="export-link"
          title="Import & export settings"
          description="Back up or restore theme, shortcuts, workspace app settings, and more as JSON."
          onClick={() => openNav("exportImport")}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Quick Open & switcher">
        <SettingsRow
          searchId="quick-open-default-scope"
          title="Default Quick Open search"
          description="What Ctrl/Cmd+P searches when it opens. Cycle other scopes with Tab or the chips, or prefix the query (> commands, @ chats, # settings)."
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={general.quickOpenDefaultScope}
              aria-label="Default Quick Open search scope"
              onChange={(event) =>
                patchGeneral({
                  quickOpenDefaultScope: normalizeQuickOpenScope(event.target.value),
                })
              }
            >
              {QUICK_OPEN_SCOPE_IDS.map((scope) => (
                <option key={scope} value={scope}>
                  {QUICK_OPEN_SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          searchId="quick-switcher-scope"
          title="Ctrl+Tab switcher cycles"
          description="What the hold-to-cycle switcher steps through. Editor tabs are always available on their own via the Editor: Quick switch tab shortcuts (Alt+PageUp / Alt+PageDown by default, rebindable)."
          trailing={
            <select
              className={settingsSelectTriggerClass}
              value={general.quickSwitcherScope}
              aria-label="Ctrl+Tab switcher scope"
              onChange={(event) =>
                patchGeneral({
                  quickSwitcherScope: normalizeQuickSwitcherScope(event.target.value),
                })
              }
            >
              {QUICK_SWITCHER_SCOPE_IDS.map((scope) => (
                <option key={scope} value={scope}>
                  {QUICK_SWITCHER_SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsRow
          searchId="do-not-disturb"
          title="Do Not Disturb"
          description="Suppress all notifications - connection alerts, warnings, file overrides, and every other notification type."
          trailing={
            <ToggleSwitch
              checked={general.doNotDisturb}
              onChange={(value) => patchGeneral({ doNotDisturb: value })}
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
      <DesktopNativeSettings />
      <MobileNativeSettings />
    </>
  );
}
