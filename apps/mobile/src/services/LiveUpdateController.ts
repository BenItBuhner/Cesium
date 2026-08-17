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
};

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

  constructor(private readonly native: LiveUpdatesNative) {}

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
    const runKey = getLiveUpdateRunKey(projection);
    let tracked = this.runs.get(conversationId) ?? null;
    if (tracked && tracked.runKey !== runKey) {
      // A new run started in this conversation; retire the previous run's
      // notification so the fresh one replaces it cleanly.
      this.runs.delete(conversationId);
      await this.native.stopRun(tracked.runKey).catch(() => undefined);
      tracked = null;
    }

    const active = isMobileAgentRunActive(projection.status);
    if (!active && !tracked) {
      // A run we never watched finished in the past — do not resurrect it as
      // a stale notification.
      return;
    }

    const payload = toLiveUpdatePayload(projection);
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
    const signature = JSON.stringify(payload);
    if (tracked?.signature !== signature) {
      this.status = await this.native.startOrUpdate(payload);
    }
    if (active) {
      this.runs.set(conversationId, { runKey, signature, projection });
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
