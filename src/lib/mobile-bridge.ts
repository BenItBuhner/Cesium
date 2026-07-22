"use client";

export const MOBILE_BRIDGE_MESSAGE_EVENT = "cesium:mobile-bridge-message";
export const MOBILE_IDLE_CLASS = "opencursor-mobile-idle";

const MOBILE_THEME_CONFIG_STORAGE_KEY = "opencursor-theme-config";
const MOBILE_LEGACY_THEME_STORAGE_KEY = "opencursor-theme";

export type MobileLifecycleState = "active" | "background" | "inactive";
export type MobileLiveUpdatePreference = "nowbar" | "live" | "off";

export type MobileNativeStatus = {
  liveUpdates: {
    preference: MobileLiveUpdatePreference;
    sdkInt: number;
    progressStyleSupported: boolean;
    canPostPromotedNotifications: boolean;
    notificationPermissionGranted: boolean;
  };
  phoneControl?: unknown;
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
};

export type MobileAgentProjectionMessage = {
  type: "agentProjection";
  projection: unknown;
};

export type MobileNativeToWebMessage =
  | { type: "nativeReady"; server: MobileServerConfig }
  | { type: "mobileNativeStatus"; status: MobileNativeStatus }
  | { type: "lifecycle"; state: MobileLifecycleState }
  | { type: "notificationAction"; actionId: string; workspaceId?: string | null; conversationId?: string | null }
  | { type: "resumeCatchUp"; workspaceId?: string | null; conversationId?: string | null; lastEventSeq?: number };

export type MobileWebToNativeMessage =
  | { type: "webReady"; workspaceId: string | null; focusedConversationId: string | null; authToken?: string | null }
  | ({ type: "focusedConversationChanged" } & MobileFocusedConversation)
  | MobileAgentProjectionMessage
  | { type: "webIdleMode"; enabled: boolean }
  | { type: "webRuntimeError"; message: string; source?: string; line?: number }
  | { type: "getMobileNativeStatus" }
  | { type: "setLiveUpdatePreference"; preference: MobileLiveUpdatePreference }
  | { type: "openLiveUpdatePromotionSettings" }
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

export function encodeMobileBridgeMessage(message: MobileNativeToWebMessage | MobileWebToNativeMessage): string {
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

export function postMobileBridgeMessage(message: MobileWebToNativeMessage): boolean {
  const bridge = typeof window !== "undefined" ? window.ReactNativeWebView : undefined;
  if (!bridge?.postMessage) {
    return false;
  }
  bridge.postMessage(encodeMobileBridgeMessage(message));
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

export function buildMobileBootstrapScript(server: MobileServerConfig): string {
  const safeAreaTop =
    Number.isFinite(server.safeAreaTop) && (server.safeAreaTop ?? 0) > 0
      ? Math.ceil(server.safeAreaTop ?? 0)
      : 0;
  const normalizedServer = {
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
  const payload = JSON.stringify(normalizedServer);
  const message = JSON.stringify({ type: "nativeReady", server: normalizedServer });
  const serializedMessage = JSON.stringify(message);
  const themeConfigStorageKey = JSON.stringify(MOBILE_THEME_CONFIG_STORAGE_KEY);
  const legacyThemeStorageKey = JSON.stringify(MOBILE_LEGACY_THEME_STORAGE_KEY);
  return `
(() => {
  // Android 11 ships Chromium WebView 83. Keep the bundled workbench usable on
  // every supported Android API (minSdk 26) by installing the modern built-ins
  // used by today's canonical web client before its module executes.
  const relativeIndex = (length, index) => {
    const value = Number(index) || 0;
    const integer = value < 0 ? Math.ceil(value) : Math.floor(value);
    return integer < 0 ? length + integer : integer;
  };
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, "at", {
      configurable: true,
      writable: true,
      value: function(index) { return this[relativeIndex(this.length, index)]; }
    });
  }
  if (!String.prototype.at) {
    Object.defineProperty(String.prototype, "at", {
      configurable: true,
      writable: true,
      value: function(index) {
        const position = relativeIndex(this.length, index);
        return position < 0 || position >= this.length ? undefined : this.charAt(position);
      }
    });
  }
  [
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
    "BigUint64Array"
  ].forEach((name) => {
    const ctor = window[name];
    if (ctor && !ctor.prototype.at) {
      Object.defineProperty(ctor.prototype, "at", {
        configurable: true,
        writable: true,
        value: function(index) { return this[relativeIndex(this.length, index)]; }
      });
    }
  });
  if (!Object.hasOwn) {
    Object.hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  }
  if (!String.prototype.replaceAll) {
    Object.defineProperty(String.prototype, "replaceAll", {
      configurable: true,
      writable: true,
      value: function(search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) throw new TypeError("replaceAll requires a global RegExp");
          return this.replace(search, replacement);
        }
        return this.split(String(search)).join(String(replacement));
      }
    });
  }
  if (!globalThis.structuredClone) {
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  }
  if (globalThis.crypto && !globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = () =>
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = Math.random() * 16 | 0;
        return (char === "x" ? random : (random & 3) | 8).toString(16);
      });
  }
  const server = ${payload};
  window.__CESIUM_MOBILE_SERVER__ = server;
  const readThemePreference = () => {
    try {
      const rawConfig = window.localStorage.getItem(${themeConfigStorageKey});
      if (rawConfig) {
        const config = JSON.parse(rawConfig);
        const appearance = config && config.appearance;
        if (appearance === "light" || appearance === "dark" || appearance === "system") {
          return appearance;
        }
      }
    } catch {}
    try {
      const legacy = window.localStorage.getItem(${legacyThemeStorageKey});
      if (legacy === "light" || legacy === "dark" || legacy === "system") {
        return legacy;
      }
    } catch {}
    return "system";
  };
  const systemPrefersDark = () => {
    const currentServer = window.__CESIUM_MOBILE_SERVER__ || server;
    if (currentServer.systemColorScheme === "dark") return true;
    if (currentServer.systemColorScheme === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  };
  const applyStartupTheme = () => {
    const preference = readThemePreference();
    const dark = preference === "dark" || (preference === "system" && systemPrefersDark());
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  const ensureMobileSafeAreaStyle = () => {
    const styleId = "opencursor-mobile-safe-area-style";
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [
      ".opencursor-mobile-native{--opencursor-mobile-safe-area-top:0px;}",
      ".opencursor-mobile-native .mobile-safe-top-pad{padding-top:var(--opencursor-mobile-safe-area-top)!important;}",
      ".opencursor-mobile-native .mobile-safe-top-content{padding-top:var(--opencursor-mobile-safe-area-top)!important;}",
      ".opencursor-mobile-native .mobile-safe-top-offset{top:var(--opencursor-mobile-safe-area-top)!important;}",
      ".opencursor-mobile-native .mobile-safe-top-scroll{scroll-padding-top:var(--opencursor-mobile-safe-area-top)!important;}"
    ].join("\\n");
  };
  const applyMobileSafeArea = () => {
    ensureMobileSafeAreaStyle();
    const root = document.documentElement;
    root.classList.add("opencursor-mobile-native");
    root.style.setProperty("--opencursor-mobile-safe-area-top", server.safeAreaTop + "px");
  };
  applyStartupTheme();
  applyMobileSafeArea();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyStartupTheme();
      applyMobileSafeArea();
    }, { once: true });
  }
  const themeMedia = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (!server.systemColorScheme && themeMedia && themeMedia.addEventListener && !window.__CESIUM_MOBILE_THEME_LISTENER__) {
    window.__CESIUM_MOBILE_THEME_LISTENER__ = true;
    themeMedia.addEventListener("change", () => {
      if (readThemePreference() === "system") applyStartupTheme();
    });
  }
  requestAnimationFrame(applyStartupTheme);
  requestAnimationFrame(applyMobileSafeArea);
  setTimeout(applyStartupTheme, 0);
  setTimeout(applyMobileSafeArea, 0);
  setTimeout(applyStartupTheme, 250);
  setTimeout(applyMobileSafeArea, 250);
  window.__CESIUM_MOBILE_SERVER__ = server;
  window.cesiumMobile = {
    isReactNative: true,
    server,
    getBackendInfo: () => Promise.resolve(server)
  };
  window.__CESIUM_MOBILE_NATIVE_READY__ = ${serializedMessage};
  if (!window.__CESIUM_MOBILE_BRIDGE_LISTENERS__) {
    window.__CESIUM_MOBILE_BRIDGE_LISTENERS__ = true;
    window.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data && typeof data.type === "string") {
          window.dispatchEvent(new CustomEvent("${MOBILE_BRIDGE_MESSAGE_EVENT}", { detail: data }));
        }
      } catch {}
    });
    document.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data && typeof data.type === "string") {
          window.dispatchEvent(new CustomEvent("${MOBILE_BRIDGE_MESSAGE_EVENT}", { detail: data }));
        }
      } catch {}
    });
  }
  true;
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

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage(message: string): void;
    };
    __CESIUM_MOBILE_NATIVE_READY__?: string;
    __CESIUM_MOBILE_SERVER__?: MobileServerConfig;
    __CESIUM_MOBILE_BRIDGE_LISTENERS__?: boolean;
    __CESIUM_MOBILE_THEME_LISTENER__?: boolean;
    cesiumMobile?: {
      isReactNative?: boolean;
      server?: MobileServerConfig;
      getBackendInfo?: () => Promise<MobileServerConfig>;
    };
  }
}
