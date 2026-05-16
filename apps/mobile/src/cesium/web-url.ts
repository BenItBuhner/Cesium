import { Platform } from "react-native";

const DEFAULT_ANDROID_HOST_URL = "http://10.0.2.2:3000";
const DEFAULT_LOCAL_HOST_URL = "http://localhost:3000";
const DEFAULT_ANDROID_SERVER_URL = "http://10.0.2.2:9100";
const DEFAULT_LOCAL_SERVER_URL = "http://localhost:9100";
const CESIUM_WORKSPACE_PATH = "/workspace";

export function getCesiumWebUrl() {
  const configuredUrl =
    process.env.EXPO_PUBLIC_CESIUM_WEB_URL ??
    process.env.EXPO_PUBLIC_OPENCURSOR_WEB_URL ??
    process.env.EXPO_PUBLIC_WEB_URL;

  if (configuredUrl && configuredUrl.trim().length > 0) {
    return normalizeWebAppUrl(configuredUrl);
  }

  return normalizeWebAppUrl(
    Platform.OS === "android" ? DEFAULT_ANDROID_HOST_URL : DEFAULT_LOCAL_HOST_URL
  );
}

export function getCesiumServerUrl() {
  const configuredUrl =
    process.env.EXPO_PUBLIC_CESIUM_SERVER_URL ??
    process.env.EXPO_PUBLIC_OPENCURSOR_SERVER_URL ??
    process.env.EXPO_PUBLIC_SERVER_URL;

  if (configuredUrl && configuredUrl.trim().length > 0) {
    return normalizeUrl(configuredUrl);
  }

  return Platform.OS === "android"
    ? DEFAULT_ANDROID_SERVER_URL
    : DEFAULT_LOCAL_SERVER_URL;
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeWebAppUrl(value: string) {
  const normalized = normalizeUrl(value.trim());
  try {
    const url = new URL(normalized);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = CESIUM_WORKSPACE_PATH;
    }
    return normalizeUrl(url.toString());
  } catch {
    return normalized.endsWith(CESIUM_WORKSPACE_PATH)
      ? normalized
      : `${normalized}${CESIUM_WORKSPACE_PATH}`;
  }
}
