import {
  formatMobileEditStats,
  getMobileAgentPhaseLabel,
  getMobileNotificationChip,
  isMobileAgentRunActive,
  sanitizeMobileActivityText,
  type MobileAgentProjection,
} from "@cesium/core";
import type { LiveUpdateEtaMode, LiveUpdatePayload } from "./liveUpdateTypes";

/**
 * Stable identity for a single agent run: one conversation can host many
 * runs over time, and each finished run owns its own completion notification.
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
   * "~Nm left" hint in the progress line only; the status chip never counts
   * down.
   */
  etaMode?: LiveUpdateEtaMode;
  /**
   * Pinned start of the run (the controller keeps the earliest known start
   * across projection sources). Anchors the chronometer and the runtime of
   * the completion card; falls back to the projection's own start.
   */
  startedAt?: number | null;
};

/** Agents listed by the consolidated notification before it folds into "+N more". */
export const MAX_GROUP_LINES = 6;
/** Titles in the agent list are clipped so a line stays a line. */
const GROUP_TITLE_MAX = 36;

/**
 * Payload for a single run: the verbose live notification while it runs
 * (activity, progress, diffstat as separate lines) or the completion card
 * once it ended (diffstat, outcome with runtime and the reply excerpt).
 */
export function toLiveUpdatePayload(
  projection: MobileAgentProjection,
  options: LiveUpdatePayloadOptions = {}
): LiveUpdatePayload {
  const etaMode = options.etaMode ?? "goal";
  const startedAt = options.startedAt ?? projection.startedAt ?? null;
  const active = isMobileAgentRunActive(projection.status);
  const runKey = getLiveUpdateRunKey(projection);
  const title = projection.title || "Cesium agent";
  const editStatsLine = formatMobileEditStats(projection.editStats);

  if (!active) {
    return buildTerminalPayload(projection, runKey, title, startedAt, editStatsLine);
  }

  // Quick-action identifiers ride along only while the run is actually
  // blocked: a terminal notification must never offer Allow/Reply buttons
  // for a request that no longer exists.
  const interventionIds =
    projection.pendingIntervention != null
      ? {
          permissionRequestId: projection.pendingPermissionRequestId ?? null,
          permissionAllowOptionId: projection.pendingPermissionAllowOptionId ?? null,
          permissionDenyOptionId: projection.pendingPermissionDenyOptionId ?? null,
          questionId: projection.pendingQuestionId ?? null,
        }
      : {};

  // While the run is blocked on the user, currentActivity carries the actual
  // question / permission text - that owns the first line for the same reason
  // the chip flips to INPUT.
  const activityLine =
    projection.currentActivity ||
    projection.goalProgress?.headline ||
    (projection.goalProgress ? "Goal is running" : "Agent is working");
  const progressLine = describeProgress(projection, etaMode, activityLine);
  const lines = [activityLine, progressLine, editStatsLine].filter(
    (line): line is string => line != null && line.length > 0
  );
  const bar = progressBar(projection);

  return {
    runKey,
    title,
    body: activityLine,
    expandedBody: lines.join("\n"),
    // Important run states (needs input) outrank routine progress text in the
    // status chip so the user sees "INPUT" instead of "3/7" the moment an
    // agent is waiting on them.
    shortText:
      projection.pendingIntervention != null
        ? getMobileNotificationChip(projection.status)
        : progressChip(projection),
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    startedAt,
    ...bar,
    intervention: projection.pendingIntervention,
    ...interventionIds,
    ongoing: true,
    cancellable: true,
    promote: true,
  };
}

export type LiveUpdateGroupRun = {
  projection: MobileAgentProjection;
  /** Pinned start (see `LiveUpdatePayloadOptions.startedAt`). */
  startedAt?: number | null;
};

/**
 * The consolidated notification for several concurrent runs: "N agents
 * running" with one "• Title · Phase" line per agent (blocked agents first),
 * a collapsed roll-up of phases, the earliest start as the elapsed anchor,
 * and needs-input wired to the single blocked run when unambiguous.
 */
export function toLiveUpdateGroupPayload(
  runs: LiveUpdateGroupRun[],
  runKey: string
): LiveUpdatePayload {
  const ordered = [...runs].sort(compareGroupRuns);
  const projections = ordered.map((run) => run.projection);
  const interventions = projections.filter((p) => p.pendingIntervention != null);
  // Quick-action ids only when exactly one run is blocked - answering "the"
  // permission is ambiguous otherwise.
  const focus = interventions.length === 1 ? interventions[0] ?? null : null;
  const lines = projections
    .slice(0, MAX_GROUP_LINES)
    .map((p) => `• ${clipTitle(p.title || "Agent")} · ${describeGroupRun(p)}`);
  if (projections.length > MAX_GROUP_LINES) {
    lines.push(`• +${projections.length - MAX_GROUP_LINES} more`);
  }
  const startedAts = ordered
    .map((run) => run.startedAt ?? run.projection.startedAt)
    .filter((value): value is number => value != null);
  return {
    runKey,
    title: `${projections.length} agent${projections.length === 1 ? "" : "s"} running`,
    body: summarizeGroupPhases(projections),
    expandedBody: lines.join("\n"),
    // No aggregate progress in the chip: cross-run fractions are noise. The
    // chronometer takes the chip unless someone needs input.
    shortText: interventions.length > 0 ? "INPUT" : null,
    workspaceId: focus?.workspaceId ?? null,
    conversationId: focus?.conversationId ?? null,
    startedAt: startedAts.length > 0 ? Math.min(...startedAts) : null,
    intervention:
      focus?.pendingIntervention ?? interventions[0]?.pendingIntervention ?? null,
    permissionRequestId: focus?.pendingPermissionRequestId ?? null,
    permissionAllowOptionId: focus?.pendingPermissionAllowOptionId ?? null,
    permissionDenyOptionId: focus?.pendingPermissionDenyOptionId ?? null,
    questionId: focus?.pendingQuestionId ?? null,
    ongoing: true,
    cancellable: false,
    promote: true,
  };
}

function compareGroupRuns(a: LiveUpdateGroupRun, b: LiveUpdateGroupRun): number {
  const blockedA = a.projection.pendingIntervention != null ? 0 : 1;
  const blockedB = b.projection.pendingIntervention != null ? 0 : 1;
  if (blockedA !== blockedB) {
    return blockedA - blockedB;
  }
  const startA = a.startedAt ?? a.projection.startedAt ?? Number.MAX_SAFE_INTEGER;
  const startB = b.startedAt ?? b.projection.startedAt ?? Number.MAX_SAFE_INTEGER;
  return startA - startB;
}

/** "Editing · 3/7", "Finishing · 92%", "Needs permission". */
function describeGroupRun(projection: MobileAgentProjection): string {
  const label = getMobileAgentPhaseLabel(projection.phase);
  const chip = progressChip(projection);
  return chip ? `${label} · ${chip}` : label;
}

/**
 * Collapsed roll-up of the group: "1 needs input · 2 editing · 1 starting".
 * Blocked agents lead; the rest are grouped by phase, most common first.
 */
function summarizeGroupPhases(projections: MobileAgentProjection[]): string {
  const blocked = projections.filter((p) => p.pendingIntervention != null).length;
  const counts = new Map<string, number>();
  for (const projection of projections) {
    if (projection.pendingIntervention != null) continue;
    const label = getMobileAgentPhaseLabel(projection.phase);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts: string[] = [];
  if (blocked > 0) {
    parts.push(`${blocked} need${blocked === 1 ? "s" : ""} input`);
  }
  for (const [label, count] of [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    parts.push(`${count} ${label.charAt(0).toLowerCase()}${label.slice(1)}`);
  }
  return parts.join(" · ");
}

function clipTitle(title: string): string {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (collapsed.length <= GROUP_TITLE_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, GROUP_TITLE_MAX - 1).trimEnd()}…`;
}

/** Compact progress text shared by the chip and the agent list: "3/7" or "62%". */
function progressChip(projection: MobileAgentProjection): string | null {
  if (projection.goalProgress) {
    return `${projection.goalProgress.percent}%`;
  }
  if (projection.todoProgress) {
    return `${projection.todoProgress.completed}/${projection.todoProgress.total}`;
  }
  return null;
}

function progressBar(
  projection: MobileAgentProjection
): Pick<LiveUpdatePayload, "progress" | "progressMax"> {
  if (projection.goalProgress) {
    return { progress: projection.goalProgress.percent, progressMax: 100 };
  }
  if (projection.todoProgress) {
    return {
      progress: projection.todoProgress.completed,
      progressMax: projection.todoProgress.total,
    };
  }
  return {};
}

/**
 * Second line of a lone run: "Task 3 of 7 · <todo>" or "Goal 62% · <headline>
 * · ~2m left". The todo / headline text is omitted when the activity line
 * already shows it. No estimate while the agent waits on the user - the
 * clock is not running.
 */
function describeProgress(
  projection: MobileAgentProjection,
  etaMode: LiveUpdateEtaMode,
  activityLine: string
): string | null {
  const blocked = projection.pendingIntervention != null;
  const goal = projection.goalProgress;
  if (goal) {
    const headline =
      goal.headline && goal.headline !== activityLine ? ` · ${goal.headline}` : "";
    const remaining =
      !blocked && etaMode !== "off" ? formatRemainingTime(goal.estimatedRemainingMs) : null;
    return withRemainingTime(`Goal ${goal.percent}%${headline}`, remaining);
  }
  const todo = projection.todoProgress;
  if (todo) {
    const index = todo.currentIndex ?? Math.min(todo.completed + 1, todo.total);
    const label =
      projection.currentTodo && projection.currentTodo !== activityLine
        ? ` · ${projection.currentTodo}`
        : "";
    const remaining =
      !blocked && etaMode === "always" ? formatRemainingTime(todo.estimatedRemainingMs) : null;
    return withRemainingTime(`Task ${index} of ${todo.total}${label}`, remaining);
  }
  return null;
}

function buildTerminalPayload(
  projection: MobileAgentProjection,
  runKey: string,
  title: string,
  startedAt: number | null,
  editStatsLine: string | null
): LiveUpdatePayload {
  const completedAt = projection.completedAt ?? projection.updatedAt;
  const runtime =
    startedAt != null && completedAt > startedAt ? formatRuntime(completedAt - startedAt) : null;
  const outcome = describeOutcome(projection, runtime);
  return {
    runKey,
    title,
    body: outcome,
    expandedBody: [editStatsLine, outcome]
      .filter((line): line is string => line != null && line.length > 0)
      .join("\n"),
    subText: terminalSubText(projection.status),
    shortText: getMobileNotificationChip(projection.status),
    workspaceId: projection.workspaceId,
    conversationId: projection.conversationId,
    startedAt,
    completedAt,
    intervention: null,
    pullRequestUrl: projection.pullRequestUrl ?? null,
    ongoing: false,
    cancellable: false,
    promote: false,
  };
}

/**
 * "Goal complete (runtime 17m 23s). <reply excerpt>" - the outcome sentence
 * of the completion card. Failed runs lead with the error instead of the
 * excerpt; stale in-run activity text never appears here.
 */
function describeOutcome(projection: MobileAgentProjection, runtime: string | null): string {
  const suffix = runtime ? ` (runtime ${runtime})` : "";
  const subject = projection.goalProgress ? "Goal" : "Run";
  let lead: string;
  switch (projection.status) {
    case "completed":
      lead = `${subject} complete${suffix}.`;
      break;
    case "failed":
      lead = `Run failed${suffix}.`;
      break;
    case "cancelled":
      lead = `Run cancelled${suffix}.`;
      break;
    case "interrupted":
      lead = `Run interrupted${suffix}.`;
      break;
    case "paused":
      lead = `Run paused${suffix}.`;
      break;
    default:
      lead = `Run ended${suffix}.`;
      break;
  }
  const detail =
    projection.status === "failed"
      ? // Collapsed to one clean line, dropped entirely when it is a raw payload dump.
        sanitizeMobileActivityText(projection.lastError)
      : projection.summary;
  return detail ? `${lead} ${detail}` : lead;
}

function terminalSubText(status: MobileAgentProjection["status"]): string {
  switch (status) {
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "paused":
      return "Paused";
    default:
      return "Ended";
  }
}

/** "42s", "17m 23s", "1h 02m" - a fixed runtime for the completion card. */
export function formatRuntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
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
