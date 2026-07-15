import type { AndroidRuntimeConfig } from "../native/CesiumAndroidRuntime";

export type LaunchUrlConfig = {
  serverUrl: string;
  runtime: AndroidRuntimeConfig | null;
};

export type LaunchUrlConfigDefaults = {
  defaultServerUrl: string;
  globals?: {
    CESIUM_MOBILE_SERVER_URL?: string;
  };
};

export function createLaunchUrlConfig(
  defaults: LaunchUrlConfigDefaults,
  runtime: AndroidRuntimeConfig | null = null
): LaunchUrlConfig {
  return {
    serverUrl: normalizeUrl(defaults.globals?.CESIUM_MOBILE_SERVER_URL, defaults.defaultServerUrl),
    runtime,
  };
}

function normalizeUrl(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
