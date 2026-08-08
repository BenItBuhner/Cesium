import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import { getLiveUpdateRunKey, toLiveUpdatePayload } from "./liveUpdateProjection";
import type { LiveUpdatePayload, LiveUpdateStatus } from "./liveUpdateTypes";

export { getLiveUpdateRunKey, toLiveUpdatePayload } from "./liveUpdateProjection";

export type LiveUpdatesNative = {
  startOrUpdate(payload: LiveUpdatePayload): Promise<LiveUpdateStatus>;
  stopRun(runKey: string): Promise<void>;
  stop(): Promise<void>;
  getPromotionStatus(): Promise<LiveUpdateStatus>;
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

/**
 * Tracks the live notification of every active agent run, keyed by
 * conversation. Each conversation's current run maps onto its own native
 * notification; terminal updates post one final (alerting, dismissible)
 * notification and drop the run from tracking.
 */
export class LiveUpdateController {
  private runs = new Map<string, TrackedRun>();
  private status: LiveUpdateStatus | null = null;

  constructor(private readonly native: LiveUpdatesNative) {}

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
    payload.alert = computeLiveUpdateAlert(tracked?.projection ?? null, projection);
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
   * missing from the list no longer exist and lose their notifications.
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
