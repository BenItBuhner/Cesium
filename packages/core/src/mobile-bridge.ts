/**
 * Host ↔ web protocol for the Android shell, mirroring the Electron premise:
 * the native shell injects one small bootstrap before the workbench loads
 * (Electron: preload → `window.cesiumDesktop`; Android: this script →
 * `window.cesiumMobile`), and everything dynamic afterwards flows through
 * typed JSON messages (Electron: IPC; Android: WebView `postMessage`).
 *
 * This module is pure (no DOM access) so both the React Native shell and the
 * web workbench can consume it from `@cesium/core`. DOM-side helpers live in
 * the workbench at `src/lib/mobile-bridge.ts`.
 */

/**
 * Bumped when messages change shape incompatibly. Both sides report their
 * version in `webReady` / `nativeReady` so a stale APK shell paired with a
 * newer bundled workbench (or vice versa) is diagnosable instead of silent.
 */
export const MOBILE_BRIDGE_PROTOCOL_VERSION = 2;

export const MOBILE_BRIDGE_MESSAGE_EVENT = "cesium:mobile-bridge-message";
export const MOBILE_IDLE_CLASS = "opencursor-mobile-idle";

export const MOBILE_THEME_CONFIG_STORAGE_KEY = "opencursor-theme-config";
export const MOBILE_LEGACY_THEME_STORAGE_KEY = "opencursor-theme";
export const MOBILE_NATIVE_ROOT_CLASS = "opencursor-mobile-native";
export const MOBILE_SAFE_AREA_TOP_VAR = "--opencursor-mobile-safe-area-top";

export type MobileLifecycleState = "active" | "background" | "inactive";

/**
 * "live"  — Android Live Updates (promoted ongoing notifications). The system
 *           renders these in the status bar chip / lock screen, and Samsung's
 *           Now Bar picks them up automatically on One UI 8+. Falls back to a
 *           standard notification whenever promotion is unsupported/denied.
 * "basic" — standard live notification only, never request promotion.
 * "off"   — no run notifications.
 */
export type MobileLiveUpdatePreference = "live" | "basic" | "off";

export type MobileNativeStatus = {
  liveUpdates: {
    preference: MobileLiveUpdatePreference;
    sdkInt: number;
    progressStyleSupported: boolean;
    canPostPromotedNotifications: boolean;
    notificationPermissionGranted: boolean;
    /** Device manufacturer is Samsung (Now Bar renders live updates). */
    isSamsung?: boolean;
    /**
     * This Android build actually renders promoted live updates (Android 16
     * QPR1+ status chip, or Samsung One UI 8 Now Bar). Base Android 16
     * shipped the APIs without the system UI.
     */
    promotionRenderSupported?: boolean;
    /** Our notifications structurally qualify for promotion. */
    hasPromotableCharacteristics?: boolean;
    /** A Cesium notification is promoted (rendering live) right now. */
    promotedNotificationPosted?: boolean;
  };
  phoneControl?: {
    controlEnabled: boolean;
    configured: boolean;
    capabilities: {
      accessibilityEnabled: boolean;
      assistantRoleHeld: boolean;
    };
  } | null;
};

export type MobileServerConfig = {
  baseUrl: string;
  label?: string;
  authToken?: string | null;
  safeAreaTop?: number;
  systemColorScheme?: "light" | "dark" | null;
  runtime?: MobileRuntimeConfig | null;
};

export type MobileRuntimeConfig = {
  projectsDir?: string | null;
  serverDataDir?: string | null;
  defaultWorkspaceRoot?: string | null;
  allowedWorkspaceRoots?: string[];
  backendEnvironment?: Record<string, string>;
  localBackendReady?: boolean;
};

export type MobileFocusedConversation = {
  workspaceId: string | null;
  conversationId: string | null;
  lastEventSeq?: number;
  /** Every conversation with an active agent run, for background tracking. */
  activeConversationIds?: string[];
};

/** One file/stream delivered through the Android share sheet. */
export type MobileSharedItem = {
  name: string;
  mimeType: string;
  /** Raw content, base64-encoded by the native layer. */
  base64: string;
  byteLength: number;
};

/** Payload of an ACTION_SEND / ACTION_SEND_MULTIPLE intent forwarded to the web layer. */
export type MobileSharePayload = {
  text?: string | null;
  subject?: string | null;
  items: MobileSharedItem[];
  /** Items dropped natively (unreadable stream or over the size/count caps). */
  skippedCount?: number;
};

export type MobileAgentProjectionMessage = {
  type: "agentProjection";
  projection: unknown;
};

/** Full set of tracked agent projections (one live notification per run). */
export type MobileAgentProjectionsMessage = {
  type: "agentProjections";
  projections: unknown[];
};

export type MobileNativeToWebMessage =
  | { type: "nativeReady"; server: MobileServerConfig; protocolVersion?: number }
  /**
   * Dynamic host state (safe area, system color scheme, resolved server /
   * runtime). Replaces the old approach of re-injecting the entire bootstrap
   * script into the live page whenever any of these changed.
   */
  | { type: "nativeConfigChanged"; server: MobileServerConfig }
  | { type: "mobileNativeStatus"; status: MobileNativeStatus }
  | { type: "lifecycle"; state: MobileLifecycleState }
  | { type: "notificationAction"; actionId: string; workspaceId?: string | null; conversationId?: string | null }
  // Content arrived via the Android share sheet; the web layer shows the
  // share-intake picker (new chat vs existing) and prefills the composer.
  | { type: "shareIntake"; payload: MobileSharePayload }
  | { type: "resumeCatchUp"; workspaceId?: string | null; conversationId?: string | null; lastEventSeq?: number }
  // The Android hardware/predictive back gesture was invoked (committed). The
  // web layer owns the in-WebView navigation stack (open overlays, drawers,
  // settings view) and decides what to pop; if it cannot handle the intent it
  // replies with `backFallback` so the native shell can walk WebView history
  // or exit.
  | { type: "backRequest" }
  // Progressive predictive-back stream (Android 14+ gesture navigation). The
  // gesture `progress` runs 0..1 as the finger travels from the `swipeEdge`;
  // the web layer previews the pop (drawer follows the finger, settings view
  // scales down) and then either commits on `backRequest` or reverts on
  // `backCancelled`. Older Androids and 3-button navigation never send these,
  // so `backRequest` alone must stay sufficient.
  | { type: "backStarted"; progress: number; swipeEdge: "left" | "right"; touchX?: number; touchY?: number }
  | { type: "backProgressed"; progress: number; swipeEdge: "left" | "right"; touchX?: number; touchY?: number }
  | { type: "backCancelled" };

export type MobileWebToNativeMessage =
  | {
      type: "webReady";
      workspaceId: string | null;
      focusedConversationId: string | null;
      authToken?: string | null;
      protocolVersion?: number;
    }
  | ({ type: "focusedConversationChanged" } & MobileFocusedConversation)
  | MobileAgentProjectionMessage
  | MobileAgentProjectionsMessage
  | { type: "webRuntimeError"; message: string; source?: string; line?: number }
  | { type: "getMobileNativeStatus" }
  | { type: "setLiveUpdatePreference"; preference: MobileLiveUpdatePreference }
  | { type: "openLiveUpdatePromotionSettings" }
  /** Best-effort deep link into Samsung's Now Bar settings. */
  | { type: "openNowBarSettings" }
  | { type: "setPhoneControlEnabled"; enabled: boolean }
  | { type: "openPhoneAccessibilitySettings" }
  | { type: "requestPhoneAssistantRole" }
  | { type: "invokePhoneAssistant" }
  | { type: "openExternalUrl"; url: string }
  // Tells the native shell whether the web layer currently has an in-WebView
  // layer (overlay, drawer, settings view, …) that a back gesture should pop.
  // The native BackHandler uses this to decide between routing the gesture to
  // the web layer versus walking WebView history / exiting the app.
  | { type: "backCapability"; canHandleBack: boolean }
  // Sent in reply to `backRequest` when the web layer had nothing to pop after
  // all, so the native shell should perform its default back behavior.
  | { type: "backFallback" }
  | { type: "serverConfigured"; server: MobileServerConfig }
  | {
      type: "wearSyncEnvelope";
      envelopeJson: string;
      config: {
        serverBaseUrl: string;
        serverLabel: string;
        authToken?: string | null;
        workspaceId?: string | null;
        conversationId?: string | null;
      };
    };

export function encodeMobileBridgeMessage(
  message: MobileNativeToWebMessage | MobileWebToNativeMessage
): string {
  return JSON.stringify(message);
}

export function parseMobileBridgeMessage<TMessage>(raw: unknown): TMessage | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<{ type: unknown }>;
    return typeof parsed?.type === "string" ? (parsed as TMessage) : null;
  } catch {
    return null;
  }
}

export function normalizeMobileServerConfig(server: MobileServerConfig): MobileServerConfig {
  const safeAreaTop =
    Number.isFinite(server.safeAreaTop) && (server.safeAreaTop ?? 0) > 0
      ? Math.ceil(server.safeAreaTop ?? 0)
      : 0;
  return {
    baseUrl: server.baseUrl.replace(/\/+$/, ""),
    label: server.label ?? "Mobile server",
    authToken: server.authToken ?? null,
    safeAreaTop,
    systemColorScheme:
      server.systemColorScheme === "dark" || server.systemColorScheme === "light"
        ? server.systemColorScheme
        : null,
    runtime: normalizeMobileRuntimeConfig(server.runtime),
  };
}

/**
 * The one-time script the native shell injects before the workbench loads
 * (`injectedJavaScriptBeforeContentLoaded`), analogous to Electron's preload:
 * host identity + initial config + the message relay + a crash reporter.
 * Everything dynamic afterwards arrives via `nativeConfigChanged` messages —
 * the script is never re-injected into a live page.
 *
 * Polyfills and first-paint theming intentionally live in the bundled
 * workbench itself (see `apps/desktop-renderer` and the Android asset copy
 * step), not here.
 */
export function buildMobileBootstrapScript(server: MobileServerConfig): string {
  const normalizedServer = normalizeMobileServerConfig(server);
  const payload = JSON.stringify(normalizedServer);
  const readyMessage: MobileNativeToWebMessage = {
    type: "nativeReady",
    server: normalizedServer,
    protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
  };
  const serializedReadyMessage = JSON.stringify(JSON.stringify(readyMessage));
  return `
(() => {
  const server = ${payload};
  window.__CESIUM_MOBILE_SERVER__ = server;
  window.cesiumMobile = {
    isReactNative: true,
    protocolVersion: ${MOBILE_BRIDGE_PROTOCOL_VERSION},
    server,
    getBackendInfo: () => Promise.resolve(window.__CESIUM_MOBILE_SERVER__ || server)
  };
  window.__CESIUM_MOBILE_NATIVE_READY__ = ${serializedReadyMessage};
  const applyHostChrome = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.classList.add("${MOBILE_NATIVE_ROOT_CLASS}");
    root.style.setProperty(
      "${MOBILE_SAFE_AREA_TOP_VAR}",
      ((window.__CESIUM_MOBILE_SERVER__ || server).safeAreaTop || 0) + "px"
    );
    return true;
  };
  if (!applyHostChrome()) {
    document.addEventListener("DOMContentLoaded", applyHostChrome, { once: true });
  }
  if (!window.__CESIUM_MOBILE_BRIDGE_LISTENERS__) {
    window.__CESIUM_MOBILE_BRIDGE_LISTENERS__ = true;
    const relay = (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data && typeof data.type === "string") {
          window.dispatchEvent(
            new CustomEvent("${MOBILE_BRIDGE_MESSAGE_EVENT}", { detail: data })
          );
        }
      } catch {}
    };
    // react-native-webview delivers shell messages on window (new Chromium)
    // or document (older versions); listen on both.
    window.addEventListener("message", relay);
    document.addEventListener("message", relay);
    const reportError = (message, source, line) => {
      try {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: "webRuntimeError",
          message: String(message || "Unknown web runtime error"),
          source: source || undefined,
          line: Number.isFinite(line) ? line : undefined
        }));
      } catch {}
    };
    window.addEventListener("error", (event) => {
      reportError(
        event.message || (event.error && event.error.message),
        event.filename,
        event.lineno
      );
    });
    window.addEventListener("unhandledrejection", (event) => {
      reportError((event.reason && event.reason.message) || event.reason);
    });
  }
  true;
})();`;
}

/**
 * Inline first-paint script stamped into the bundled workbench's index.html
 * by the Android asset copy step. Applies the stored theme before the first
 * paint so a dark-theme user never sees a light flash — the same job
 * Electron solves with the BrowserWindow background color.
 */
export function buildMobileFirstPaintThemeScript(): string {
  return `
(() => {
  try {
    let preference = "system";
    try {
      const rawConfig = window.localStorage.getItem("${MOBILE_THEME_CONFIG_STORAGE_KEY}");
      if (rawConfig) {
        const appearance = (JSON.parse(rawConfig) || {}).appearance;
        if (appearance === "light" || appearance === "dark" || appearance === "system") {
          preference = appearance;
        }
      } else {
        const legacy = window.localStorage.getItem("${MOBILE_LEGACY_THEME_STORAGE_KEY}");
        if (legacy === "light" || legacy === "dark" || legacy === "system") {
          preference = legacy;
        }
      }
    } catch {}
    const server = window.__CESIUM_MOBILE_SERVER__;
    const systemDark = server && server.systemColorScheme
      ? server.systemColorScheme === "dark"
      : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const dark = preference === "dark" || (preference === "system" && systemDark);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch {}
})();`;
}

function normalizeMobileRuntimeConfig(runtime: MobileRuntimeConfig | null | undefined) {
  if (!runtime) {
    return null;
  }

  const backendEnvironment =
    runtime.backendEnvironment && typeof runtime.backendEnvironment === "object"
      ? Object.fromEntries(
          Object.entries(runtime.backendEnvironment).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length > 0
          )
        )
      : {};

  return {
    projectsDir: normalizeRuntimeString(runtime.projectsDir),
    serverDataDir: normalizeRuntimeString(runtime.serverDataDir),
    defaultWorkspaceRoot: normalizeRuntimeString(runtime.defaultWorkspaceRoot),
    allowedWorkspaceRoots: Array.isArray(runtime.allowedWorkspaceRoots)
      ? runtime.allowedWorkspaceRoots.filter(
          (value): value is string => typeof value === "string" && value.length > 0
        )
      : [],
    backendEnvironment,
    localBackendReady: runtime.localBackendReady === true,
  };
}

function normalizeRuntimeString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
