import { CesiumAndroidRuntime, type AndroidRuntimeConfig } from "./native/CesiumAndroidRuntime";
import { createLaunchUrlConfig } from "./services/launchConfig";

export const DEFAULT_ANDROID_SERVER_URL = "http://10.0.2.2:9100";

export function readLaunchUrlConfig(runtime: AndroidRuntimeConfig | null = null) {
  return createLaunchUrlConfig(readLaunchUrlDefaults(), runtime);
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
