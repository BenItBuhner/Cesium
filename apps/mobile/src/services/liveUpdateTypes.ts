export type LiveUpdatePayload = {
  runKey: string;
  title: string;
  body: string;
  shortText?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  startedAt?: number | null;
  /**
   * Estimated completion timestamp, present only when the eta display
   * preference allows it for this run kind. Informational: the native chip
   * never renders a countdown; the estimate surfaces as body text.
   */
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

/**
 * Which runs may surface a time estimate (a "~Nm left" body hint — the
 * status chip never counts down):
 * "goal"   — goal runs only. Goals are long-horizon, so an estimate carries
 *            real signal; todo plans are short and per-task complexity makes
 *            their extrapolated estimates useless noise. Todo runs show the
 *            todo progression instead.
 * "always" — every run with an estimate, todo plans included.
 * "off"    — never; all runs show progression and elapsed time only.
 */
export type LiveUpdateEtaMode = "goal" | "always" | "off";

/**
 * How concurrent agent runs present:
 * "separate" — one live notification per run.
 * "combined" — a single aggregated live notification whenever two or more
 *              runs are active (a lone run keeps its full detail view).
 */
export type LiveUpdateMultiAgentMode = "separate" | "combined";

export type LiveUpdateDisplayPreferences = {
  eta: LiveUpdateEtaMode;
  multiAgent: LiveUpdateMultiAgentMode;
};

export const DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES: LiveUpdateDisplayPreferences = {
  eta: "goal",
  multiAgent: "separate",
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
