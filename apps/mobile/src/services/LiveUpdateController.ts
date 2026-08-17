import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import { getLiveUpdateRunKey, toLiveUpdatePayload } from "./liveUpdateProjection";
import {
  DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES,
  type LiveUpdateAlertMode,
  type LiveUpdateAlertPreferences,
  type LiveUpdatePayload,
  type LiveUpdateStatus,
} from "./liveUpdateTypes";

export { getLiveUpdateRunKey, toLiveUpdatePayload } from "./liveUpdateProjection";

export type LiveUpdatesNative = {
  startOrUpdate(payload: LiveUpdatePayload): Promise<LiveUpdateStatus>;
  stopRun(runKey: string): Promise<void>;
  stop(): Promise<void>;
  getPromotionStatus(): Promise<LiveUpdateStatus>;
  /** Run keys persisted natively as ongoing; [] on older native builds. */
  getActiveRunKeys?(): Promise<string[]>;
};

type TrackedRun = {
  runKey: string;
  signature: string;
  projection: MobileAgentProjection;
  startedAt: number | null;
};

/**
 * How long a web-bridge projection sync keeps the native agent socket's
 * projections suppressed. Web syncs are throttled to 500ms, so anything
 * this stale means the WebView is frozen or gone and the socket must own
 * the notifications.
 */
export const WEB_SYNC_FRESH_MS = 10_000;

/** Volatile ETA fields only budge the dedupe signature once per bucket. */
const ETA_SIGNATURE_BUCKET_MS = 60_000;

/**
 * Dedupe signature for a payload. `estimatedCompletionAt` (and its seconds
 * mirror) embed "now" and therefore differ on every derivation tick even
 * when nothing visible changed; posting each tick re-rendered the live
 * notification every 500ms. Bucketing them keeps reposts down to real
 * content changes (progress, body text, alerts) plus at most one repost
 * per minute of ETA drift. The posted payload itself keeps precise values.
 */
export function getLiveUpdateSignature(payload: LiveUpdatePayload): string {
  return JSON.stringify({
    ...payload,
    estimatedCompletionAt:
      payload.estimatedCompletionAt == null
        ? null
        : Math.round(payload.estimatedCompletionAt / ETA_SIGNATURE_BUCKET_MS),
    estimatedRemainingSeconds:
      payload.estimatedRemainingSeconds == null
        ? null
        : Math.round(payload.estimatedRemainingSeconds / 60),
  });
}

/**
 * An update should alert (sound / heads-up) exactly when the agent starts
 * needing the user (permission or question) or a watched run reaches a
 * terminal state. Routine progress updates stay silent.
 */
export function computeLiveUpdateAlert(
  previous: MobileAgentProjection | null,
  next: MobileAgentProjection
): boolean {
  const interventionStarted =
    next.pendingIntervention != null &&
    (previous == null || previous.pendingIntervention == null);
  if (isMobileAgentRunActive(next.status)) {
    return interventionStarted;
  }
  const watchedWhileRunning =
    previous != null && isMobileAgentRunActive(previous.status);
  return watchedWhileRunning || interventionStarted;
}

function isAlertAllowed(mode: LiveUpdateAlertMode, appActive: boolean): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "background") {
    return !appActive;
  }
  return true;
}

/**
 * Tracks the live notification of every active agent run, keyed by
 * conversation. Each conversation's current run maps onto its own native
 * notification; terminal updates post one final (alerting, dismissible)
 * notification and drop the run from tracking.
 *
 * Alert behavior is user-configurable per category (completion /
 * needs-input) and respects the app's foreground state: by default an agent
 * completing while the user is inside the app posts no notification at all.
 */
export class LiveUpdateController {
  private runs = new Map<string, TrackedRun>();
  private status: LiveUpdateStatus | null = null;
  private appActive = true;
  private alertPreferences: LiveUpdateAlertPreferences =
    DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES;
  private lastWebSyncAt = 0;

  constructor(
    private readonly native: LiveUpdatesNative,
    private readonly now: () => number = Date.now
  ) {}

  setAppActive(active: boolean) {
    this.appActive = active;
  }

  setAlertPreferences(preferences: LiveUpdateAlertPreferences | null | undefined) {
    if (!preferences) {
      return;
    }
    this.alertPreferences = preferences;
  }

  getAlertPreferences(): LiveUpdateAlertPreferences {
    return this.alertPreferences;
  }

  async update(projection: MobileAgentProjection | null) {
    if (!projection) {
      return;
    }
    const conversationId = projection.conversationId;
    const tracked = this.runs.get(conversationId) ?? null;
    // Run identity is STICKY while a conversation is tracked. The web bridge
    // and the native agent socket derive `startedAt` from different event
    // windows (the socket only sees a head snapshot), so they routinely
    // disagree on the derived run key for the very same run. Honoring every
    // derived key cancelled + reposted the notification (a new notification
    // id is hashed from the key) each time the sources alternated — a rapid
    // visible close/reopen loop. The first tracked key owns the notification
    // until the run leaves tracking through a terminal update; a genuinely
    // new run then starts fresh with its own key.
    const runKey = tracked?.runKey ?? getLiveUpdateRunKey(projection);

    const active = isMobileAgentRunActive(projection.status);
    if (!active && !tracked) {
      // A run we never watched finished in the past — do not resurrect it as
      // a stale notification.
      return;
    }

    // Pin the chronometer anchor: the earliest known start of the run is the
    // most accurate (later values are `updatedAt` fallbacks from sources with
    // truncated event windows). Without this the elapsed timer jumps whenever
    // the update source changes.
    const startedAt =
      tracked?.startedAt != null && projection.startedAt != null
        ? Math.min(tracked.startedAt, projection.startedAt)
        : tracked?.startedAt ?? projection.startedAt ?? null;

    const payload = toLiveUpdatePayload(projection);
    payload.runKey = runKey;
    payload.startedAt = startedAt;
    let alert = computeLiveUpdateAlert(tracked?.projection ?? null, projection);
    if (!active && alert) {
      // Terminal notification. Honor the completion preference: when it must
      // not surface (user is inside the app, or completions are disabled),
      // remove the run's ongoing notification instead of posting a final one.
      if (!isAlertAllowed(this.alertPreferences.completion, this.appActive)) {
        this.runs.delete(conversationId);
        if (tracked) {
          await this.native.stopRun(tracked.runKey).catch(() => undefined);
        }
        return;
      }
    } else if (alert) {
      // Needs-input alert on a still-active run: gating only silences the
      // alert; the ongoing notification itself must stay current.
      alert = isAlertAllowed(this.alertPreferences.intervention, this.appActive);
    }
    payload.alert = alert;
    const signature = getLiveUpdateSignature(payload);
    if (tracked?.signature !== signature) {
      this.status = await this.native.startOrUpdate(payload);
    }
    if (active) {
      this.runs.set(conversationId, { runKey, signature, projection, startedAt });
    } else {
      // The final notification stays visible for the user; only internal
      // tracking ends here.
      this.runs.delete(conversationId);
    }
  }

  /**
   * Reconciles the full set of tracked agents (foreground web sync). Runs
   * missing from the list no longer exist and lose their notifications —
   * including natively persisted ongoing notifications left behind by a
   * previous app process (restored by the foreground service), which this
   * controller instance never tracked.
   */
  async updateAll(projections: MobileAgentProjection[]) {
    this.lastWebSyncAt = this.now();
    const seen = new Set<string>();
    for (const projection of projections) {
      if (!projection?.conversationId) continue;
      seen.add(projection.conversationId);
      await this.update(projection);
    }
    for (const [conversationId, tracked] of [...this.runs]) {
      if (seen.has(conversationId)) continue;
      this.runs.delete(conversationId);
      await this.native.stopRun(tracked.runKey).catch(() => undefined);
    }
    await this.reconcileNativeRuns();
  }

  /**
   * Projection updates from the native agent socket. While the web bridge is
   * actively syncing full projection sets, the web layer is the single source
   * of truth: socket projections are derived from a much smaller event window
   * and would fight the web's over content and identity — the exact ping-pong
   * that made notifications flicker. The socket takes over automatically once
   * web syncs go quiet (WebView frozen or process gone).
   */
  async updateFromSocket(projection: MobileAgentProjection | null) {
    if (
      this.lastWebSyncAt > 0 &&
      this.now() - this.lastWebSyncAt < WEB_SYNC_FRESH_MS
    ) {
      return;
    }
    await this.update(projection);
  }

  /**
   * Cancels natively persisted ongoing runs this controller does not track.
   * The projection set is authoritative for what is actually running, so any
   * other stored run is a stale leftover whose chronometer would otherwise
   * tick forever.
   */
  private async reconcileNativeRuns() {
    if (typeof this.native.getActiveRunKeys !== "function") {
      return;
    }
    const nativeRunKeys = await this.native.getActiveRunKeys().catch(() => []);
    if (nativeRunKeys.length === 0) {
      return;
    }
    const expected = new Set([...this.runs.values()].map((run) => run.runKey));
    for (const runKey of nativeRunKeys) {
      if (expected.has(runKey)) continue;
      await this.native.stopRun(runKey).catch(() => undefined);
    }
  }

  async removeConversation(conversationId: string) {
    const tracked = this.runs.get(conversationId);
    if (!tracked) {
      return;
    }
    this.runs.delete(conversationId);
    await this.native.stopRun(tracked.runKey).catch(() => undefined);
  }

  async refreshStatus() {
    this.status = await this.native.getPromotionStatus();
    if (this.status?.alertPreferences) {
      this.alertPreferences = this.status.alertPreferences;
    }
    return this.status;
  }

  getStatus() {
    return this.status;
  }

  getTrackedConversationIds() {
    return [...this.runs.keys()];
  }

  async stop() {
    this.runs.clear();
    await this.native.stop();
  }
}
