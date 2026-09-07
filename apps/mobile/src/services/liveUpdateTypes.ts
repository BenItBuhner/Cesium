export type LiveUpdatePayload = {
  runKey: string;
  title: string;
  /** Collapsed one-line body. */
  body: string;
  /**
   * Expanded body, one line per "\n" (rendered with BigTextStyle, which stays
   * eligible for Android 16 promotion). The consolidated live notification
   * lists every running agent here; a lone run lists its activity, progress,
   * and diffstat; a finished run its diffstat and outcome. Falls back to
   * `body` when absent.
   */
  expandedBody?: string | null;
  /** Header sub text ("Finished", "Failed"); terminal notifications only. */
  subText?: string | null;
  /** Status-bar chip text of a promoted live update ("3/7", "62%", "INPUT"). */
  shortText?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  /** Elapsed-time chronometer anchor while the notification is ongoing. */
  startedAt?: number | null;
  /** Shown as the notification time once the run has ended. */
  completedAt?: number | null;
  /**
   * Determinate progress bar for the pre-Android 16 shade. Both present or
   * neither; the consolidated multi-agent notification never carries one.
   */
  progress?: number | null;
  progressMax?: number | null;
  intervention?: "permission" | "question" | null;
  /**
   * Identifiers for answering the pending intervention straight from the
   * notification (Allow / Deny buttons, inline reply). Only present while the
   * run is blocked on the user; the native layer hides the quick actions when
   * they are missing (e.g. an older web bundle).
   */
  permissionRequestId?: string | null;
  permissionAllowOptionId?: string | null;
  permissionDenyOptionId?: string | null;
  questionId?: string | null;
  /** Target of the "View PR" action on a finished notification. */
  pullRequestUrl?: string | null;
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
 * only gates the alert sound/heads-up - the ongoing notification still updates.
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

/**
 * Which runs may surface a time estimate (a "~Nm left" body hint - the
 * status chip never counts down):
 * "goal"   - goal runs only. Goals are long-horizon, so an estimate carries
 *            real signal; todo plans are short and per-task complexity makes
 *            their extrapolated estimates useless noise. Todo runs show the
 *            todo progression instead.
 * "always" - every run with an estimate, todo plans included.
 * "off"    - never; all runs show progression and elapsed time only.
 */
export type LiveUpdateEtaMode = "goal" | "always" | "off";

export type LiveUpdateDisplayPreferences = {
  eta: LiveUpdateEtaMode;
};

export const DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES: LiveUpdateDisplayPreferences = {
  eta: "goal",
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
  /** Absent on native builds that predate configurable display behavior. */
  displayPreferences?: LiveUpdateDisplayPreferences;
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
