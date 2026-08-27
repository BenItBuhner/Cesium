"use client";

import { useEffect, useState } from "react";
import {
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import {
  DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES,
  loadDesktopAgentNotificationPreferences,
  saveDesktopAgentNotificationPreferences,
  type DesktopAgentNotificationPreferences,
} from "@/lib/desktop-agent-notifications";
import {
  getDesktopNotificationsBridge,
  isDesktopNativeAvailable,
} from "@/lib/desktop-native-bridge";
import type {
  MobileNotificationAlertMode,
  MobileNotificationEtaMode,
  MobileNotificationMultiAgentMode,
} from "@/lib/mobile-bridge";
import { selectClass } from "./shared";

const COMPLETION_ALERT_OPTIONS = [
  { value: "always", label: "Always notify" },
  { value: "background", label: "Only when Cesium is in the background" },
  { value: "off", label: "Never" },
] satisfies Array<{ value: MobileNotificationAlertMode; label: string }>;

const INTERVENTION_ALERT_OPTIONS = [
  { value: "always", label: "Always alert" },
  { value: "background", label: "Alert only when Cesium is in the background" },
  { value: "off", label: "Silent" },
] satisfies Array<{ value: MobileNotificationAlertMode; label: string }>;

const ETA_MODE_OPTIONS = [
  { value: "goal", label: "Goal runs only (recommended)" },
  { value: "always", label: "All runs" },
  { value: "off", label: "Never" },
] satisfies Array<{ value: MobileNotificationEtaMode; label: string }>;

const MULTI_AGENT_OPTIONS = [
  { value: "separate", label: "A tray entry per agent" },
  { value: "combined", label: "One combined tray entry" },
] satisfies Array<{ value: MobileNotificationMultiAgentMode; label: string }>;

export function DesktopNativeSettings() {
  const [available, setAvailable] = useState(false);
  const [osSupported, setOsSupported] = useState(true);
  const [preferences, setPreferences] = useState<DesktopAgentNotificationPreferences>(
    DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES
  );
  const [testState, setTestState] = useState<"idle" | "sent" | "failed">("idle");

  useEffect(() => {
    if (!isDesktopNativeAvailable()) {
      return;
    }
    setAvailable(true);
    setPreferences(loadDesktopAgentNotificationPreferences());
    void getDesktopNotificationsBridge()
      ?.isSupported()
      .then((supported) => setOsSupported(supported !== false))
      .catch(() => undefined);
  }, []);

  if (!available) return null;

  const persist = (next: DesktopAgentNotificationPreferences) => {
    setPreferences(next);
    saveDesktopAgentNotificationPreferences(next);
  };
  const setAlertPreference = (
    key: "completion" | "intervention",
    value: MobileNotificationAlertMode
  ) =>
    persist({
      ...preferences,
      alerts: { ...preferences.alerts, [key]: value },
    });
  const setDisplayPreference = (
    key: "eta" | "multiAgent",
    value: MobileNotificationEtaMode | MobileNotificationMultiAgentMode
  ) =>
    persist({
      ...preferences,
      display: { ...preferences.display, [key]: value },
    });

  const sendTestNotification = () => {
    const bridge = getDesktopNotificationsBridge();
    if (!bridge) {
      setTestState("failed");
      return;
    }
    void bridge
      .notify({
        runKey: `test-${Date.now()}`,
        title: "Cesium Desktop",
        body: "Native notifications are working.",
        kind: "test",
        silent: false,
      })
      .then((posted) => setTestState(posted ? "sent" : "failed"))
      .catch(() => setTestState("failed"));
  };

  return (
    <SettingsSection title="Desktop notifications & tray">
      <SettingsRow
        searchId="desktop-notification-test"
        title="System notifications"
        description={
          osSupported
            ? "Agent runs surface as native notifications, in the tray menu, and on the dock/taskbar badge. Progress stays in the tray; notifications only fire when a run finishes or needs your input."
            : "This system reports that native notifications are unavailable; tray and badge updates still work."
        }
        trailing={
          <button
            type="button"
            className={rowButtonClass}
            onClick={sendTestNotification}
          >
            {testState === "sent"
              ? "Sent"
              : testState === "failed"
                ? "Failed - retry"
                : "Send test notification"}
          </button>
        }
      />
      <SettingsRow
        searchId="desktop-completion-alerts"
        title="Agent finished notifications"
        description="When an agent run completes, fails, or is cancelled. By default nothing is posted while Cesium is focused - you are already watching it finish."
        trailing={
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,340px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
            value={preferences.alerts.completion}
            options={COMPLETION_ALERT_OPTIONS}
            onChange={(value) =>
              setAlertPreference("completion", value as MobileNotificationAlertMode)
            }
            ariaLabel="Agent finished notifications"
            placement="below"
          />
        }
      />
      <SettingsRow
        searchId="desktop-intervention-alerts"
        title="Needs-input alerts"
        description="Notify when an agent asks a question or requests permission. The tray and dock badge always reflect agents waiting on you."
        trailing={
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,340px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
            value={preferences.alerts.intervention}
            options={INTERVENTION_ALERT_OPTIONS}
            onChange={(value) =>
              setAlertPreference("intervention", value as MobileNotificationAlertMode)
            }
            ariaLabel="Needs-input alerts"
            placement="below"
          />
        }
      />
      <SettingsRow
        searchId="desktop-eta-mode"
        title="Time estimates"
        description="Show a time-remaining hint in tray entries. Todo plans show their step progression - their extrapolated estimates swing wildly with task complexity; goals run long enough for an estimate to be meaningful."
        trailing={
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,340px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
            value={preferences.display.eta}
            options={ETA_MODE_OPTIONS}
            onChange={(value) =>
              setDisplayPreference("eta", value as MobileNotificationEtaMode)
            }
            ariaLabel="Time estimates in tray entries"
            placement="below"
          />
        }
      />
      <SettingsRow
        searchId="desktop-multi-agent-style"
        title="Multiple agents"
        description="With several agents running at once, either keep a tray entry per agent or fold them into one combined entry with aggregate progress."
        trailing={
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,340px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
            value={preferences.display.multiAgent}
            options={MULTI_AGENT_OPTIONS}
            onChange={(value) =>
              setDisplayPreference(
                "multiAgent",
                value as MobileNotificationMultiAgentMode
              )
            }
            ariaLabel="Multiple agent tray style"
            placement="below"
          />
        }
        border={false}
      />
    </SettingsSection>
  );
}
