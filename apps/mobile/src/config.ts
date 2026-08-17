import { Platform } from "react-native";
import { CesiumAndroidRuntime, type AndroidRuntimeConfig } from "./native/CesiumAndroidRuntime";
import { CesiumIOSRuntime } from "./native/CesiumIOSRuntime";
import { createLaunchUrlConfig } from "./services/launchConfig";

// Android emulators reach the host through the 10.0.2.2 alias; the iOS
// simulator shares the host network stack, so host loopback works there.
// Numeric 127.0.0.1 on purpose (like Android's numeric alias): "localhost"
// resolves to ::1 first on Apple platforms and an IPv4-only server leaves the
// WebKit network process hanging instead of falling back. Physical devices
// point at a LAN/Tailscale server via in-app configuration.
export const DEFAULT_ANDROID_SERVER_URL = "http://10.0.2.2:9100";
export const DEFAULT_IOS_SERVER_URL = "http://127.0.0.1:9100";
export const DEFAULT_SERVER_URL =
  Platform.OS === "ios" ? DEFAULT_IOS_SERVER_URL : DEFAULT_ANDROID_SERVER_URL;

export const DEFAULT_ANDROID_WEB_DEV_URL = "http://10.0.2.2:5173";
export const DEFAULT_IOS_WEB_DEV_URL = "http://localhost:5173";

export const BUNDLED_WORKBENCH_URL = resolveBundledWorkbenchUrl();

function resolveBundledWorkbenchUrl(): string {
  if (Platform.OS === "android") {
    return "file:///android_asset/workbench/index.html";
  }
  if (Platform.OS === "ios") {
    // The workbench ships inside the .app as a folder resource; the native
    // runtime exposes its file URL as a synchronous constant. Fall back to a
    // live Vite server when the assets were not bundled (bare dev builds).
    return CesiumIOSRuntime.getWorkbenchUrl() ?? DEFAULT_IOS_WEB_DEV_URL;
  }
  return DEFAULT_ANDROID_WEB_DEV_URL;
}

export function readLaunchUrlConfig(runtime: AndroidRuntimeConfig | null = null) {
  const maybeGlobal = globalThis as typeof globalThis & {
    CESIUM_MOBILE_WEB_URL?: string;
  };
  return {
    ...createLaunchUrlConfig(readLaunchUrlDefaults(), runtime),
    // The bundled Vite renderer is the default in both debug and release
    // builds. A developer may opt into a live Vite server explicitly by
    // assigning globalThis.CESIUM_MOBILE_WEB_URL before the app mounts.
    webUrl:
      typeof maybeGlobal.CESIUM_MOBILE_WEB_URL === "string" &&
      maybeGlobal.CESIUM_MOBILE_WEB_URL.trim().length > 0
        ? maybeGlobal.CESIUM_MOBILE_WEB_URL.trim()
        : BUNDLED_WORKBENCH_URL,
  };
}

export async function resolveLaunchUrlConfig() {
  return readLaunchUrlConfig(await CesiumAndroidRuntime.getRuntimeConfig());
}

function readLaunchUrlDefaults() {
  const maybeGlobal = globalThis as typeof globalThis & {
    CESIUM_MOBILE_SERVER_URL?: string;
  };
  return {
    defaultServerUrl: DEFAULT_SERVER_URL,
    globals: maybeGlobal,
  };
}
