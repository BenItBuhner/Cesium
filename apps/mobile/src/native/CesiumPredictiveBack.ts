import {
  DeviceEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription,
} from "react-native";

/**
 * Payload emitted with `started` / `progressed`. Mirrors Android's
 * `BackEventCompat`: `progress` runs 0..1 across the gesture, `swipeEdge` is
 * 0 (left) or 1 (right), and the touch point is in pixels.
 */
export type PredictiveBackGestureEvent = {
  progress?: number;
  swipeEdge?: number;
  touchX?: number;
  touchY?: number;
};

export type PredictiveBackEventName =
  | "started"
  | "progressed"
  | "cancelled"
  | "invoked";

const NATIVE_EVENT_NAMES: Record<PredictiveBackEventName, string> = {
  started: "cesiumBackStarted",
  progressed: "cesiumBackProgressed",
  cancelled: "cesiumBackCancelled",
  invoked: "cesiumBackInvoked",
};

type CesiumPredictiveBackModule = {
  setBackInterceptEnabled(enabled: boolean): void;
};

const nativeModule = NativeModules.CesiumPredictiveBack as
  | CesiumPredictiveBackModule
  | undefined;

const available = Platform.OS === "android" && nativeModule != null;

/**
 * Progressive predictive-back bridge. While the intercept is armed, the
 * native `OnBackPressedCallback` in MainActivity outranks React Native's own
 * plain callback, so back gestures stream here (with per-frame progress on
 * API 34+) instead of firing a single discrete `hardwareBackPress`. While
 * disarmed, everything behaves exactly as before this module existed.
 */
export const CesiumPredictiveBack = {
  isAvailable: available,

  /**
   * Arm/disarm in-app back interception. Must mirror "the app has something
   * to pop" (an in-WebView layer or WebView history): the dispatcher decides
   * at gesture *start* who owns the gesture, so this state has to be kept
   * current proactively, not resolved lazily at commit time. Native
   * auto-disarms after every committed gesture; re-arming happens when the
   * web layer republishes its capability.
   */
  setBackInterceptEnabled(enabled: boolean): void {
    if (available) {
      nativeModule?.setBackInterceptEnabled(enabled);
    }
  },

  addListener(
    event: PredictiveBackEventName,
    listener: (payload: PredictiveBackGestureEvent) => void
  ): EmitterSubscription | null {
    if (!available) {
      return null;
    }
    return DeviceEventEmitter.addListener(NATIVE_EVENT_NAMES[event], listener);
  },
};
