"use client";

import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useCesiumRendererFeatureFlags } from "@/lib/desktop-environment";
import {
  PageIntro,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

export function BetaSettingsPanel() {
  const {
    experimentalIpadMode,
    experimentalIpadCustomButtons,
    experimentalIpadWindowedTabInset,
    experimentalIpadResumeCache,
    vscodeExtensionsBeta,
    setExperimentalIpadMode,
    setExperimentalIpadCustomButtons,
    setExperimentalIpadWindowedTabInset,
    setExperimentalIpadResumeCache,
    setVscodeExtensionsBeta,
  } = useUserPreferences();
  const { ipadBetaSettings, vscodeExtensionsBetaSettings } = useCesiumRendererFeatureFlags();
  const { settings, updateSettings } = useGlobalSettings();
  const newBrowserEnabled = settings.agents.newBrowser;

  return (
    <>
      <PageIntro title="Beta" />
      <SettingsSection title="Browser">
        <SettingsRow
          searchId="new-browser"
          title="New browser"
          description="Use the experimental Chromium-backed browser engine. This improves real browser API fidelity, but is still being tuned for hover states, animation smoothness, and response timing. The classic proxy browser remains the default."
          trailing={
            <ToggleSwitch
              checked={newBrowserEnabled}
              onChange={(checked) =>
                updateSettings((current) => ({
                  ...current,
                  agents: {
                    ...current.agents,
                    newBrowser: checked,
                  },
                }))
              }
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      {vscodeExtensionsBetaSettings ? (
        <SettingsSection title="Extensions">
          <SettingsRow
            searchId="vscode-extensions"
            title="VS Code Extension Marketplace"
            description="Enable the desktop-only VS Code extension marketplace Beta. Installed extensions can run Node code in a separate host process; keep this off unless you trust the extensions and want the runtime."
            trailing={
              <ToggleSwitch
                checked={vscodeExtensionsBeta}
                onChange={setVscodeExtensionsBeta}
                size="md"
                variant="green"
              />
            }
            border={false}
          />
        </SettingsSection>
      ) : null}
      {ipadBetaSettings ? (
        <SettingsSection title="iPad">
          <SettingsRow
            searchId="ipad-text-input"
            title="Text Input Abstraction"
            description="Use hardware-keyboard-first input surfaces on iPad and avoid native text fields where possible. Experimental and intended for iPad web app sessions with a connected physical keyboard."
            trailing={
              <ToggleSwitch
                checked={experimentalIpadMode}
                onChange={setExperimentalIpadMode}
                size="md"
                variant="green"
              />
            }
          />
          <SettingsRow
            searchId="ipad-menu"
            title="Custom Menu Buttons"
            description="Show explicit three-dot menu buttons for iPad-specific workarounds, starting with files and folders in the explorer tree."
            trailing={
              <ToggleSwitch
                checked={experimentalIpadCustomButtons}
                onChange={setExperimentalIpadCustomButtons}
                size="md"
                variant="green"
              />
            }
          />
          <SettingsRow
            searchId="ipad-inset"
            title="Windowed mode tab inset"
            description="When the primary sidebar is hidden, add extra left padding to the editor tab strip so tabs sit clear of iPadOS window controls (close, minimize, maximize) in multitasking windows."
            trailing={
              <ToggleSwitch
                checked={experimentalIpadWindowedTabInset}
                onChange={setExperimentalIpadWindowedTabInset}
                size="md"
                variant="green"
              />
            }
          />
          <SettingsRow
            searchId="ipad-resume-cache"
            title="Fast resume cache"
            description="Cache the app shell and restore the last workspace snapshot before backend reconnect so iPadOS reloads feel closer to app resume."
            trailing={
              <ToggleSwitch
                checked={experimentalIpadResumeCache}
                onChange={setExperimentalIpadResumeCache}
                size="md"
                variant="green"
              />
            }
            border={false}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
