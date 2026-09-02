import type {
  AgentConversationRecord,
  AgentConversationStatus,
  AgentPlanEntry,
  AgentStoredEvent,
} from "./protocol";
import { latestGoalProgressStatus } from "./agent-chat";

export type MobilePendingIntervention = "permission" | "question" | null;

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
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  elapsedMs: number;
  lastError: string | null;
  todoProgress: MobileTodoProgress | null;
  goalProgress: MobileGoalProgress | null;
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
    startedAt,
    updatedAt: conversation.updatedAt,
    completedAt,
    elapsedMs,
    lastError: conversation.lastError,
    todoProgress,
    goalProgress,
  };
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
 * An awaiting_question run should surface the actual question verbatim, not a
 * generic "Needs an answer" placeholder: the notification body is often the
 * only thing the user sees before deciding whether to context-switch.
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
    return conversation.pendingPermission.title ?? conversation.pendingPermission.detail ?? "Needs permission";
  }
  if (conversation.pendingQuestion) {
    return (
      findPendingQuestionPrompt(events, conversation.pendingQuestion.questionId) ??
      "Needs an answer"
    );
  }
  if (activeTodo) {
    return activeTodo.content;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === "subagent" && event.status === "running") {
      return event.recentActivity ?? event.title;
    }
    if (event.kind === "tool_call_update" || event.kind === "tool_call") {
      if (event.status === "in_progress" || event.status === "pending") {
        return event.detail ?? event.title ?? "Agent is using a tool";
      }
    }
    if (event.kind === "system" && event.level !== "error") {
      return event.text;
    }
    if (event.kind === "status" && event.detail) {
      return event.detail;
    }
  }
  switch (conversation.status) {
    case "idle":
      return "Agent is idle";
    case "failed":
      return conversation.lastError ?? "Agent run failed";
    case "cancelled":
      return "Agent run cancelled";
    case "paused":
      return "Agent run paused";
    default:
      return "Agent is working";
  }
}
