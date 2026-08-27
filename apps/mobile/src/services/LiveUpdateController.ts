import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import { getLiveUpdateRunKey, toLiveUpdatePayload } from "./liveUpdateProjection";
import {
  DEFAULT_LIVE_UPDATE_ALERT_PREFERENCES,
  DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES,
  type LiveUpdateAlertMode,
  type LiveUpdateAlertPreferences,
  type LiveUpdateDisplayPreferences,
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
  /** This run currently owns its own posted notification. */
  postedIndividually: boolean;
  /** An allowed alert is waiting to ride out with the next posted payload. */
  pendingAlert: boolean;
};

/** Run key of the single aggregated notification in "combined" mode. */
export const COMBINED_RUN_KEY = "cesium-agents-combined";

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
  private displayPreferences: LiveUpdateDisplayPreferences =
    DEFAULT_LIVE_UPDATE_DISPLAY_PREFERENCES;
  private lastWebSyncAt = 0;
  private combinedPosted = false;
  private combinedSignature = "";

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
    // disagree on the derived run key for the very same run. Honoring every
    // derived key cancelled + reposted the notification (a new notification
    // id is hashed from the key) each time the sources alternated - a rapid
    // visible close/reopen loop. The first tracked key owns the notification
    // until the run leaves tracking through a terminal update; a genuinely
    // new run then starts fresh with its own key.
    const runKey = tracked?.runKey ?? getLiveUpdateRunKey(projection);

    const active = isMobileAgentRunActive(projection.status);
    if (!active && !tracked) {
      // A run we never watched finished in the past - do not resurrect it as
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

    const alert = computeLiveUpdateAlert(tracked?.projection ?? null, projection);

    if (!active) {
      // Terminal update: the run leaves tracking; its final notification
      // posts under the same sticky key so it replaces the ongoing one.
      this.runs.delete(conversationId);
      if (alert && !isAlertAllowed(this.alertPreferences.completion, this.appActive)) {
        // Honor the completion preference: when it must not surface (user is
        // inside the app, or completions are disabled), remove the run's
        // ongoing notification instead of posting a final one.
        if (tracked) {
          await this.native.stopRun(runKey).catch(() => undefined);
        }
      } else {
        const payload = this.buildRunPayload(projection, runKey, startedAt);
        payload.alert = alert;
        const signature = getLiveUpdateSignature(payload);
        if (tracked?.signature !== signature) {
          this.status = await this.native.startOrUpdate(payload);
        }
      }
      await this.syncPresentation();
      return;
    }

    // Needs-input alert on a still-active run: gating only silences the
    // alert; the ongoing notification itself must stay current.
    const allowedAlert =
      alert && isAlertAllowed(this.alertPreferences.intervention, this.appActive);
    this.runs.set(conversationId, {
      runKey,
      signature: tracked?.signature ?? "",
      projection,
      startedAt,
      postedIndividually: tracked?.postedIndividually ?? false,
      pendingAlert: (tracked?.pendingAlert ?? false) || allowedAlert,
    });
    await this.syncPresentation();
  }

  /**
   * Projects the tracked run set onto native notifications according to the
   * multi-agent display preference: one notification per run, or a single
   * aggregated notification while two or more runs are active (a lone run
   * keeps its full per-run detail).
   */
  private async syncPresentation() {
    const runs = [...this.runs.values()];
    const combineActive =
      this.displayPreferences.multiAgent === "combined" && runs.length >= 2;

    if (!combineActive) {
      if (this.combinedPosted) {
        this.combinedPosted = false;
        this.combinedSignature = "";
        await this.native.stopRun(COMBINED_RUN_KEY).catch(() => undefined);
      }
      for (const run of runs) {
        const payload = this.buildRunPayload(run.projection, run.runKey, run.startedAt);
        payload.alert = run.pendingAlert;
        run.pendingAlert = false;
        const signature = getLiveUpdateSignature(payload);
        if (run.signature === signature) continue;
        run.signature = signature;
        run.postedIndividually = true;
        this.status = await this.native.startOrUpdate(payload);
      }
      return;
    }

    // Fold per-run notifications into the single aggregated one.
    for (const run of runs) {
      if (!run.postedIndividually) continue;
      run.postedIndividually = false;
      run.signature = "";
      await this.native.stopRun(run.runKey).catch(() => undefined);
    }
    const payload = this.buildCombinedPayload(runs);
    payload.alert = runs.some((run) => run.pendingAlert);
    for (const run of runs) {
      run.pendingAlert = false;
    }
    const signature = getLiveUpdateSignature(payload);
    if (this.combinedPosted && signature === this.combinedSignature) {
      return;
    }
    this.combinedPosted = true;
    this.combinedSignature = signature;
    this.status = await this.native.startOrUpdate(payload);
  }

  private buildRunPayload(
    projection: MobileAgentProjection,
    runKey: string,
    startedAt: number | null
  ): LiveUpdatePayload {
    const payload = toLiveUpdatePayload(projection, {
      etaMode: this.displayPreferences.eta,
    });
    payload.runKey = runKey;
    payload.startedAt = startedAt;
    return payload;
  }

  /**
   * One notification summarizing every active run: aggregate todo progression
   * when all runs expose one (never a time estimate - cross-run ETAs are pure
   * noise), earliest start as the elapsed anchor, and needs-input surfaced
   * with the single blocked run's conversation wired to the actions when
   * unambiguous.
   */
  private buildCombinedPayload(runs: TrackedRun[]): LiveUpdatePayload {
    const projections = runs.map((run) => run.projection);
    const interventions = projections.filter((p) => p.pendingIntervention != null);
    const aggregate = projections.every((p) => p.todoProgress != null)
      ? {
          completed: projections.reduce(
            (sum, p) => sum + (p.todoProgress?.completed ?? 0),
            0
          ),
          total: projections.reduce((sum, p) => sum + (p.todoProgress?.total ?? 0), 0),
        }
      : null;
    const startedAts = runs
      .map((run) => run.startedAt)
      .filter((value): value is number => value != null);
    const parts = projections.slice(0, 3).map((p) => {
      const title = p.title || "Agent";
      const todo = p.todoProgress;
      return todo ? `${title} ${todo.completed}/${todo.total}` : title;
    });
    if (projections.length > 3) {
      parts.push(`+${projections.length - 3} more`);
    }
    const summary = parts.join(" · ");
    const focus = interventions.length === 1 ? interventions[0] ?? null : null;
    const progressLabel = aggregate
      ? `${aggregate.completed}/${aggregate.total}`
      : null;
    return {
      runKey: COMBINED_RUN_KEY,
      title: `${projections.length} agents running`,
      body:
        interventions.length > 0
          ? `${
              interventions.length === 1
                ? "1 agent needs input"
                : `${interventions.length} agents need input`
            } · ${summary}`
          : summary,
      shortText: progressLabel ?? `${projections.length}`,
      workspaceId: focus?.workspaceId ?? null,
      conversationId: focus?.conversationId ?? null,
      startedAt: startedAts.length > 0 ? Math.min(...startedAts) : null,
      progressKind: aggregate ? "todo" : "indeterminate",
      progressLabel,
      progress: aggregate?.completed ?? 0,
      progressMax: aggregate?.total ?? 100,
      indeterminate: aggregate == null,
      todoCompleted: aggregate?.completed,
      todoTotal: aggregate?.total,
      intervention:
        focus?.pendingIntervention ??
        interventions[0]?.pendingIntervention ??
        null,
      ongoing: true,
      cancellable: false,
      promote: true,
    };
  }

  /**
   * Reconciles the full set of tracked agents (foreground web sync). Runs
   * missing from the list no longer exist and lose their notifications -
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
    let removed = false;
    for (const [conversationId, tracked] of [...this.runs]) {
      if (seen.has(conversationId)) continue;
      this.runs.delete(conversationId);
      removed = true;
      await this.native.stopRun(tracked.runKey).catch(() => undefined);
    }
    if (removed) {
      await this.syncPresentation();
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
    if (this.combinedPosted) {
      expected.add(COMBINED_RUN_KEY);
    }
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
    await this.syncPresentation();
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

  async stop() {
    this.runs.clear();
    this.combinedPosted = false;
    this.combinedSignature = "";
    await this.native.stop();
  }
}
