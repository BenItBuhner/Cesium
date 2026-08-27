"use client";

import {
  NEW_CHAT_WIDGET_DESCRIPTIONS,
  NEW_CHAT_WIDGET_LABELS,
  useNewChatWidgetVisibilityToggle,
} from "@/components/agent/NewChatWidgets";
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
  normalizeComposerStatusBarVisibility,
  type ComposerStatusBarVisibility,
} from "@/lib/composer-status-bar";
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

function composerFooterEnabled(visibility: ComposerStatusBarVisibility): boolean {
  return visibility.repo || visibility.branch || visibility.goal || visibility.context;
}

export function GeneralSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { updateWorkspaceSession, workspaceSession } = useWorkspace();
  const general = settings.general;
  const composerStatusBarDefault = normalizeComposerStatusBarVisibility(
    general.composerStatusBarVisibility ??
      workspaceSession.chat.composerStatusBarVisibility
  );
  const toggleNewChatWidget = useNewChatWidgetVisibilityToggle();

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

  const setComposerFooter = (value: boolean) => {
    patchGeneral({
      composerStatusBarVisibility: {
        repo: value,
        branch: value,
        goal: value,
        context: value,
      },
    });
  };

  return (
    <>
      <PageIntro title="General" />
      <SettingsSection title="Preferences">
        <SettingsLinkRow
          searchId="appearance-link"
          title="Appearance & themes"
          description="System, light, or dark mode; per-appearance themes; custom token presets."
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
      <SettingsSection title="New chat widgets">
        {general.newChatWidgets.order.map((id) => {
          const hidden = general.newChatWidgets.hidden.includes(id);
          return (
            <SettingsRow
              key={id}
              searchId={`new-chat-widget-${id}`}
              title={NEW_CHAT_WIDGET_LABELS[id]}
              description={NEW_CHAT_WIDGET_DESCRIPTIONS[id]}
              trailing={
                <ToggleSwitch
                  checked={!hidden}
                  onChange={() => toggleNewChatWidget(id)}
                  size="md"
                />
              }
            />
          );
        })}
        <SettingsLinkRow
          searchId="new-chat-widget-actions-link"
          title="Configure quick actions"
          description="Add, edit, or remove the actions shown on the new chat landing."
          onClick={() => openNav("actions")}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Composer">
        <SettingsRow
          searchId="composer-status-bar"
          title="Composer footer"
          description="Show repository, branch, goal progress, and context usage under the composer in new chats."
          trailing={
            <ToggleSwitch
              checked={composerFooterEnabled(composerStatusBarDefault)}
              onChange={setComposerFooter}
              size="md"
            />
          }
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
