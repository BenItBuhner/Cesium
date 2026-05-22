import { Platform } from "react-native";

declare const __DEV__: boolean;

export const DEFAULT_ANDROID_SERVER_URL = "http://10.0.2.2:9100";
export const DEFAULT_ANDROID_WEB_DEV_URL = "http://10.0.2.2:5173";
export const BUNDLED_WORKBENCH_URL = Platform.select({
  android: "file:///android_asset/workbench/index.html",
  default: DEFAULT_ANDROID_WEB_DEV_URL,
});

export function readLaunchUrlConfig() {
  const maybeGlobal = globalThis as typeof globalThis & {
    CESIUM_MOBILE_WEB_URL?: string;
    CESIUM_MOBILE_SERVER_URL?: string;
  };
  return {
    webUrl: maybeGlobal.CESIUM_MOBILE_WEB_URL || (__DEV__ ? DEFAULT_ANDROID_WEB_DEV_URL : BUNDLED_WORKBENCH_URL),
    serverUrl: maybeGlobal.CESIUM_MOBILE_SERVER_URL || DEFAULT_ANDROID_SERVER_URL,
  };
}
