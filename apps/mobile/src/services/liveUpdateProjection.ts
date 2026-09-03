import {
  getMobileNotificationChip,
  isMobileAgentRunActive,
  sanitizeMobileActivityText,
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
   * estimates extrapolate wildly across tasks of uneven complexity - those
   * runs show their todo progression instead. The estimate surfaces as a
   * "~Nm left" body hint only; the status chip never counts down.
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
  // Quick-action identifiers ride along only while the run is actually
  // blocked: a terminal notification must never offer Allow/Reply buttons
  // for a request that no longer exists.
  const interventionIds =
    active && projection.pendingIntervention != null
      ? {
          permissionRequestId: projection.pendingPermissionRequestId ?? null,
          permissionAllowOptionId: projection.pendingPermissionAllowOptionId ?? null,
          permissionDenyOptionId: projection.pendingPermissionDenyOptionId ?? null,
          questionId: projection.pendingQuestionId ?? null,
        }
      : {};
  if (!active) {
    // Terminal notifications state the outcome plainly. currentActivity is
    // stale once the run ends (it can even be a raw tool-call payload like
    // the last todo replace), so it never belongs in the final body; the
    // one exception is the actual error text for failed runs - collapsed to
    // one clean line, and dropped entirely when it is a raw payload dump.
    const failedBody =
      projection.status === "failed"
        ? sanitizeMobileActivityText(projection.lastError)
        : null;
    const body = failedBody ?? terminalLabel(projection.status);
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body,
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

  // Important run states (needs input / review) outrank routine progress
  // text in the status chip so the user sees "INPUT" instead of "3/7" the
  // moment an agent is waiting on them.
  const statusChip =
    projection.pendingIntervention == null
      ? null
      : getMobileNotificationChip(projection.status);

  // While the run is blocked on the user, currentActivity carries the actual
  // question / permission text - that outranks routine progress headlines in
  // the body for the same reason the chip flips to INPUT. No "~Nm left"
  // suffix either: the clock is not running while the agent waits.
  const interventionBody =
    projection.pendingIntervention != null && projection.currentActivity
      ? projection.currentActivity
      : null;

  const goal = projection.goalProgress;
  if (goal) {
    // Goals are long-running; their ETA carries signal (unless disabled).
    // It is a soft "~Nm left" hint in the body text, never a countdown chip.
    const includeEta = etaMode !== "off";
    const remaining = includeEta
      ? formatRemainingTime(goal.estimatedRemainingMs)
      : null;
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body:
        interventionBody ??
        withRemainingTime(
          goal.headline || projection.currentActivity || "Goal is running",
          remaining
        ),
      shortText: statusChip ?? `${goal.percent}%`,
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
      ...interventionIds,
      ongoing: true,
      cancellable: true,
      promote: true,
    };
  }

  const todo = projection.todoProgress;
  if (todo) {
    const progressLabel = `${todo.completed}/${todo.total}`;
    // Todo estimates extrapolate across tasks of wildly uneven complexity -
    // by default the notification shows the todo progression, not an ETA.
    // The chip shows the completed/total fraction and the chronometer
    // counts up; opting in to etaMode "always" adds a "~Nm left" body hint.
    const includeEta = etaMode === "always";
    const remaining = includeEta
      ? formatRemainingTime(todo.estimatedRemainingMs)
      : null;
    return {
      runKey,
      title: projection.title || "Cesium agent",
      body:
        interventionBody ??
        withRemainingTime(
          projection.currentActivity ||
            `Task ${todo.currentIndex ?? todo.completed + 1} of ${todo.total}`,
          remaining
        ),
      shortText: statusChip ?? progressLabel,
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
      ...interventionIds,
      ongoing: true,
      cancellable: true,
      promote: true,
    };
  }

  return {
    runKey,
    title: projection.title || "Cesium agent",
    body: projection.currentActivity || "Agent is working",
    shortText: statusChip,
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    startedAt: projection.startedAt,
    progressKind: "indeterminate",
    progressLabel: null,
    progress: 0,
    progressMax: 100,
    indeterminate: true,
    intervention: projection.pendingIntervention,
    ...interventionIds,
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
