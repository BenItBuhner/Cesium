import {
  getMobileNotificationChip,
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import type { LiveUpdateEtaMode, LiveUpdatePayload } from "./liveUpdateTypes";

/**
 * Stable identity for a single agent run: one conversation can host many
 * runs over time, and each run owns its own live notification.
 */
export function getLiveUpdateRunKey(projection: MobileAgentProjection): string {
  return `${projection.conversationId}:${projection.startedAt ?? projection.updatedAt}`;
}

export type LiveUpdatePayloadOptions = {
  /**
   * Which progress kinds may carry a time estimate. Defaults to "goal":
   * goal runs are long enough for an ETA to mean something, while todo
   * estimates extrapolate wildly across tasks of uneven complexity — those
   * runs show their todo progression instead.
   */
  etaMode?: LiveUpdateEtaMode;
};

export function toLiveUpdatePayload(
  projection: MobileAgentProjection,
  options: LiveUpdatePayloadOptions = {}
): LiveUpdatePayload {
  const etaMode = options.etaMode ?? "goal";
  const active = isMobileAgentRunActive(projection.status);
  const runKey = getLiveUpdateRunKey(projection);
  if (!active) {
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body: projection.currentActivity || terminalLabel(projection.status),
      shortText: getMobileNotificationChip(projection.status),
      workspaceId: projection.workspaceId,
      conversationId: projection.conversationId,
      startedAt: projection.startedAt,
      progressKind: "terminal",
      progressLabel: getMobileNotificationChip(projection.status),
      progress: projection.status === "completed" ? 100 : 0,
      progressMax: 100,
      indeterminate: false,
      intervention: projection.pendingIntervention,
      ongoing: false,
      cancellable: false,
      promote: false,
    };
  }

  const goal = projection.goalProgress;
  if (goal) {
    // Goals are long-running; their ETA carries signal (unless disabled).
    const includeEta = etaMode !== "off";
    const remaining = includeEta
      ? formatRemainingTime(goal.estimatedRemainingMs)
      : null;
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body: withRemainingTime(
        goal.headline || projection.currentActivity || "Goal is running",
        remaining
      ),
      shortText: `${goal.percent}%`,
      workspaceId: projection.workspaceId,
      conversationId: projection.conversationId,
      startedAt: projection.startedAt,
      estimatedCompletionAt: includeEta ? goal.estimatedCompletionAt : null,
      progressKind: "goal",
      progressLabel: `${goal.percent}%`,
      progress: goal.percent,
      progressMax: 100,
      indeterminate: false,
      goalProgressPercent: goal.percent,
      estimatedRemainingSeconds: includeEta
        ? toRemainingSeconds(goal.estimatedRemainingMs)
        : null,
      intervention: projection.pendingIntervention,
      ongoing: true,
      cancellable: true,
      promote: true,
    };
  }

  const todo = projection.todoProgress;
  if (todo) {
    const progressLabel = `${todo.completed}/${todo.total}`;
    // Todo estimates extrapolate across tasks of wildly uneven complexity —
    // by default the notification shows the todo progression, not an ETA.
    // Without estimatedCompletionAt the native chip falls back to the
    // "completed/total" text plus the elapsed count-up chronometer.
    const includeEta = etaMode === "always";
    const remaining = includeEta
      ? formatRemainingTime(todo.estimatedRemainingMs)
      : null;
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body: withRemainingTime(
        projection.currentActivity || `Task ${todo.currentIndex ?? todo.completed + 1}`,
        remaining
      ),
      shortText: progressLabel,
      workspaceId: projection.workspaceId,
      conversationId: projection.conversationId,
      startedAt: projection.startedAt,
      estimatedCompletionAt: includeEta ? todo.estimatedCompletionAt : null,
      progressKind: "todo",
      progressLabel,
      progress: todo.completed,
      progressMax: todo.total,
      indeterminate: false,
      todoCompleted: todo.completed,
      todoTotal: todo.total,
      todoCurrentIndex: todo.currentIndex,
      estimatedRemainingSeconds: includeEta
        ? toRemainingSeconds(todo.estimatedRemainingMs)
        : null,
      intervention: projection.pendingIntervention,
      ongoing: true,
      cancellable: true,
      promote: true,
    };
  }

  return {
    runKey,
    title: projection.title || "Cesium agent",
    body: projection.currentActivity || "Agent is working",
    shortText:
      projection.pendingIntervention == null
        ? null
        : getMobileNotificationChip(projection.status),
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    startedAt: projection.startedAt,
    progressKind: "indeterminate",
    progressLabel: null,
    progress: 0,
    progressMax: 100,
    indeterminate: true,
    intervention: projection.pendingIntervention,
    ongoing: true,
    cancellable: true,
    promote: true,
  };
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

function toRemainingSeconds(value: number | null): number | null {
  return value == null ? null : Math.max(0, Math.round(value / 1000));
}

function formatRemainingTime(value: number | null): string | null {
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
