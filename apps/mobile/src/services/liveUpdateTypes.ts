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

export type LiveUpdateStatus = {
  sdkInt: number;
  progressStyleSupported: boolean;
  canPostPromotedNotifications: boolean;
  notificationPermissionGranted: boolean;
  suppressedByDismissal: boolean;
  deliveryPreference: LiveUpdateDeliveryPreference;
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
