import { NativeModules, Platform } from "react-native";
import type { LiveUpdatePayload, LiveUpdateStatus } from "../services/liveUpdateTypes";

type CesiumLiveUpdatesModule = {
  startOrUpdate(payload: LiveUpdatePayload): Promise<LiveUpdateStatus>;
  stop(): Promise<void>;
  getPromotionStatus(): Promise<LiveUpdateStatus>;
  consumeInitialNotificationAction(): Promise<{
    actionId?: string;
    workspaceId?: string;
    conversationId?: string;
  }>;
};

const nativeModule = NativeModules.CesiumLiveUpdates as CesiumLiveUpdatesModule | undefined;

export const CesiumLiveUpdates: CesiumLiveUpdatesModule = {
  async startOrUpdate(payload) {
    if (Platform.OS !== "android" || !nativeModule) {
      return fallbackStatus();
    }
    return nativeModule.startOrUpdate(payload);
  },
  async stop() {
    if (Platform.OS !== "android" || !nativeModule) {
      return;
    }
    await nativeModule.stop();
  },
  async getPromotionStatus() {
    if (Platform.OS !== "android" || !nativeModule) {
      return fallbackStatus();
    }
    return nativeModule.getPromotionStatus();
  },
  async consumeInitialNotificationAction() {
    if (Platform.OS !== "android" || !nativeModule) {
      return {};
    }
    return nativeModule.consumeInitialNotificationAction();
  },
};

function fallbackStatus(): LiveUpdateStatus {
  return {
    sdkInt: 0,
    progressStyleSupported: false,
    canPostPromotedNotifications: false,
    notificationPermissionGranted: false,
    suppressedByDismissal: false,
  };
}
