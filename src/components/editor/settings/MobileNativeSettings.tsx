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
  MOBILE_BRIDGE_MESSAGE_EVENT,
  postMobileBridgeMessage,
  type MobileLiveUpdatePreference,
  type MobileNativeStatus,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import { selectClass } from "./shared";

const MOBILE_LIVE_UPDATE_OPTIONS = [
  { value: "nowbar", label: "Now Bar, with live notification fallback" },
  { value: "live", label: "Live notification only" },
  { value: "off", label: "Off" },
] satisfies Array<{ value: MobileLiveUpdatePreference; label: string }>;

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
  const preference = live?.preference ?? "nowbar";
  const promotionAvailable =
    live?.progressStyleSupported && live.canPostPromotedNotifications;

  return (
    <>
      <SettingsSection title="Mobile live activity">
        <SettingsRow
          searchId="mobile-live-update-placement"
          title="Run progress placement"
          description={
            promotionAvailable
              ? "Prefer Samsung Now Bar / Android promoted ongoing activity, with a normal live notification fallback."
              : "Now Bar is preferred. This device will automatically use a normal live notification when promoted ongoing activity is unavailable."
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
          title="Now Bar access"
          description={
            live?.progressStyleSupported
              ? live.canPostPromotedNotifications
                ? "Promoted ongoing notifications are allowed for Cesium."
                : "Android supports promoted ongoing notifications, but access is not currently allowed."
              : "This Android version does not support promoted ongoing notifications; Cesium will use live notifications."
          }
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              disabled={!live?.progressStyleSupported}
              onClick={() =>
                postMobileBridgeMessage({ type: "openLiveUpdatePromotionSettings" })
              }
            >
              Manage
            </button>
          }
          border={false}
        />
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
