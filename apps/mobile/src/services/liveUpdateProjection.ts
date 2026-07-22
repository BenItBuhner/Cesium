import {
  getMobileNotificationChip,
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@cesium/core";
import type { LiveUpdatePayload } from "./liveUpdateTypes";

export function toLiveUpdatePayload(
  projection: MobileAgentProjection
): LiveUpdatePayload {
  const active = isMobileAgentRunActive(projection.status);
  const runKey = `${projection.conversationId}:${projection.startedAt ?? projection.updatedAt}`;
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

  const burn = projection.goalProgress;
  if (burn) {
    const remaining = formatRemainingTime(burn.estimatedRemainingMs);
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body: withRemainingTime(
        burn.headline || projection.currentActivity || "Goal is running",
        remaining
      ),
      shortText: `${burn.percent}%`,
      workspaceId: projection.workspaceId,
      conversationId: projection.conversationId,
      startedAt: projection.startedAt,
      estimatedCompletionAt: burn.estimatedCompletionAt,
      progressKind: "goal",
      progressLabel: `${burn.percent}%`,
      progress: burn.percent,
      progressMax: 100,
      indeterminate: false,
      goalProgressPercent: burn.percent,
      estimatedRemainingSeconds: toRemainingSeconds(burn.estimatedRemainingMs),
      intervention: projection.pendingIntervention,
      ongoing: true,
      cancellable: true,
      promote: true,
    };
  }

  const todo = projection.todoProgress;
  if (todo) {
    const progressLabel = `${todo.completed}/${todo.total}`;
    const remaining = formatRemainingTime(todo.estimatedRemainingMs);
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
      estimatedCompletionAt: todo.estimatedCompletionAt,
      progressKind: "todo",
      progressLabel,
      progress: todo.completed,
      progressMax: todo.total,
      indeterminate: false,
      todoCompleted: todo.completed,
      todoTotal: todo.total,
      todoCurrentIndex: todo.currentIndex,
      estimatedRemainingSeconds: toRemainingSeconds(todo.estimatedRemainingMs),
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
