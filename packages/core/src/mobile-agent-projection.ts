import type {
  AgentConversationRecord,
  AgentConversationStatus,
  AgentPlanEntry,
  AgentStoredEvent,
} from "./protocol";
import { latestBurnProgressStatus } from "./agent-chat";

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

export type MobileBurnProgress = {
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
  burnProgress: MobileBurnProgress | null;
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
  const startedAt =
    previous?.conversationId === conversation.id && previous.startedAt
      ? previous.startedAt
      : active
        ? findRunStartedAt(sortedEvents) ?? conversation.updatedAt
        : null;
  const completedAt =
    status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
      ? lastEvent?.createdAt ?? conversation.updatedAt
      : null;
  const activeTodo = findCurrentTodo(sortedEvents);
  const activity = resolveCurrentActivity(conversation, sortedEvents, activeTodo);
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const todoProgress = deriveTodoProgress(sortedEvents, elapsedMs, now);
  const burnProgress = deriveBurnProgress(sortedEvents, conversation.status, now);

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
    burnProgress,
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

function findRunStartedAt(events: AgentStoredEvent[]): number | null {
  const runningStatus = events.find((event) => event.kind === "status" && event.status === "running");
  return runningStatus?.createdAt ?? events.find((event) => event.kind === "user_message")?.createdAt ?? null;
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

function deriveBurnProgress(
  events: AgentStoredEvent[],
  status: AgentConversationStatus,
  now: number
): MobileBurnProgress | null {
  const burn = latestBurnProgressStatus(events, status);
  if (!burn) {
    return null;
  }
  const activeRuntimeMs =
    burn.runtimeActiveSince != null && status === "running"
      ? Math.max(0, now - burn.runtimeActiveSince)
      : 0;
  const runtimeMs = Math.max(0, (burn.runtimeSeconds ?? 0) * 1000 + activeRuntimeMs);
  const estimatedRemainingMs =
    burn.progressPercent > 0 &&
    burn.progressPercent < 100 &&
    runtimeMs >= 10_000 &&
    burn.completedAt == null
      ? boundedEstimate((runtimeMs * (100 - burn.progressPercent)) / burn.progressPercent)
      : null;
  return {
    percent: burn.progressPercent,
    headline: burn.headline,
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

function resolveCurrentActivity(
  conversation: AgentConversationRecord,
  events: AgentStoredEvent[],
  activeTodo: AgentPlanEntry | null
): string {
  if (conversation.pendingPermission) {
    return conversation.pendingPermission.title ?? conversation.pendingPermission.detail ?? "Needs permission";
  }
  if (conversation.pendingQuestion) {
    return "Needs an answer";
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
