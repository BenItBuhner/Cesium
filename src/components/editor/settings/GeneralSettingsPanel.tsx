"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import {
  NEW_CHAT_WIDGET_DESCRIPTIONS,
  NEW_CHAT_WIDGET_LABELS,
  useNewChatWidgetMove,
  useNewChatWidgetVisibilityToggle,
} from "@/components/agent/NewChatWidgets";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  PageIntro,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { MobileNativeSettings } from "./MobileNativeSettings";

export function GeneralSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { updateWorkspaceSession } = useWorkspace();
  const general = settings.general;
  const toggleNewChatWidget = useNewChatWidgetVisibilityToggle();
  const moveNewChatWidget = useNewChatWidgetMove();

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
        {general.newChatWidgets.order.map((id, index) => {
          const hidden = general.newChatWidgets.hidden.includes(id);
          const isLast = index === general.newChatWidgets.order.length - 1;
          return (
            <SettingsRow
              key={id}
              searchId={`new-chat-widget-${id}`}
              title={NEW_CHAT_WIDGET_LABELS[id]}
              description={NEW_CHAT_WIDGET_DESCRIPTIONS[id]}
              trailing={
                <div className="flex items-center gap-[8px]">
                  <button
                    type="button"
                    aria-label={`Move ${NEW_CHAT_WIDGET_LABELS[id]} up`}
                    disabled={index === 0}
                    onClick={() => moveNewChatWidget(id, -1)}
                    className="flex size-[24px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    <ChevronUp className="size-[13px]" strokeWidth={1.8} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${NEW_CHAT_WIDGET_LABELS[id]} down`}
                    disabled={isLast}
                    onClick={() => moveNewChatWidget(id, 1)}
                    className="flex size-[24px] items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-30"
                  >
                    <ChevronDown className="size-[13px]" strokeWidth={1.8} aria-hidden />
                  </button>
                  <ToggleSwitch
                    checked={!hidden}
                    onChange={() => toggleNewChatWidget(id)}
                    size="md"
                  />
                </div>
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
      <SettingsSection title="Performance">
        <SettingsRow
          searchId="batch-stream-events"
          title="Batch streamed events"
          description="Render high-speed token and progress streams in short 50 ms batches. Turn this off for immediate per-event updates at the cost of higher CPU, GPU, and battery use."
          trailing={
            <ToggleSwitch
              checked={general.batchStreamEvents}
              onChange={(value) => patchGeneral({ batchStreamEvents: value })}
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsRow
          searchId="do-not-disturb"
          title="Do Not Disturb"
          description="Suppress all notifications — connection alerts, warnings, file overrides, and every other notification type."
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
      <SettingsSection title="Voice">
        <SettingsRow
          searchId="show-voice-orb"
          title="Voice orb"
          description="Show the floating ambient voice orb. Hiding it also turns the voice plane off. You can also hide it from the orb's long-press menu."
          trailing={
            <ToggleSwitch
              checked={general.showVoiceOrb}
              onChange={(value) => patchGeneral({ showVoiceOrb: value })}
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
      <MobileNativeSettings />
    </>
  );
}
