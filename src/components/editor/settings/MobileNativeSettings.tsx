"use client";

import { useEffect, useState } from "react";
import {
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  DEFAULT_MOBILE_NOTIFICATION_ALERT_PREFERENCES,
  MOBILE_BRIDGE_MESSAGE_EVENT,
  postMobileBridgeMessage,
  type MobileLiveUpdatePreference,
  type MobileNotificationAlertMode,
  type MobileNativeStatus,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import { selectClass } from "./shared";

const MOBILE_LIVE_UPDATE_OPTIONS = [
  { value: "live", label: "Live Updates, with notification fallback" },
  { value: "basic", label: "Standard notification only" },
  { value: "off", label: "Off" },
] satisfies Array<{ value: MobileLiveUpdatePreference; label: string }>;

const COMPLETION_ALERT_OPTIONS = [
  { value: "always", label: "Always notify" },
  { value: "background", label: "Only when the app is in the background" },
  { value: "off", label: "Never" },
] satisfies Array<{ value: MobileNotificationAlertMode; label: string }>;

const INTERVENTION_ALERT_OPTIONS = [
  { value: "always", label: "Always alert" },
  { value: "background", label: "Alert only when the app is in the background" },
  { value: "off", label: "Silent" },
] satisfies Array<{ value: MobileNotificationAlertMode; label: string }>;

export function MobileNativeSettings() {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<MobileNativeStatus | null>(null);

  useEffect(() => {
    if (!window.ReactNativeWebView?.postMessage) return;
    setAvailable(true);
    const handleNativeStatus = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (message?.type === "mobileNativeStatus") {
        setStatus(message.status);
      }
    };
    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, handleNativeStatus);
    postMobileBridgeMessage({ type: "getMobileNativeStatus" });
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, handleNativeStatus);
    };
  }, []);

  if (!available) return null;
  const live = status?.liveUpdates;
  const phone = status?.phoneControl;
  const preference = live?.preference ?? "live";
  const alertPreferences =
    live?.alertPreferences ?? DEFAULT_MOBILE_NOTIFICATION_ALERT_PREFERENCES;
  const setAlertPreference = (
    key: "completion" | "intervention",
    value: MobileNotificationAlertMode
  ) =>
    postMobileBridgeMessage({
      type: "setNotificationAlertPreferences",
      preferences: { ...alertPreferences, [key]: value },
    });
  // Distinguish "the OS can render live updates" (Android 16 QPR1+ status
  // chip, or Samsung's Now Bar on One UI 8) from "the user allowed them".
  // Base Android 16 ships the APIs without the rendering UI, so
  // canPostPromotedNotifications is false there no matter what the user does.
  const apiSupported = live?.progressStyleSupported === true;
  const renderSupported = live?.promotionRenderSupported !== false;
  const promotionGranted = live?.canPostPromotedNotifications === true;
  const isSamsung = live?.isSamsung === true;
  const accessDescription = !apiSupported
    ? "This Android version does not support promoted Live Updates; Cesium falls back to standard live notifications."
    : !renderSupported
      ? "This Android 16 build ships the Live Updates APIs without the system UI that renders them (status bar chip arrives with Android 16 QPR1, and Samsung's Now Bar with One UI 8). Standard live notifications are used until a system update."
      : !promotionGranted
        ? isSamsung
          ? "Live Updates are supported but not yet allowed for Cesium. Allow them so agent runs render in Samsung's Now Bar and status bar instead of a plain notification."
          : "Live Updates are supported but not yet allowed for Cesium. Allow them so agent runs render as a status bar chip and pinned lock-screen card instead of a plain notification."
        : live?.promotedNotificationPosted
          ? "Live Updates are allowed and one is rendering right now."
          : isSamsung
            ? "Live Updates are allowed for Cesium. Active agent runs render in Samsung's Now Bar (lock screen / AOD) and the status bar."
            : "Live Updates are allowed for Cesium. Active agent runs render as a status bar chip and pinned lock-screen card.";

  return (
    <>
      <SettingsSection title="Mobile live activity">
        <SettingsRow
          searchId="mobile-live-update-placement"
          title="Run progress placement"
          description={
            apiSupported && renderSupported && promotionGranted
              ? "Android Live Updates show each agent run in the status bar chip, lock screen, and Samsung's Now Bar (One UI 8+)."
              : "Android Live Updates are preferred. This device will automatically fall back to a standard live notification while promoted ongoing activity is unavailable."
          }
          trailing={
            <SettingsThemeSelect
              className="w-full max-w-[min(100%,340px)]"
              triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
              value={preference}
              options={MOBILE_LIVE_UPDATE_OPTIONS}
              onChange={(value) =>
                postMobileBridgeMessage({
                  type: "setLiveUpdatePreference",
                  preference: value as MobileLiveUpdatePreference,
                })
              }
              ariaLabel="Mobile live activity placement"
              placement="below"
            />
          }
        />
        <SettingsRow
          searchId="mobile-live-update-access"
          title="Live Updates access"
          description={accessDescription}
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              disabled={!apiSupported}
              onClick={() =>
                postMobileBridgeMessage({ type: "openLiveUpdatePromotionSettings" })
              }
            >
              {apiSupported && renderSupported && !promotionGranted ? "Allow" : "Manage"}
            </button>
          }
        />
        <SettingsRow
          searchId="mobile-completion-alerts"
          title="Agent finished notifications"
          description="When an agent run completes, fails, or is cancelled. By default nothing is posted while you are inside the app — you are already watching it finish."
          trailing={
            <SettingsThemeSelect
              className="w-full max-w-[min(100%,340px)]"
              triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
              value={alertPreferences.completion}
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
          searchId="mobile-intervention-alerts"
          title="Needs-input alerts"
          description="Sound and heads-up when an agent asks a question or requests permission. The live notification itself always stays up to date."
          trailing={
            <SettingsThemeSelect
              className="w-full max-w-[min(100%,340px)]"
              triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,340px)]`}
              value={alertPreferences.intervention}
              options={INTERVENTION_ALERT_OPTIONS}
              onChange={(value) =>
                setAlertPreference("intervention", value as MobileNotificationAlertMode)
              }
              ariaLabel="Needs-input alerts"
              placement="below"
            />
          }
          border={isSamsung}
        />
        {isSamsung ? (
          <SettingsRow
            searchId="mobile-now-bar-settings"
            title="Samsung Now Bar"
            description="One UI renders Cesium's Live Updates in the Now Bar on the lock screen and Always On Display. Make sure the Now Bar is on and Cesium's live notifications are enabled there."
            trailing={
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => postMobileBridgeMessage({ type: "openNowBarSettings" })}
              >
                Now Bar settings
              </button>
            }
            border={false}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Phone & assistant">
        <SettingsRow
          title="Device control"
          description="Allow the connected Cesium server to use Android accessibility, screen, app, settings, and global-action tools."
          trailing={
            <ToggleSwitch
              checked={phone?.controlEnabled ?? false}
              onChange={(enabled) =>
                postMobileBridgeMessage({ type: "setPhoneControlEnabled", enabled })
              }
              size="md"
            />
          }
        />
        <SettingsRow
          title="Accessibility control"
          description={
            phone?.capabilities.accessibilityEnabled
              ? "Cesium's Android accessibility service is enabled."
              : "Enable Cesium to inspect and operate foreground Android interfaces."
          }
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                postMobileBridgeMessage({ type: "openPhoneAccessibilitySettings" })
              }
            >
              Manage
            </button>
          }
        />
        <SettingsRow
          title="System assistant"
          description={
            phone?.capabilities.assistantRoleHeld
              ? "Cesium is the configured Android assistant."
              : "Configure Cesium for the assistant gesture / power-button shortcut."
          }
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                postMobileBridgeMessage({ type: "requestPhoneAssistantRole" })
              }
            >
              {phone?.capabilities.assistantRoleHeld ? "Configured" : "Configure"}
            </button>
          }
        />
        <SettingsRow
          title="Assistant overlay"
          description="Open the native Cesium assistant over the current app."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => postMobileBridgeMessage({ type: "invokePhoneAssistant" })}
            >
              Open
            </button>
          }
          border={false}
        />
      </SettingsSection>
    </>
  );
}
