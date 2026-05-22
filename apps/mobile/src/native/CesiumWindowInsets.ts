import { NativeModules, Platform } from "react-native";

export type WindowInsetsSnapshot = {
  safeAreaTop: number;
  statusBarTop: number;
  displayCutoutTop: number;
};

type CesiumWindowInsetsModule = {
  getInsets(): Promise<WindowInsetsSnapshot>;
};

const nativeModule = NativeModules.CesiumWindowInsets as CesiumWindowInsetsModule | undefined;

export const CesiumWindowInsets = {
  async getInsets(): Promise<WindowInsetsSnapshot> {
    if (Platform.OS !== "android" || !nativeModule) {
      return fallbackInsets();
    }
    const snapshot = await nativeModule.getInsets();
    const safeAreaTop = normalizeInset(snapshot.safeAreaTop, 0);
    return {
      safeAreaTop,
      statusBarTop: normalizeInset(snapshot.statusBarTop, safeAreaTop),
      displayCutoutTop: normalizeInset(snapshot.displayCutoutTop, 0),
    };
  },
};

function fallbackInsets(): WindowInsetsSnapshot {
  return {
    safeAreaTop: 0,
    statusBarTop: 0,
    displayCutoutTop: 0,
  };
}

function normalizeInset(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : fallback;
}
