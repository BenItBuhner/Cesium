import {
  DeviceEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription,
} from "react-native";

export type WindowInsetsSnapshot = {
  safeAreaTop: number;
  statusBarTop: number;
  displayCutoutTop: number;
};

type CesiumWindowInsetsModule = {
  getInsets(): Promise<WindowInsetsSnapshot>;
};

/** Mirrors CesiumWindowInsetsHub.EVENT_NAME on the Kotlin side. */
const WINDOW_INSETS_CHANGED_EVENT = "cesiumWindowInsetsChanged";

const nativeModule = NativeModules.CesiumWindowInsets as CesiumWindowInsetsModule | undefined;

const available = Platform.OS === "android" && nativeModule != null;

export const CesiumWindowInsets = {
  /**
   * Snapshot of the current top window insets in dp. Rejects while the insets
   * are unreadable (activity detached or decor view without dispatched insets,
   * both transient around backgrounding/refocus) — callers must keep their
   * last known value instead of treating a failure as "no inset".
   */
  async getInsets(): Promise<WindowInsetsSnapshot> {
    if (Platform.OS === "ios") {
      // The iOS shell reports safe-area insets from its own runtime module.
      // Imported lazily to keep this module dependency-free on Android.
      // Failures reject (not zero) so callers keep their last known value,
      // matching the Android contract above.
      const { CesiumIOSRuntime } = await import("./CesiumIOSRuntime");
      return normalizeSnapshot(await CesiumIOSRuntime.getInsets());
    }
    if (!available || !nativeModule) {
      return fallbackInsets();
    }
    return normalizeSnapshot(await nativeModule.getInsets());
  },

  /**
   * Push path: native re-emits whenever the window's inset dispatch lands on
   * the activity content view, including the dispatch that follows every
   * resume/re-attach. This is what heals the safe area when a pull raced the
   * window state.
   */
  addChangeListener(
    listener: (snapshot: WindowInsetsSnapshot) => void
  ): EmitterSubscription | null {
    if (!available) {
      return null;
    }
    return DeviceEventEmitter.addListener(WINDOW_INSETS_CHANGED_EVENT, (payload) => {
      listener(normalizeSnapshot(payload as Partial<WindowInsetsSnapshot> | null));
    });
  },
};

function fallbackInsets(): WindowInsetsSnapshot {
  return {
    safeAreaTop: 0,
    statusBarTop: 0,
    displayCutoutTop: 0,
  };
}

function normalizeSnapshot(
  snapshot: Partial<WindowInsetsSnapshot> | null | undefined
): WindowInsetsSnapshot {
  const safeAreaTop = normalizeInset(snapshot?.safeAreaTop, 0);
  return {
    safeAreaTop,
    statusBarTop: normalizeInset(snapshot?.statusBarTop, safeAreaTop),
    displayCutoutTop: normalizeInset(snapshot?.displayCutoutTop, 0),
  };
}

function normalizeInset(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : fallback;
}
