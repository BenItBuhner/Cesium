export type LiveUpdatePayload = {
  runKey: string;
  title: string;
  body: string;
  shortText?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  startedAt?: number | null;
  estimatedCompletionAt?: number | null;
  progressKind: "todo" | "goal" | "indeterminate" | "terminal";
  progressLabel?: string | null;
  progress?: number;
  progressMax?: number;
  indeterminate?: boolean;
  todoCompleted?: number;
  todoTotal?: number;
  todoCurrentIndex?: number | null;
  goalProgressPercent?: number;
  estimatedRemainingSeconds?: number | null;
  intervention?: "permission" | "question" | null;
  ongoing?: boolean;
  cancellable?: boolean;
  promote?: boolean;
  /**
   * True exactly when this update should make noise: an agent started
   * needing input (permission/question) or a run reached a terminal state.
   * Routine progress updates stay silent.
   */
  alert?: boolean;
};

export type LiveUpdateDeliveryPreference = "live" | "basic" | "off";

/**
 * When an alerting update may surface: always, only while the app is in the
 * background, or never. `completion` gates the terminal notification itself
 * (a user looking at the app already watched the agent finish); `intervention`
 * only gates the alert sound/heads-up — the ongoing notification still updates.
 */
export type LiveUpdateAlertMode = "always" | "background" | "off";

export type LiveUpdateAlertPreferences = {
  completion: LiveUpdateAlertMode;
  intervention: LiveUpdateAlertMode;
};

export const DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES: LiveUpdateAlertPreferences = {
  completion: "background",
  intervention: "always",
};

export type LiveUpdateStatus = {
  sdkInt: number;
  progressStyleSupported: boolean;
  canPostPromotedNotifications: boolean;
  notificationPermissionGranted: boolean;
  suppressedByDismissal: boolean;
  deliveryPreference: LiveUpdateDeliveryPreference;
  /** Absent on native builds that predate configurable alert behavior. */
  alertPreferences?: LiveUpdateAlertPreferences;
  /** Device manufacturer is Samsung (Now Bar renders live updates). */
  isSamsung?: boolean;
  /**
   * This Android build actually renders promoted live updates: Android 16
   * QPR1+ (status-bar chip) or Samsung One UI 8 (Now Bar). Base Android 16
   * shipped the APIs without the rendering UI.
   */
  promotionRenderSupported?: boolean;
  /** A representative run notification structurally qualifies for promotion. */
  hasPromotableCharacteristics?: boolean;
  /** A Cesium notification is currently promoted (live update rendering). */
  promotedNotificationPosted?: boolean;
};
