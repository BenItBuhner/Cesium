import { DeviceEventEmitter, Platform, NativeModules } from "react-native";
import type { MobileSharePayload } from "../../../../src/lib/mobile-bridge";

type CesiumShareModule = {
  consumeSharePayload(): Promise<MobileSharePayload | null>;
};

const nativeModule = NativeModules.CesiumShare as CesiumShareModule | undefined;

/** Emitted by CesiumShareModule whenever a new share intent is parked. */
const SHARE_EVENT = "cesiumShareIntent";

export const CesiumShare = {
  /**
   * Drains the share intent parked by MainActivity, if any. Returns null when
   * nothing was shared since the last call (or on non-Android platforms).
   */
  async consumeSharePayload(): Promise<MobileSharePayload | null> {
    if (Platform.OS !== "android" || !nativeModule?.consumeSharePayload) {
      return null;
    }
    try {
      return await nativeModule.consumeSharePayload();
    } catch {
      return null;
    }
  },

  /**
   * Fires when a share intent arrives while the app is already running
   * (onNewIntent never changes AppState, so polling on "active" is not
   * enough). Returns an unsubscribe function.
   */
  onShareIntentReceived(listener: () => void): () => void {
    if (Platform.OS !== "android") {
      return () => undefined;
    }
    const subscription = DeviceEventEmitter.addListener(SHARE_EVENT, listener);
    return () => subscription.remove();
  },
};
