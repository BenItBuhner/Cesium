import { NativeModules, Platform } from "react-native";
import type { MobileSharePayload } from "../../../../src/lib/mobile-bridge";

type CesiumShareModule = {
  consumeSharePayload(): Promise<MobileSharePayload | null>;
};

const nativeModule = NativeModules.CesiumShare as CesiumShareModule | undefined;

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
};
