import { NativeModules, Platform } from "react-native";
import type { LiveUpdatePayload, LiveUpdateStatus } from "../services/liveUpdateTypes";

type CesiumLiveUpdatesModule = {
  startOrUpdate(payload: LiveUpdatePayload): Promise<LiveUpdateStatus>;
  stopRun(runKey: string): Promise<void>;
  stop(): Promise<void>;
  getPromotionStatus(): Promise<LiveUpdateStatus>;
  getDeliveryPreference(): Promise<LiveUpdateStatus["deliveryPreference"]>;
  setDeliveryPreference(
    preference: LiveUpdateStatus["deliveryPreference"]
  ): Promise<LiveUpdateStatus>;
  openPromotionSettings(): Promise<boolean>;
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
  async stopRun(runKey) {
    if (Platform.OS !== "android" || !nativeModule) {
      return;
    }
    // Older native builds predate per-run teardown; treat as best effort.
    if (typeof nativeModule.stopRun !== "function") {
      return;
    }
    await nativeModule.stopRun(runKey);
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
  async getDeliveryPreference() {
    if (Platform.OS !== "android" || !nativeModule) {
      return "live";
    }
    return nativeModule.getDeliveryPreference();
  },
  async setDeliveryPreference(preference) {
    if (Platform.OS !== "android" || !nativeModule) {
      return { ...fallbackStatus(), deliveryPreference: preference };
    }
    return nativeModule.setDeliveryPreference(preference);
  },
  async openPromotionSettings() {
    if (Platform.OS !== "android" || !nativeModule) {
      return false;
    }
    return nativeModule.openPromotionSettings();
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
    deliveryPreference: "live",
  };
}
