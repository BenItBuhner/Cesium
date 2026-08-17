import { NativeModules, Platform } from "react-native";
import {
  DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES,
  type LiveUpdateAlertPreferences,
  type LiveUpdatePayload,
  type LiveUpdateStatus,
} from "../services/liveUpdateTypes";

type CesiumLiveUpdatesModule = {
  startOrUpdate(payload: LiveUpdatePayload): Promise<LiveUpdateStatus>;
  stopRun(runKey: string): Promise<void>;
  stop(): Promise<void>;
  getPromotionStatus(): Promise<LiveUpdateStatus>;
  getDeliveryPreference(): Promise<LiveUpdateStatus["deliveryPreference"]>;
  setDeliveryPreference(
    preference: LiveUpdateStatus["deliveryPreference"]
  ): Promise<LiveUpdateStatus>;
  setAlertPreferences(
    preferences: LiveUpdateAlertPreferences
  ): Promise<LiveUpdateStatus>;
  /** Run keys persisted natively as ongoing (restorable) runs. */
  getActiveRunKeys(): Promise<string[]>;
  openPromotionSettings(): Promise<boolean>;
  /** Resolves with the settings surface that opened, or null. */
  openNowBarSettings(): Promise<"nowbar" | "appNotificationSettings" | null>;
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
  async setAlertPreferences(preferences) {
    if (Platform.OS !== "android" || !nativeModule) {
      return { ...fallbackStatus(), alertPreferences: preferences };
    }
    // Older native builds predate configurable alerts; treat as best effort.
    if (typeof nativeModule.setAlertPreferences !== "function") {
      return { ...fallbackStatus(), alertPreferences: preferences };
    }
    return nativeModule.setAlertPreferences(preferences);
  },
  async getActiveRunKeys() {
    if (Platform.OS !== "android" || !nativeModule) {
      return [];
    }
    // Older native builds predate stale-run reconciliation; treat as best effort.
    if (typeof nativeModule.getActiveRunKeys !== "function") {
      return [];
    }
    return nativeModule.getActiveRunKeys();
  },
  async openPromotionSettings() {
    if (Platform.OS !== "android" || !nativeModule) {
      return false;
    }
    return nativeModule.openPromotionSettings();
  },
  async openNowBarSettings() {
    if (Platform.OS !== "android" || !nativeModule) {
      return null;
    }
    // Older native builds predate the Now Bar deep link; treat as best effort.
    if (typeof nativeModule.openNowBarSettings !== "function") {
      return null;
    }
    return nativeModule.openNowBarSettings();
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
    alertPreferences: DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES,
  };
}
