"use client";

/**
 * DOM-side helpers for the Android host bridge. The protocol itself (message
 * types, version, bootstrap builder) is shared with the native shell via
 * `@cesium/core` - see `packages/core/src/mobile-bridge.ts`.
 */

import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_LEGACY_THEME_STORAGE_KEY,
  MOBILE_NATIVE_ROOT_CLASS,
  MOBILE_SAFE_AREA_TOP_VAR,
  MOBILE_THEME_CONFIG_STORAGE_KEY,
  encodeMobileBridgeMessage,
  type MobileNativeToWebMessage,
  type MobileServerConfig,
  type MobileWebToNativeMessage,
} from "@cesium/core";
import { ensureNativeClerkHandoffOnAuthUrl } from "@/lib/cloud/clerk-native-handoff";

export {
  isMobileExternalHttpUrl,
  mobileExternalHttpUrl,
  shouldOpenMobileNavigationExternally,
} from "@cesium/core";
export {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  MOBILE_IDLE_CLASS,
  MOBILE_NATIVE_ROOT_CLASS,
  MOBILE_SAFE_AREA_TOP_VAR,
  encodeMobileBridgeMessage,
  parseMobileBridgeMessage,
  buildMobileBootstrapScript,
  DEFAULT_MOBILE_NOTIFICATION_ALERT_PREFERENCES,
  DEFAULT_MOBILE_NOTIFICATION_DISPLAY_PREFERENCES,
  type MobileLifecycleState,
  type MobileLiveUpdatePreference,
  type MobileNotificationAlertMode,
  type MobileNotificationAlertPreferences,
  type MobileNotificationDisplayPreferences,
  type MobileNotificationEtaMode,
  type MobileNotificationMultiAgentMode,
  type MobileNativeStatus,
  type MobileServerConfig,
  type MobileRuntimeConfig,
  type MobileFocusedConversation,
  type MobileAgentProjectionMessage,
  type MobileAgentProjectionsMessage,
  type MobileNativeToWebMessage,
  type MobileSharedItem,
  type MobileSharePayload,
  type MobileWebToNativeMessage,
} from "@cesium/core";

/**
 * Whether the page runs inside the native mobile shell (the WebView host
 * injects `ReactNativeWebView` before any page script executes, so this is
 * stable for the whole session).
 */
export function hasMobileBridge(): boolean {
  return typeof window !== "undefined" && window.ReactNativeWebView?.postMessage != null;
}

export function postMobileBridgeMessage(message: MobileWebToNativeMessage): boolean {
  const bridge = typeof window !== "undefined" ? window.ReactNativeWebView : undefined;
  if (!bridge?.postMessage) {
    return false;
  }
  bridge.postMessage(encodeMobileBridgeMessage(message));
  return true;
}

/**
 * Open an http(s) URL outside the workbench. On the Android / iOS WebView
 * host this asks the native shell to hand the URL to the system browser
 * (`Linking.openURL`) so OAuth and other redirects do not unload the
 * bundled `file://` page. Desktop / regular browsers keep `window.open`.
 */
export function openExternalUrl(
  url: string,
  options?: { target?: string; features?: string }
): boolean {
  if (!url) {
    return false;
  }
  const resolved = ensureNativeClerkHandoffOnAuthUrl(url);
  if (postMobileBridgeMessage({ type: "openExternalUrl", url: resolved })) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  window.open(resolved, options?.target ?? "_blank", options?.features ?? "noopener,noreferrer");
  return true;
}

export function dispatchMobileBridgeMessage(message: MobileNativeToWebMessage): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<MobileNativeToWebMessage>(MOBILE_BRIDGE_MESSAGE_EVENT, {
      detail: message,
    })
  );
}

/**
 * Applies dynamic host state from a `nativeConfigChanged` message: refreshes
 * the injected server globals, the safe-area inset, and - when the user
 * follows the system theme - the dark class driven by the native color
 * scheme (the WebView's own `prefers-color-scheme` is not reliable across
 * Android configuration changes).
 */
export function applyMobileHostConfig(server: MobileServerConfig): void {
  if (typeof window === "undefined") {
    return;
  }
  window.__CESIUM_MOBILE_SERVER__ = server;
  if (window.cesiumMobile) {
    window.cesiumMobile.server = server;
  }
  const root = document.documentElement;
  root.classList.add(MOBILE_NATIVE_ROOT_CLASS);
  root.style.setProperty(MOBILE_SAFE_AREA_TOP_VAR, `${server.safeAreaTop ?? 0}px`);
  if (server.systemColorScheme && readMobileThemePreference() === "system") {
    const dark = server.systemColorScheme === "dark";
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }
}

function readMobileThemePreference(): "light" | "dark" | "system" {
  try {
    const rawConfig = window.localStorage.getItem(MOBILE_THEME_CONFIG_STORAGE_KEY);
    if (rawConfig) {
      const appearance = (JSON.parse(rawConfig) as { appearance?: unknown } | null)
        ?.appearance;
      if (appearance === "light" || appearance === "dark" || appearance === "system") {
        return appearance;
      }
    }
  } catch {
    // Fall through to the legacy key.
  }
  try {
    const legacy = window.localStorage.getItem(MOBILE_LEGACY_THEME_STORAGE_KEY);
    if (legacy === "light" || legacy === "dark" || legacy === "system") {
      return legacy;
    }
  } catch {
    // Default below.
  }
  return "system";
}

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage(message: string): void;
    };
    __CESIUM_MOBILE_NATIVE_READY__?: string;
    __CESIUM_MOBILE_SERVER__?: MobileServerConfig;
    __CESIUM_MOBILE_BRIDGE_LISTENERS__?: boolean;
    __CESIUM_MOBILE_EXTERNAL_NAV__?: boolean;
    cesiumMobile?: {
      isReactNative?: boolean;
      protocolVersion?: number;
      server?: MobileServerConfig;
      getBackendInfo?: () => Promise<MobileServerConfig>;
    };
  }
}
