import type {
  AgentBackendId,
  AgentConversationConfig,
  AgentConversationStatus,
} from "@/lib/agent-types";

export type OrchestrationColumnId =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

export type OrchestrationIssuePriority = "none" | "low" | "medium" | "high" | "urgent";
export type OrchestrationIssueVerificationStatus =
  | "unchecked"
  | "pending"
  | "passed"
  | "failed";
export type OrchestrationAssignmentStatus =
  | "assigned"
  | "running"
  | "waiting"
  | "blocked"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationActor =
  | { type: "user"; label?: string }
  | { type: "head_agent"; conversationId?: string }
  | { type: "child_agent"; conversationId: string }
  | { type: "system" };

export type OrchestrationBoardSettings = {
  allowedBackendIds: AgentBackendId[];
  defaultChildBackendId: AgentBackendId | null;
  defaultModelByBackend: Partial<Record<AgentBackendId, string>>;
  maxConcurrentIssues: number | null;
  maxConcurrentAgents: number | null;
  userQuestionTimeoutMs: number;
  mcpEnabled: boolean;
};

export type OrchestrationBoardRecord = {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  headConversationId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  settings: OrchestrationBoardSettings;
};

export type OrchestrationIssueRecord = {
  schemaVersion: 1;
  id: string;
  boardId: string;
  title: string;
  description: string;
  columnId: OrchestrationColumnId;
  priority: OrchestrationIssuePriority;
  sortOrder: number;
  acceptanceCriteria: string[];
  dependencyIssueIds: string[];
  blockedReason: string | null;
  verification: {
    status: OrchestrationIssueVerificationStatus;
    summary?: string;
    updatedAt?: number;
  };
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type OrchestrationAssignmentRecord = {
  schemaVersion: 1;
  id: string;
  boardId: string;
  issueId: string;
  conversationId: string;
  role: string;
  status: OrchestrationAssignmentStatus;
  createdAt: number;
  updatedAt: number;
  config: Partial<AgentConversationConfig>;
  lastKnownConversationStatus: AgentConversationStatus | null;
};

export type OrchestrationEventKind =
  | "board_created"
  | "issue_created"
  | "issue_updated"
  | "issue_moved"
  | "issue_deleted"
  | "comment_added"
  | "agent_assigned"
  | "agent_unassigned"
  | "agent_status_changed"
  | "agent_steered"
  | "verification_updated"
  | "wait_started"
  | "wait_completed";

export type OrchestrationEventRecord = {
  schemaVersion: 1;
  id: string;
  boardId: string;
  issueId: string | null;
  assignmentId: string | null;
  kind: OrchestrationEventKind;
  actor: OrchestrationActor;
  message: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type OrchestrationBoardSnapshot = {
  board: OrchestrationBoardRecord;
  issues: OrchestrationIssueRecord[];
  assignments: OrchestrationAssignmentRecord[];
  events: OrchestrationEventRecord[];
};

export type OrchestrationSocketServerMessage =
  | { type: "connected" }
  | { type: "pong" }
  | { type: "error"; message: string; boardId?: string }
  | { type: "snapshot"; boardId: string; snapshot: OrchestrationBoardSnapshot }
  | { type: "board"; boardId: string; snapshot: OrchestrationBoardSnapshot }
  | { type: "board_deleted"; boardId: string; workspaceId: string };

export const ORCHESTRATION_COLUMNS: Array<{
  id: OrchestrationColumnId;
  label: string;
}> = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];
