"use client";

/**
 * Desktop (Electron) port of the Android Live Updates controller
 * (`apps/mobile/src/services/LiveUpdateController.ts`).
 *
 * Platform difference that shapes everything here: Android has silent,
 * in-place "ongoing" notifications, so every progress tick re-renders the
 * same chip. Desktop notifications are one-shot banners — posting progress
 * ticks would spam the OS. So on desktop:
 *
 * - Continuous run state renders in the tray menu / tooltip and the dock
 *   badge (synced through `syncAgentRuns`), never as notifications.
 * - OS notifications fire only on alert transitions: an agent starts
 *   needing input, or a watched run reaches a terminal state — gated by
 *   the same completion / intervention alert preferences as Android.
 */

import {
  DEFAULT_MOBILE_NOTIFICATION_ALERT_PREFERENCES,
  DEFAULT_MOBILE_NOTIFICATION_DISPLAY_PREFERENCES,
  type MobileNotificationAlertMode,
  type MobileNotificationAlertPreferences,
  type MobileNotificationDisplayPreferences,
  type MobileNotificationEtaMode,
} from "@/lib/mobile-bridge";
import {
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@/lib/mobile-agent-projection";
import type {
  DesktopAgentRunSummary,
  DesktopNotifyPayload,
} from "@/lib/desktop-native-bridge";

export type DesktopAgentNotificationPreferences = {
  alerts: MobileNotificationAlertPreferences;
  display: MobileNotificationDisplayPreferences;
};

export const DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES: DesktopAgentNotificationPreferences =
  {
    alerts: DEFAULT_MOBILE_NOTIFICATION_ALERT_PREFERENCES,
    display: DEFAULT_MOBILE_NOTIFICATION_DISPLAY_PREFERENCES,
  };

export const DESKTOP_NOTIFICATION_PREFERENCES_STORAGE_KEY =
  "cesium.desktop.notification-preferences";
/** Same-tab change signal so the sync layer picks up settings edits live. */
export const DESKTOP_NOTIFICATION_PREFERENCES_EVENT =
  "cesium:desktop-notification-preferences-changed";

const ALERT_MODES = new Set(["always", "background", "off"]);
const ETA_MODES = new Set(["goal", "always", "off"]);
const MULTI_AGENT_MODES = new Set(["separate", "combined"]);

export function sanitizeDesktopAgentNotificationPreferences(
  raw: unknown
): DesktopAgentNotificationPreferences {
  const defaults = DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const candidate = raw as {
    alerts?: { completion?: unknown; intervention?: unknown };
    display?: { eta?: unknown; multiAgent?: unknown };
  };
  const mode = (value: unknown, fallback: MobileNotificationAlertMode) =>
    typeof value === "string" && ALERT_MODES.has(value)
      ? (value as MobileNotificationAlertMode)
      : fallback;
  return {
    alerts: {
      completion: mode(candidate.alerts?.completion, defaults.alerts.completion),
      intervention: mode(
        candidate.alerts?.intervention,
        defaults.alerts.intervention
      ),
    },
    display: {
      eta:
        typeof candidate.display?.eta === "string" &&
        ETA_MODES.has(candidate.display.eta)
          ? (candidate.display.eta as MobileNotificationDisplayPreferences["eta"])
          : defaults.display.eta,
      multiAgent:
        typeof candidate.display?.multiAgent === "string" &&
        MULTI_AGENT_MODES.has(candidate.display.multiAgent)
          ? (candidate.display
              .multiAgent as MobileNotificationDisplayPreferences["multiAgent"])
          : defaults.display.multiAgent,
    },
  };
}

export function loadDesktopAgentNotificationPreferences(): DesktopAgentNotificationPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(
      DESKTOP_NOTIFICATION_PREFERENCES_STORAGE_KEY
    );
    return sanitizeDesktopAgentNotificationPreferences(
      raw ? JSON.parse(raw) : null
    );
  } catch {
    return DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES;
  }
}

export function saveDesktopAgentNotificationPreferences(
  preferences: DesktopAgentNotificationPreferences
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      DESKTOP_NOTIFICATION_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    );
  } catch {
    // Storage may be unavailable; the in-memory event still updates live state.
  }
  window.dispatchEvent(new Event(DESKTOP_NOTIFICATION_PREFERENCES_EVENT));
}

/** Stable identity for a single run (same derivation as Android). */
export function getDesktopRunKey(projection: MobileAgentProjection): string {
  return `${projection.conversationId}:${projection.startedAt ?? projection.updatedAt}`;
}

/**
 * An update should alert exactly when the agent starts needing the user
 * (permission or question) or a watched run reaches a terminal state —
 * identical semantics to the Android controller.
 */
export function computeDesktopAlert(
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

export function isDesktopAlertAllowed(
  mode: MobileNotificationAlertMode,
  appActive: boolean
): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "background") {
    return !appActive;
  }
  return true;
}

function formatRemainingTime(value: number | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const minutes = Math.ceil(value / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `~${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `~${hours}h`;
  }
  return `~${Math.ceil(hours / 24)}d`;
}

function withRemainingTime(body: string, remaining: string | null): string {
  return remaining ? `${body} · ${remaining} left` : body;
}

function terminalLabel(status: MobileAgentProjection["status"]): string {
  switch (status) {
    case "completed":
      return "Agent run completed";
    case "failed":
      return "Agent run failed";
    case "cancelled":
      return "Agent run cancelled";
    case "interrupted":
      return "Agent run interrupted";
    case "paused":
      return "Agent run paused";
    default:
      return "Agent run ended";
  }
}

/** Tray/tooltip line for one active run, honoring the ETA display preference. */
export function buildDesktopRunSummary(
  projection: MobileAgentProjection,
  runKey: string,
  etaMode: MobileNotificationEtaMode
): DesktopAgentRunSummary {
  const goal = projection.goalProgress;
  const todo = projection.todoProgress;
  let progressLabel: string | null = null;
  let detail = projection.currentActivity || "Agent is working";
  if (goal) {
    progressLabel = `${goal.percent}%`;
    const remaining =
      etaMode !== "off" ? formatRemainingTime(goal.estimatedRemainingMs) : null;
    detail = withRemainingTime(
      goal.headline || projection.currentActivity || "Goal is running",
      remaining
    );
  } else if (todo) {
    progressLabel = `${todo.completed}/${todo.total}`;
    const remaining =
      etaMode === "always" ? formatRemainingTime(todo.estimatedRemainingMs) : null;
    detail = withRemainingTime(
      projection.currentActivity ||
        `Task ${todo.currentIndex ?? todo.completed + 1} of ${todo.total}`,
      remaining
    );
  }
  return {
    runKey,
    conversationId: projection.conversationId,
    workspaceId: projection.workspaceId,
    title: projection.title || "Cesium agent",
    detail,
    progressLabel,
    needsInput: projection.pendingIntervention != null,
    active: isMobileAgentRunActive(projection.status),
  };
}

export function buildDesktopCompletionNotification(
  projection: MobileAgentProjection,
  runKey: string
): DesktopNotifyPayload {
  const body =
    projection.status === "failed" && projection.lastError
      ? projection.lastError
      : terminalLabel(projection.status);
  return {
    runKey,
    title: projection.title || "Cesium agent",
    body,
    kind: "completion",
    silent: false,
    conversationId: projection.conversationId,
    workspaceId: projection.workspaceId,
  };
}

export function buildDesktopInterventionNotification(
  projection: MobileAgentProjection,
  runKey: string
): DesktopNotifyPayload {
  const body =
    projection.pendingIntervention === "permission"
      ? "Needs permission to continue"
      : "Asked you a question";
  return {
    runKey,
    title: projection.title || "Cesium agent",
    body,
    kind: "intervention",
    silent: false,
    conversationId: projection.conversationId,
    workspaceId: projection.workspaceId,
  };
}

/** Aggregated tray entry when the multi-agent preference is "combined". */
export function buildDesktopCombinedRunSummary(
  runs: DesktopAgentRunSummary[]
): DesktopAgentRunSummary {
  const needsInput = runs.filter((run) => run.needsInput);
  const parts = runs.slice(0, 3).map((run) => {
    return run.progressLabel ? `${run.title} ${run.progressLabel}` : run.title;
  });
  if (runs.length > 3) {
    parts.push(`+${runs.length - 3} more`);
  }
  const focus = needsInput.length === 1 ? needsInput[0] ?? null : null;
  return {
    runKey: "cesium-agents-combined",
    conversationId: focus?.conversationId ?? null,
    workspaceId: focus?.workspaceId ?? null,
    title: `${runs.length} agents running`,
    detail:
      needsInput.length > 0
        ? `${
            needsInput.length === 1
              ? "1 agent needs input"
              : `${needsInput.length} agents need input`
          } · ${parts.join(" · ")}`
        : parts.join(" · "),
    progressLabel: null,
    needsInput: needsInput.length > 0,
    active: true,
  };
}

export type DesktopNativeNotificationAdapter = {
  notify(payload: DesktopNotifyPayload): void | Promise<unknown>;
  syncRuns(input: { runs: DesktopAgentRunSummary[] }): void | Promise<unknown>;
};

type TrackedRun = {
  runKey: string;
  projection: MobileAgentProjection;
  /** Suppresses duplicate needs-input notifications for one intervention. */
  notifiedIntervention: boolean;
};

/**
 * Tracks every active agent run and projects it onto the desktop's native
 * surfaces. Reconciliation follows the Android controller: the projection
 * set from the web layer is authoritative — runs missing from it silently
 * stop being tracked, and terminal transitions post at most one final
 * notification under the run's sticky key.
 */
export class DesktopAgentNotificationController {
  private runs = new Map<string, TrackedRun>();
  private appActive = true;
  private preferences: DesktopAgentNotificationPreferences =
    DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES;
  private lastRunsSignature: string | null = null;

  constructor(private readonly adapter: DesktopNativeNotificationAdapter) {}

  setAppActive(active: boolean): void {
    this.appActive = active;
  }

  setPreferences(
    preferences: DesktopAgentNotificationPreferences | null | undefined
  ): void {
    if (!preferences) {
      return;
    }
    this.preferences = preferences;
  }

  getPreferences(): DesktopAgentNotificationPreferences {
    return this.preferences;
  }

  getTrackedConversationIds(): string[] {
    return [...this.runs.keys()];
  }

  updateAll(projections: MobileAgentProjection[]): void {
    const seen = new Set<string>();
    for (const projection of projections) {
      if (!projection?.conversationId) {
        continue;
      }
      seen.add(projection.conversationId);
      this.update(projection);
    }
    for (const conversationId of [...this.runs.keys()]) {
      if (!seen.has(conversationId)) {
        this.runs.delete(conversationId);
      }
    }
    this.syncPresentation();
  }

  private update(projection: MobileAgentProjection): void {
    const conversationId = projection.conversationId;
    const tracked = this.runs.get(conversationId) ?? null;
    // Sticky run identity, same as Android: the first tracked key owns the
    // run until it leaves tracking through a terminal update.
    const runKey = tracked?.runKey ?? getDesktopRunKey(projection);
    const active = isMobileAgentRunActive(projection.status);

    if (!active) {
      if (!tracked) {
        // Finished before we ever watched it — never resurrect stale alerts.
        return;
      }
      this.runs.delete(conversationId);
      const alert = computeDesktopAlert(tracked.projection, projection);
      if (
        alert &&
        isDesktopAlertAllowed(this.preferences.alerts.completion, this.appActive)
      ) {
        void this.adapter.notify(
          buildDesktopCompletionNotification(projection, runKey)
        );
      }
      return;
    }

    const interventionStarted =
      projection.pendingIntervention != null &&
      (tracked == null || tracked.projection.pendingIntervention == null);
    const alreadyNotified =
      tracked?.notifiedIntervention === true &&
      projection.pendingIntervention != null;
    let notifiedIntervention = alreadyNotified;
    if (
      interventionStarted &&
      !alreadyNotified &&
      isDesktopAlertAllowed(this.preferences.alerts.intervention, this.appActive)
    ) {
      void this.adapter.notify(
        buildDesktopInterventionNotification(projection, runKey)
      );
      notifiedIntervention = true;
    }
    if (projection.pendingIntervention == null) {
      notifiedIntervention = false;
    }
    this.runs.set(conversationId, {
      runKey,
      projection,
      notifiedIntervention,
    });
  }

  private syncPresentation(): void {
    const etaMode = this.preferences.display.eta;
    const summaries = [...this.runs.values()].map((run) =>
      buildDesktopRunSummary(run.projection, run.runKey, etaMode)
    );
    const activeSummaries = summaries.filter((summary) => summary.active);
    const runs =
      this.preferences.display.multiAgent === "combined" &&
      activeSummaries.length >= 2
        ? [buildDesktopCombinedRunSummary(activeSummaries)]
        : activeSummaries;
    const signature = JSON.stringify(runs);
    if (signature === this.lastRunsSignature) {
      return;
    }
    this.lastRunsSignature = signature;
    void this.adapter.syncRuns({ runs });
  }
}
