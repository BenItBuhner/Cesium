import type {
  AgentConversationRecord,
  AgentConversationStatus,
  AgentPendingPermission,
  AgentPermissionOption,
  AgentPermissionOptionKind,
  AgentPlanEntry,
  AgentStoredEvent,
  AgentToolEditPreview,
  AgentToolLocation,
} from "./protocol";
import { latestGoalProgressStatus } from "./agent-chat";

export type MobilePendingIntervention = "permission" | "question" | null;

/**
 * Coarse phase of an agent run for compact listings where a full activity
 * line does not fit ("Fix build · Editing"). Derived from the run status,
 * pending intervention, structured progress, and the kind of the most recent
 * activity event; `getMobileAgentPhaseLabel` turns it into display text.
 */
export type MobileAgentPhase =
  | "starting"
  | "thinking"
  | "writing"
  | "editing"
  | "reading"
  | "running"
  | "searching"
  | "browsing"
  | "planning"
  | "delegating"
  | "waiting"
  | "working"
  | "finishing"
  | "needs_permission"
  | "needs_answer"
  | "pausing"
  | "paused"
  | "finished"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "idle";

/** Aggregate of the file edits observed during one agent run. */
export type MobileAgentEditStats = {
  /** Distinct files touched (edit tool calls without a path count once each). */
  files: number;
  additions: number;
  deletions: number;
};

export type MobileTodoProgress = {
  total: number;
  completed: number;
  blocked: number;
  pending: number;
  inProgress: number;
  currentIndex: number | null;
  percent: number;
  estimatedRemainingMs: number | null;
  estimatedCompletionAt: number | null;
};

export type MobileGoalProgress = {
  percent: number;
  headline: string | null;
  runtimeMs: number;
  estimatedRemainingMs: number | null;
  estimatedCompletionAt: number | null;
};

export type MobileAgentProjection = {
  workspaceId: string;
  conversationId: string;
  title: string;
  status: AgentConversationStatus | "completed";
  lastEventSeq: number;
  currentActivity: string;
  currentTodoId: string | null;
  currentTodo: string | null;
  pendingIntervention: MobilePendingIntervention;
  /**
   * Identifiers needed to answer the pending intervention WITHOUT opening the
   * app (notification quick actions, watch shortcuts). The allow/deny option
   * ids are pre-resolved here because the notification layer has no access to
   * the full option list; null when the pending request has no matching kind.
   */
  pendingPermissionRequestId: string | null;
  pendingPermissionAllowOptionId: string | null;
  pendingPermissionDenyOptionId: string | null;
  pendingQuestionId: string | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  elapsedMs: number;
  lastError: string | null;
  todoProgress: MobileTodoProgress | null;
  goalProgress: MobileGoalProgress | null;
  phase: MobileAgentPhase;
  /** File edits seen so far in the current run; null until the first edit lands. */
  editStats: MobileAgentEditStats | null;
  /** One clean line excerpted from the agent's final reply. Terminal runs only. */
  summary: string | null;
  /** Pull request the run reported (final reply or tool output). Terminal runs only. */
  pullRequestUrl: string | null;
};

export function isMobileAgentRunActive(status: MobileAgentProjection["status"]): boolean {
  return (
    status === "running" ||
    status === "pause_requested" ||
    status === "pausing" ||
    status === "awaiting_permission" ||
    status === "awaiting_question"
  );
}

export function getMobileNotificationChip(status: MobileAgentProjection["status"]): string {
  switch (status) {
    case "awaiting_permission":
    case "awaiting_question":
      return "INPUT";
    case "completed":
      return "DONE";
    case "failed":
      return "ERR";
    case "cancelled":
    case "interrupted":
      return "STOP";
    case "paused":
      return "PAUSE";
    default:
      return "RUN";
  }
}

export function getMobileAgentPhaseLabel(phase: MobileAgentPhase): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "writing":
      return "Writing";
    case "editing":
      return "Editing";
    case "reading":
      return "Reading";
    case "running":
      return "Running commands";
    case "searching":
      return "Searching";
    case "browsing":
      return "Browsing";
    case "planning":
      return "Planning";
    case "delegating":
      return "Delegating";
    case "waiting":
      return "Waiting";
    case "finishing":
      return "Finishing";
    case "needs_permission":
      return "Needs permission";
    case "needs_answer":
      return "Needs an answer";
    case "pausing":
      return "Pausing";
    case "paused":
      return "Paused";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "idle":
      return "Idle";
    case "working":
    default:
      return "Working";
  }
}

/**
 * "+120 −8 · 4 files" - the diffstat line of a run. The deletions count uses
 * a real minus sign so it never reads as a hyphenated range.
 */
export function formatMobileEditStats(
  stats: MobileAgentEditStats | null | undefined
): string | null {
  if (!stats || stats.files <= 0) {
    return null;
  }
  return `+${stats.additions} −${stats.deletions} · ${stats.files} ${
    stats.files === 1 ? "file" : "files"
  }`;
}

export function deriveMobileAgentProjection(
  conversation: AgentConversationRecord,
  events: AgentStoredEvent[],
  options: {
    now?: number;
    previous?: MobileAgentProjection | null;
  } = {}
): MobileAgentProjection {
  const now = options.now ?? Date.now();
  const previous = options.previous;
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const lastEvent = sortedEvents[sortedEvents.length - 1] ?? null;
  const active = isBusyConversationStatus(conversation.status);
  const status = resolveProjectionStatus(conversation, sortedEvents);
  const sameConversation = previous?.conversationId === conversation.id;
  const startsAfterPreviousRun =
    active &&
    previous != null &&
    sameConversation &&
    (isTerminalProjectionStatus(previous.status) ||
      // The previous projection may be a stale snapshot from before a
      // reconnect: if a terminal boundary landed after it, whatever is
      // active now is a NEW run and must not inherit the old start time
      // (that is how notifications end up with hours-old elapsed timers).
      hasTerminalStatusAfter(sortedEvents, previous.lastEventSeq));
  const startedAt =
    sameConversation && previous.startedAt && !startsAfterPreviousRun
      ? previous.startedAt
      : active
        ? findRunStartedAt(
            sortedEvents,
            startsAfterPreviousRun ? previous.lastEventSeq : 0
          ) ?? conversation.updatedAt
        : null;
  const completedAt =
    status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
      ? lastEvent?.createdAt ?? conversation.updatedAt
      : null;
  const activeTodo = findCurrentTodo(sortedEvents);
  const activity = resolveCurrentActivity(conversation, sortedEvents, activeTodo);
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const todoProgress = deriveTodoProgress(sortedEvents, elapsedMs, now);
  const goalProgress = deriveGoalProgress(sortedEvents, conversation.status, now);
  const runEvents = currentRunEvents(sortedEvents);
  const phase = derivePhase(conversation, status, runEvents, todoProgress, goalProgress);
  const editStats = deriveEditStats(runEvents);
  // The final reply only matters once the run is over (completion card); it
  // is also the most expensive scan, so active runs skip it.
  const outcome =
    completedAt != null
      ? deriveRunOutcome(runEvents)
      : { summary: null, pullRequestUrl: null };

  return {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    title: conversation.title,
    status,
    lastEventSeq: Math.max(conversation.lastEventSeq, lastEvent?.seq ?? 0),
    currentActivity: activity,
    currentTodoId: activeTodo?.id ?? null,
    currentTodo: activeTodo?.content ?? null,
    pendingIntervention: conversation.pendingPermission
      ? "permission"
      : conversation.pendingQuestion
        ? "question"
        : null,
    pendingPermissionRequestId: conversation.pendingPermission?.requestId ?? null,
    pendingPermissionAllowOptionId: pickPermissionOptionId(
      conversation.pendingPermission?.options,
      ["allow_once", "allow_always"]
    ),
    pendingPermissionDenyOptionId: pickPermissionOptionId(
      conversation.pendingPermission?.options,
      ["reject_once", "reject_always"]
    ),
    pendingQuestionId: conversation.pendingQuestion?.questionId ?? null,
    startedAt,
    updatedAt: conversation.updatedAt,
    completedAt,
    elapsedMs,
    lastError: conversation.lastError,
    todoProgress,
    goalProgress,
    phase,
    editStats,
    summary: outcome.summary,
    pullRequestUrl: outcome.pullRequestUrl,
  };
}

/**
 * Events of the CURRENT run only. One conversation hosts many runs; the loaded
 * window can span several, and per-run aggregates (edit stats, final reply,
 * phase) must not leak across runs. Trailing status rows are the terminal
 * boundary of the run that just ended and still belong to it, so the scan for
 * the previous boundary starts before them.
 */
function currentRunEvents(events: AgentStoredEvent[]): AgentStoredEvent[] {
  let end = events.length;
  while (end > 0 && events[end - 1]?.kind === "status") {
    end -= 1;
  }
  for (let i = end - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === "status" && isTerminalEventStatus(event.status)) {
      return events.slice(i + 1);
    }
  }
  return events;
}

/** Goal runs this far along are wrapping up rather than "working". */
const FINISHING_GOAL_PERCENT = 90;

function derivePhase(
  conversation: AgentConversationRecord,
  status: MobileAgentProjection["status"],
  runEvents: AgentStoredEvent[],
  todo: MobileTodoProgress | null,
  goal: MobileGoalProgress | null
): MobileAgentPhase {
  switch (status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "paused":
      return "paused";
    case "idle":
      return "idle";
    case "pause_requested":
    case "pausing":
      return "pausing";
    case "awaiting_permission":
      return "needs_permission";
    case "awaiting_question":
      return "needs_answer";
    default:
      break;
  }
  if (conversation.pendingPermission) {
    return "needs_permission";
  }
  if (conversation.pendingQuestion) {
    return "needs_answer";
  }
  if (goal && goal.percent >= FINISHING_GOAL_PERCENT) {
    return "finishing";
  }
  if (
    todo &&
    todo.total > 0 &&
    todo.currentIndex === todo.total &&
    todo.completed === todo.total - 1
  ) {
    return "finishing";
  }
  return deriveActivityPhase(runEvents);
}

/**
 * Phase from the most recent activity-bearing event of the run. Only the
 * latest one counts: an older in-flight tool call is stale once the model has
 * moved on to streaming text or the next call.
 */
function deriveActivityPhase(runEvents: AgentStoredEvent[]): MobileAgentPhase {
  for (let i = runEvents.length - 1; i >= 0; i--) {
    const event = runEvents[i];
    if (!event) continue;
    switch (event.kind) {
      case "subagent":
        return event.status === "running" ? "delegating" : "thinking";
      case "tool_call":
      case "tool_call_update":
        if (event.status === "in_progress" || event.status === "pending") {
          return phaseForToolKind(resolveToolCallKind(event, runEvents, i));
        }
        // Between tool calls the model is deciding what to do next.
        return "thinking";
      case "assistant_message_chunk":
        return "writing";
      case "reasoning":
        return "thinking";
      case "plan":
        return "planning";
      default:
        continue;
    }
  }
  return "starting";
}

function phaseForToolKind(toolKind: string | undefined): MobileAgentPhase {
  switch (toolKind) {
    case "read":
      return "reading";
    case "edit":
    case "delete":
    case "move":
      return "editing";
    case "terminal":
    case "execute":
      return "running";
    case "grep":
    case "search":
    case "search_web":
    case "fetch":
      return "searching";
    case "browser":
      return "browsing";
    case "todo":
    case "goal":
      return "planning";
    case "subagent":
    case "task":
    case "orchestration":
      return "delegating";
    case "think":
      return "thinking";
    case "wait":
      return "waiting";
    default:
      return "working";
  }
}

function resolveToolCallKind(
  event: ToolCallLikeEvent,
  events: AgentStoredEvent[],
  index: number
): string | undefined {
  if (event.toolKind != null || event.kind === "tool_call") {
    return event.toolKind;
  }
  for (let i = index - 1; i >= 0; i--) {
    const origin = events[i];
    if (origin?.kind === "tool_call" && origin.toolCallId === event.toolCallId) {
      return origin.toolKind;
    }
  }
  return undefined;
}

/**
 * Sums the edit previews of the run's tool calls into one diffstat. Each tool
 * call contributes its latest preview once (updates supersede the initial
 * call), failed and cancelled edits never land and are skipped, and files are
 * counted by distinct path so re-editing a file does not inflate the count.
 */
function deriveEditStats(runEvents: AgentStoredEvent[]): MobileAgentEditStats | null {
  const previews = new Map<string, AgentToolEditPreview>();
  const finalStatus = new Map<string, string>();
  for (const event of runEvents) {
    if (event.kind !== "tool_call" && event.kind !== "tool_call_update") continue;
    finalStatus.set(event.toolCallId, event.status);
    if (event.editPreview) {
      previews.set(event.toolCallId, event.editPreview);
    }
  }
  const paths = new Set<string>();
  let unnamed = 0;
  let additions = 0;
  let deletions = 0;
  for (const [toolCallId, preview] of previews) {
    const status = finalStatus.get(toolCallId);
    if (status === "failed" || status === "cancelled") continue;
    additions += Math.max(0, preview.addedLines);
    deletions += Math.max(0, preview.removedLines);
    const path = preview.path?.trim();
    if (path) {
      paths.add(path.replace(/^file:\/\//i, "").replace(/\\/g, "/"));
    } else {
      unnamed += 1;
    }
  }
  const files = paths.size + unnamed;
  if (files === 0) {
    return null;
  }
  return { files, additions, deletions };
}

const PULL_REQUEST_URL_PATTERN =
  /https?:\/\/[^\s<>()"'`]+?\/(?:pull|pulls|merge_requests|pull-requests|pullrequest)\/\d+(?:[/?#][^\s<>()"'`]*)?/gi;

/**
 * First pull/merge request link in a piece of text (GitHub, GitLab, Bitbucket,
 * Azure DevOps shapes), with trailing sentence punctuation stripped.
 */
export function findMobilePullRequestUrl(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  PULL_REQUEST_URL_PATTERN.lastIndex = 0;
  const match = PULL_REQUEST_URL_PATTERN.exec(text);
  return match ? match[0].replace(/[.,;:!?]+$/, "") : null;
}

/** Length budget for the completion card's excerpt of the final reply. */
const SUMMARY_MAX = 160;
/** Prefer ending the excerpt at a sentence boundary when one lands past this. */
const SUMMARY_SENTENCE_MIN = 60;

/**
 * Reduces a markdown reply to one clean notification line: code fences,
 * links, headings, list markers, emphasis, and HTML are stripped, the first
 * non-empty paragraph is kept, and it is cut at a sentence boundary when the
 * budget forces truncation. Payload-shaped text is rejected outright.
 */
export function summarizeMobileAssistantReply(
  text: string | null | undefined,
  maxLength: number = SUMMARY_MAX
): string | null {
  if (!text) {
    return null;
  }
  const cleaned = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    // Headings label sections ("## Summary"); they never summarize anything.
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
  const paragraph = cleaned
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  if (!paragraph) {
    return null;
  }
  if (paragraph.length > maxLength) {
    const window = paragraph.slice(0, maxLength);
    const boundary = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? ")
    );
    if (boundary >= SUMMARY_SENTENCE_MIN) {
      return sanitizeMobileActivityText(window.slice(0, boundary + 1), maxLength);
    }
  }
  return sanitizeMobileActivityText(paragraph, maxLength);
}

/**
 * What the run produced, for the completion card: an excerpt of the final
 * assistant reply and the pull request the run opened. The PR link is taken
 * from the most recent tool output / system line first - that is where a PR
 * created by a tool actually lands - and only then from the reply, whose
 * first link is the PR being announced (later links tend to be the base it
 * stacks on).
 */
function deriveRunOutcome(runEvents: AgentStoredEvent[]): {
  summary: string | null;
  pullRequestUrl: string | null;
} {
  let lastMessageId: string | null = null;
  let pullRequestUrl: string | null = null;
  for (let i = runEvents.length - 1; i >= 0; i--) {
    const event = runEvents[i];
    if (!event) continue;
    if (lastMessageId == null && event.kind === "assistant_message_chunk") {
      lastMessageId = event.messageId;
    } else if (
      pullRequestUrl == null &&
      (event.kind === "tool_call" || event.kind === "tool_call_update")
    ) {
      pullRequestUrl = findMobilePullRequestUrl(event.detail);
    } else if (pullRequestUrl == null && event.kind === "system") {
      pullRequestUrl = findMobilePullRequestUrl(event.text);
    }
    if (lastMessageId != null && pullRequestUrl != null) break;
  }
  const replyText =
    lastMessageId == null
      ? null
      : runEvents
          .map((event) =>
            event.kind === "assistant_message_chunk" && event.messageId === lastMessageId
              ? event.text
              : ""
          )
          .join("");
  return {
    summary: summarizeMobileAssistantReply(replyText),
    pullRequestUrl: pullRequestUrl ?? findMobilePullRequestUrl(replyText),
  };
}

/**
 * Resolves the option a one-tap notification button should answer with. The
 * kinds are tried in order so a bare "allow"/"reject" button maps onto the
 * least-privileged matching option (once before always).
 */
function pickPermissionOptionId(
  options: AgentPermissionOption[] | undefined,
  kinds: AgentPermissionOptionKind[]
): string | null {
  if (!options || options.length === 0) {
    return null;
  }
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return null;
}

function isBusyConversationStatus(status: AgentConversationStatus): boolean {
  return (
    status === "running" ||
    status === "pause_requested" ||
    status === "pausing" ||
    status === "awaiting_permission" ||
    status === "awaiting_question"
  );
}

function resolveProjectionStatus(
  conversation: AgentConversationRecord,
  events: AgentStoredEvent[]
): MobileAgentProjection["status"] {
  if (conversation.status === "idle" && events.some((event) => event.kind === "status" && event.status === "idle")) {
    return "completed";
  }
  return conversation.status;
}

function isTerminalProjectionStatus(status: MobileAgentProjection["status"]): boolean {
  return (
    status === "idle" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function isTerminalEventStatus(status: string): boolean {
  return (
    status === "idle" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function hasTerminalStatusAfter(events: AgentStoredEvent[], afterSeq: number): boolean {
  return events.some(
    (event) =>
      event.seq > afterSeq &&
      event.kind === "status" &&
      isTerminalEventStatus(event.status)
  );
}

/**
 * Start time of the CURRENT run. One conversation hosts many runs over time;
 * the loaded event window can span several of them, so the scan is bounded to
 * events after the latest terminal status boundary. Picking the first
 * "running" event of the whole window (the old behavior) anchored the
 * notification chronometer to a long-finished run, producing wildly stale
 * elapsed timers.
 */
function findRunStartedAt(events: AgentStoredEvent[], afterSeq: number): number | null {
  const runEvents = events.filter((event) => event.seq > afterSeq);
  let boundaryIndex = -1;
  for (let i = runEvents.length - 1; i >= 0; i--) {
    const event = runEvents[i];
    if (event?.kind === "status" && isTerminalEventStatus(event.status)) {
      boundaryIndex = i;
      break;
    }
  }
  const currentRunEvents = boundaryIndex >= 0 ? runEvents.slice(boundaryIndex + 1) : runEvents;
  const runningStatus = currentRunEvents.find(
    (event) => event.kind === "status" && event.status === "running"
  );
  return (
    runningStatus?.createdAt ??
    currentRunEvents.find((event) => event.kind === "user_message")?.createdAt ??
    null
  );
}

function findCurrentTodo(events: AgentStoredEvent[]): AgentPlanEntry | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind !== "plan") continue;
    return (
      event.entries.find((entry) => entry.status === "in_progress") ??
      event.entries.find((entry) => entry.status === "blocked") ??
      event.entries.find((entry) => entry.status === "pending") ??
      null
    );
  }
  return null;
}

function findLatestPlan(events: AgentStoredEvent[]): AgentPlanEntry[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === "plan" && event.entries.length > 0) {
      return event.entries;
    }
  }
  return null;
}

function deriveTodoProgress(
  events: AgentStoredEvent[],
  elapsedMs: number,
  now: number
): MobileTodoProgress | null {
  const entries = findLatestPlan(events);
  if (!entries) {
    return null;
  }
  const total = entries.length;
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const blocked = entries.filter((entry) => entry.status === "blocked").length;
  const pending = entries.filter((entry) => entry.status === "pending").length;
  const inProgress = entries.filter((entry) => entry.status === "in_progress").length;
  const currentIndexZeroBased = entries.findIndex(
    (entry) =>
      entry.status === "in_progress" ||
      entry.status === "blocked" ||
      entry.status === "pending"
  );
  const percent = Math.round((completed / total) * 100);
  const estimatedRemainingMs =
    completed > 0 && completed < total && elapsedMs >= 10_000
      ? boundedEstimate((elapsedMs / completed) * (total - completed))
      : null;
  return {
    total,
    completed,
    blocked,
    pending,
    inProgress,
    currentIndex: currentIndexZeroBased >= 0 ? currentIndexZeroBased + 1 : null,
    percent,
    estimatedRemainingMs,
    estimatedCompletionAt:
      estimatedRemainingMs == null ? null : now + estimatedRemainingMs,
  };
}

function deriveGoalProgress(
  events: AgentStoredEvent[],
  status: AgentConversationStatus,
  now: number
): MobileGoalProgress | null {
  const goal = latestGoalProgressStatus(events, status);
  if (!goal) {
    return null;
  }
  const activeRuntimeMs =
    goal.runtimeActiveSince != null && status === "running"
      ? Math.max(0, now - goal.runtimeActiveSince)
      : 0;
  const runtimeMs = Math.max(0, (goal.runtimeSeconds ?? 0) * 1000 + activeRuntimeMs);
  const estimatedRemainingMs =
    goal.progressPercent > 0 &&
    goal.progressPercent < 100 &&
    runtimeMs >= 10_000 &&
    goal.completedAt == null
      ? boundedEstimate((runtimeMs * (100 - goal.progressPercent)) / goal.progressPercent)
      : null;
  return {
    percent: goal.progressPercent,
    headline: goal.headline,
    runtimeMs,
    estimatedRemainingMs,
    estimatedCompletionAt:
      estimatedRemainingMs == null ? null : now + estimatedRemainingMs,
  };
}

function boundedEstimate(value: number): number {
  const MAX_ESTIMATE_MS = 7 * 24 * 60 * 60 * 1000;
  return Math.round(Math.max(0, Math.min(MAX_ESTIMATE_MS, value)));
}

/**
 * Length budgets for notification-facing activity text. Verbatim provider
 * text (tool titles, status details) is only used when it fits one clean
 * notification line untruncated; anything longer falls back to a humanized
 * label instead of command/JSON soup. The hard cap bounds text that has no
 * cleaner alternative (sanitized error messages and unknown tool titles).
 */
const ACTIVITY_VERBATIM_MAX = 72;
const ACTIVITY_HARD_MAX = 120;
const ACTIVITY_FILE_LABEL_MAX = 40;

/**
 * Normalizes free-form provider text for a notification body: collapses it
 * to one line and truncates to `maxLength`. Returns null for empty text and
 * for anything payload-shaped (JSON args, escaped fragments) - structured
 * payloads are never useful in a notification, no matter how short.
 */
export function sanitizeMobileActivityText(
  value: string | null | undefined,
  maxLength: number = ACTIVITY_HARD_MAX
): string | null {
  if (!value) {
    return null;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed || looksLikeStructuredPayload(collapsed)) {
    return null;
  }
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Verbatim gate: the text qualifies as-is (clean single line within budget)
 * or not at all. Used where a humanized fallback exists, so truncated
 * command/payload fragments never win over a proper label.
 */
function cleanVerbatimText(
  value: string | null | undefined,
  maxLength: number = ACTIVITY_VERBATIM_MAX
): string | null {
  if (!value) {
    return null;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (
    !collapsed ||
    collapsed.length > maxLength ||
    looksLikeStructuredPayload(collapsed)
  ) {
    return null;
  }
  return collapsed;
}

function looksLikeStructuredPayload(text: string): boolean {
  // JSON blobs ({"path": ...}), arrays, "key": value fragments, and strings
  // carrying escaped payload characters all read as raw tool arguments.
  if (/^[[{]/.test(text)) return true;
  if (/"[^"]{1,80}"\s*:/.test(text)) return true;
  if (/\\n|\\t|\\"/.test(text)) return true;
  return false;
}

function activityPathBasename(path: string): string {
  const cleaned = path.replace(/^file:\/\//i, "").split("?")[0] ?? path;
  const segments = cleaned.split(/[/\\]/);
  return segments[segments.length - 1] || cleaned;
}

/**
 * Human label for a tool call derived from its normalized kind. The kinds
 * cover every provider normalizer (cesium, ACP, cursor-sdk, opencode, ...);
 * unknown kinds return null so callers can fall back to the tool title.
 */
function toolKindActivityLabel(
  toolKind: string | undefined,
  locations: AgentToolLocation[] | undefined
): string | null {
  const firstPath = locations?.[0]?.path;
  const file = firstPath
    ? cleanVerbatimText(activityPathBasename(firstPath), ACTIVITY_FILE_LABEL_MAX)
    : null;
  switch (toolKind) {
    case "read":
      return file ? `Reading ${file}` : "Reading files";
    case "edit":
      return file ? `Editing ${file}` : "Editing files";
    case "delete":
      return file ? `Deleting ${file}` : "Deleting files";
    case "move":
      return "Moving files";
    case "terminal":
    case "execute":
      return "Running a terminal command";
    case "grep":
    case "search":
      return "Searching the workspace";
    case "search_web":
      return "Searching the web";
    case "fetch":
      return "Fetching a web page";
    case "browser":
      return "Using the browser";
    case "todo":
      return "Updating the plan";
    case "goal":
      return "Updating goal progress";
    case "mcp":
      return "Using a connected tool";
    case "subagent":
    case "task":
      return "Running a subagent";
    case "question":
      return "Preparing a question";
    case "memory":
      return "Updating memory";
    case "workflow":
      return "Running a workflow";
    case "orchestration":
      return "Coordinating agents";
    case "mode":
    case "switch_mode":
      return "Switching modes";
    case "wait":
      return "Waiting";
    case "think":
      return "Thinking";
    default:
      return null;
  }
}

type ToolCallLikeEvent = Extract<
  AgentStoredEvent,
  { kind: "tool_call" | "tool_call_update" }
>;

/**
 * Clean one-line description of an in-flight tool call. Tool `detail` is
 * deliberately ignored: providers fill it with raw JSON arguments or output
 * chunks, which is exactly the noise a notification must not show. Updates
 * that omit descriptive fields recover them from the originating tool_call.
 */
function describeToolCallActivity(
  event: ToolCallLikeEvent,
  events: AgentStoredEvent[],
  index: number
): string {
  let title = event.title;
  let toolKind = event.toolKind;
  let locations = event.locations;
  if (
    event.kind === "tool_call_update" &&
    (title == null || toolKind == null || locations == null)
  ) {
    for (let i = index - 1; i >= 0; i--) {
      const origin = events[i];
      if (origin?.kind !== "tool_call" || origin.toolCallId !== event.toolCallId) {
        continue;
      }
      title = title ?? origin.title;
      toolKind = toolKind ?? origin.toolKind;
      locations = locations ?? origin.locations;
      break;
    }
  }
  return (
    cleanVerbatimText(title) ??
    toolKindActivityLabel(toolKind, locations) ??
    sanitizeMobileActivityText(title) ??
    "Using a tool"
  );
}

/**
 * Notification line for a pending permission. Short clean titles ("Allow
 * terminal command?") pass through; oversized ones (full shell commands) and
 * raw-JSON details collapse to a category label so the user still learns
 * WHAT is being asked without the payload.
 */
function describePendingPermission(pending: AgentPendingPermission): string {
  const title = cleanVerbatimText(pending.title);
  if (title) {
    return title;
  }
  switch (pending.permission) {
    case "terminal":
      return "Wants to run a terminal command";
    case "editFile":
      return "Wants to edit a file";
    case "mcpCall":
      return "Wants to use a connected tool";
    case "switchMode":
      return "Wants to switch modes";
    default:
      break;
  }
  return cleanVerbatimText(pending.detail) ?? "Needs permission";
}

/**
 * An awaiting_question run should surface the actual question verbatim, not a
 * generic "Needs an answer" placeholder: the notification body is often the
 * only thing the user sees before deciding whether to context-switch. The
 * caller still runs the prompt through the notification hygiene cap so a
 * multi-paragraph question renders as one bounded line.
 */
function findPendingQuestionPrompt(
  events: AgentStoredEvent[],
  questionId: string
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind !== "question" || event.questionId !== questionId) continue;
    const prompt = event.prompt.trim() || event.questions?.[0]?.prompt.trim();
    return prompt || null;
  }
  return null;
}

function resolveCurrentActivity(
  conversation: AgentConversationRecord,
  events: AgentStoredEvent[],
  activeTodo: AgentPlanEntry | null
): string {
  if (conversation.pendingPermission) {
    return describePendingPermission(conversation.pendingPermission);
  }
  if (conversation.pendingQuestion) {
    return (
      sanitizeMobileActivityText(
        findPendingQuestionPrompt(events, conversation.pendingQuestion.questionId)
      ) ?? "Needs an answer"
    );
  }
  if (activeTodo) {
    const todoLabel = sanitizeMobileActivityText(activeTodo.content);
    if (todoLabel) {
      return todoLabel;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === "subagent" && event.status === "running") {
      return (
        cleanVerbatimText(event.recentActivity) ??
        cleanVerbatimText(event.title) ??
        "Running a subagent"
      );
    }
    if (event.kind === "tool_call_update" || event.kind === "tool_call") {
      if (event.status === "in_progress" || event.status === "pending") {
        return describeToolCallActivity(event, events, i);
      }
      continue;
    }
    // Status details and system lines can be verbose plumbing (e.g.
    // "Auto-accepted Run <entire shell command> ..."); only clean one-liners
    // qualify, everything else falls through to an older, cleaner source.
    if (event.kind === "system" && event.level !== "error") {
      const text = cleanVerbatimText(event.text);
      if (text) {
        return text;
      }
      continue;
    }
    if (event.kind === "status" && event.detail) {
      const detail = cleanVerbatimText(event.detail);
      if (detail) {
        return detail;
      }
      continue;
    }
  }
  switch (conversation.status) {
    case "idle":
      return "Agent is idle";
    case "failed":
      return sanitizeMobileActivityText(conversation.lastError) ?? "Agent run failed";
    case "cancelled":
      return "Agent run cancelled";
    case "paused":
      return "Agent run paused";
    default:
      return "Agent is working";
  }
}
