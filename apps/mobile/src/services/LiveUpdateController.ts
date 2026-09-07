import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import {
  getLiveUpdateRunKey,
  toLiveUpdateGroupPayload,
  toLiveUpdatePayload,
} from "./liveUpdateProjection";
import {
  DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES,
  DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES,
  type LiveUpdateAlertMode,
  type LiveUpdateAlertPreferences,
  type LiveUpdateDisplayPreferences,
  type LiveUpdatePayload,
  type LiveUpdateStatus,
} from "./liveUpdateTypes";

export {
  getLiveUpdateRunKey,
  toLiveUpdateGroupPayload,
  toLiveUpdatePayload,
} from "./liveUpdateProjection";

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
  projection: MobileAgentProjection;
  startedAt: number | null;
  /** An allowed alert is waiting to ride out with the next posted live payload. */
  pendingAlert: boolean;
};

/**
 * Run-key prefix of the single consolidated live notification. The full key
 * is suffixed with the key of the run that opened the current batch of
 * concurrent agents: one batch keeps one notification identity from its
 * first agent to its last (agents joining or leaving update it in place
 * instead of re-materializing the chip), and the next batch after everything
 * went quiet gets a fresh key, so a swipe-dismissal of the previous one does
 * not silence it.
 */
export const LIVE_RUN_KEY_PREFIX = "cesium-agents-live";

export function getLiveBatchRunKey(firstRunKey: string): string {
  return `${LIVE_RUN_KEY_PREFIX}:${firstRunKey}`;
}

/**
 * How long a web-bridge projection sync keeps the native agent socket's
 * projections suppressed. Web syncs are throttled to 500ms, so anything
 * this stale means the WebView is frozen or gone and the socket must own
 * the notifications.
 */
export const WEB_SYNC_FRESH_MS = 10_000;

/**
 * Dedupe signature for a payload. Every field of the payload is display
 * content (time estimates are already rounded to minutes in the text), so a
 * repost happens exactly when something visible changed.
 */
export function getLiveUpdateSignature(payload: LiveUpdatePayload): string {
  return JSON.stringify(payload);
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
 * Tracks every active agent run (keyed by conversation) and projects the
 * whole set onto ONE consolidated live notification: a lone run shows its
 * full detail (activity, progress, diffstat), two or more list every agent
 * with its phase. Runs that end leave the live notification and post their
 * own dismissible completion card under the run's sticky key.
 *
 * Alert behavior is user-configurable per category (completion /
 * needs-input) and respects the app's foreground state: by default an agent
 * completing while the user is inside the app posts no completion card.
 */
export class LiveUpdateController {
  private runs = new Map<string, TrackedRun>();
  private status: LiveUpdateStatus | null = null;
  private appActive = true;
  private alertPreferences: LiveUpdateAlertPreferences =
    DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES;
  private displayPreferences: LiveUpdateDisplayPreferences =
    DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES;
  private lastWebSyncAt = 0;
  /** Identity and last posted content of the consolidated live notification. */
  private liveRunKey: string | null = null;
  private liveSignature = "";

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

  setDisplayPreferences(
    preferences: LiveUpdateDisplayPreferences | null | undefined
  ) {
    if (!preferences) {
      return;
    }
    this.displayPreferences = preferences;
  }

  getDisplayPreferences(): LiveUpdateDisplayPreferences {
    return this.displayPreferences;
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
    // disagree on the derived run key for the very same run. The first
    // tracked key owns the run (it names the completion card and, for the
    // batch opener, the live notification) until the run leaves tracking
    // through a terminal update; a genuinely new run then starts fresh.
    const runKey = tracked?.runKey ?? getLiveUpdateRunKey(projection);

    const active = isMobileAgentRunActive(projection.status);
    if (!active && !tracked) {
      // A run we never watched finished in the past - do not resurrect it as
      // a stale completion card.
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

    const alert = computeLiveUpdateAlert(tracked?.projection ?? null, projection);

    if (!active) {
      // Terminal update: the run leaves the live notification. Its completion
      // card posts under the run's own key - and only when the completion
      // preference allows it (a user inside the app already watched it end).
      this.runs.delete(conversationId);
      if (alert && isAlertAllowed(this.alertPreferences.completion, this.appActive)) {
        const payload = this.buildRunPayload(projection, runKey, startedAt);
        payload.alert = true;
        this.status = await this.native.startOrUpdate(payload);
      }
      await this.syncLive();
      return;
    }

    // Needs-input alert on a still-active run: gating only silences the
    // alert; the live notification itself must stay current.
    const allowedAlert =
      alert && isAlertAllowed(this.alertPreferences.intervention, this.appActive);
    this.runs.set(conversationId, {
      runKey,
      projection,
      startedAt,
      pendingAlert: (tracked?.pendingAlert ?? false) || allowedAlert,
    });
    await this.syncLive();
  }

  /**
   * Projects the tracked run set onto the consolidated live notification:
   * removed when nothing runs, the lone run's full detail for one agent, the
   * agent list for two or more. Posts only when the visible content changed.
   */
  private async syncLive() {
    const runs = [...this.runs.values()];
    if (runs.length === 0) {
      const retired = this.liveRunKey;
      this.liveRunKey = null;
      this.liveSignature = "";
      if (retired != null) {
        await this.native.stopRun(retired).catch(() => undefined);
      }
      return;
    }
    const first = runs[0];
    if (!first) {
      return;
    }
    const liveRunKey = this.liveRunKey ?? getLiveBatchRunKey(first.runKey);
    const payload =
      runs.length === 1
        ? this.buildRunPayload(first.projection, liveRunKey, first.startedAt)
        : toLiveUpdateGroupPayload(
            runs.map((run) => ({ projection: run.projection, startedAt: run.startedAt })),
            liveRunKey
          );
    payload.alert = runs.some((run) => run.pendingAlert);
    for (const run of runs) {
      run.pendingAlert = false;
    }
    const signature = getLiveUpdateSignature(payload);
    if (this.liveRunKey === liveRunKey && signature === this.liveSignature) {
      return;
    }
    this.liveRunKey = liveRunKey;
    this.liveSignature = signature;
    this.status = await this.native.startOrUpdate(payload);
  }

  private buildRunPayload(
    projection: MobileAgentProjection,
    runKey: string,
    startedAt: number | null
  ): LiveUpdatePayload {
    const payload = toLiveUpdatePayload(projection, {
      etaMode: this.displayPreferences.eta,
      startedAt,
    });
    payload.runKey = runKey;
    return payload;
  }

  /**
   * Reconciles the full set of tracked agents (foreground web sync). Runs
   * missing from the list no longer exist and leave the live notification;
   * natively persisted ongoing notifications this controller does not own
   * (left behind by a previous app process, or per-run notifications from an
   * older app version) are cancelled.
   */
  async updateAll(projections: MobileAgentProjection[]) {
    this.lastWebSyncAt = this.now();
    const seen = new Set<string>();
    for (const projection of projections) {
      if (!projection?.conversationId) continue;
      seen.add(projection.conversationId);
      await this.update(projection);
    }
    let removed = false;
    for (const conversationId of [...this.runs.keys()]) {
      if (seen.has(conversationId)) continue;
      this.runs.delete(conversationId);
      removed = true;
    }
    if (removed) {
      await this.syncLive();
    }
    await this.reconcileNativeRuns();
  }

  /**
   * Projection updates from the native agent socket. While the web bridge is
   * actively syncing full projection sets, the web layer is the single source
   * of truth: socket projections are derived from a much smaller event window
   * and would fight the web's over content and identity - the exact ping-pong
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
   * Cancels natively persisted ongoing notifications other than the live one
   * this controller owns. The projection set is authoritative for what is
   * actually running, so any other stored run is a stale leftover whose
   * chronometer would otherwise tick forever.
   */
  private async reconcileNativeRuns() {
    if (typeof this.native.getActiveRunKeys !== "function") {
      return;
    }
    const nativeRunKeys = await this.native.getActiveRunKeys().catch(() => []);
    for (const runKey of nativeRunKeys) {
      if (runKey === this.liveRunKey) continue;
      await this.native.stopRun(runKey).catch(() => undefined);
    }
  }

  async removeConversation(conversationId: string) {
    if (!this.runs.delete(conversationId)) {
      return;
    }
    await this.syncLive();
  }

  async refreshStatus() {
    this.status = await this.native.getPromotionStatus();
    if (this.status?.alertPreferences) {
      this.alertPreferences = this.status.alertPreferences;
    }
    if (this.status?.displayPreferences) {
      this.displayPreferences = this.status.displayPreferences;
    }
    return this.status;
  }

  getStatus() {
    return this.status;
  }

  getTrackedConversationIds() {
    return [...this.runs.keys()];
  }

  /** Run key of the posted live notification, or null while nothing runs. */
  getLiveRunKey() {
    return this.liveRunKey;
  }

  async stop() {
    this.runs.clear();
    this.liveRunKey = null;
    this.liveSignature = "";
    await this.native.stop();
  }
}
