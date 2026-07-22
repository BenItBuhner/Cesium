import { Platform } from "react-native";
import { CesiumAndroidRuntime, type AndroidRuntimeConfig } from "./native/CesiumAndroidRuntime";
import { createLaunchUrlConfig } from "./services/launchConfig";

export const DEFAULT_ANDROID_SERVER_URL = "http://10.0.2.2:9100";
export const DEFAULT_ANDROID_WEB_DEV_URL = "http://10.0.2.2:5173";
export const BUNDLED_WORKBENCH_URL =
  Platform.OS === "android"
    ? "file:///android_asset/workbench/index.html"
    : DEFAULT_ANDROID_WEB_DEV_URL;

export function readLaunchUrlConfig(runtime: AndroidRuntimeConfig | null = null) {
  const maybeGlobal = globalThis as typeof globalThis & {
    CESIUM_MOBILE_WEB_URL?: string;
  };
  return {
    ...createLaunchUrlConfig(readLaunchUrlDefaults(), runtime),
    // The bundled Vite renderer is the default in both debug and release APKs.
    // A developer may opt into a live Vite server explicitly by assigning
    // globalThis.CESIUM_MOBILE_WEB_URL before the app mounts.
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
    defaultServerUrl: DEFAULT_ANDROID_SERVER_URL,
    globals: maybeGlobal,
  };
}
