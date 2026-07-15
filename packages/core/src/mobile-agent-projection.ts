import type {
  AgentConversationRecord,
  AgentConversationStatus,
  AgentPlanEntry,
  AgentStoredEvent,
} from "./protocol";

export type MobilePendingIntervention = "permission" | "question" | null;

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
    active && previous?.conversationId === conversation.id && previous.startedAt
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
    elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0,
    lastError: conversation.lastError,
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
