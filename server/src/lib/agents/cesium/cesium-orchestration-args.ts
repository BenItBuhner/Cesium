import type {
  OrchestrationAssignmentPermissionPolicy,
  OrchestrationAssignmentStatus,
  OrchestrationColumnId,
  OrchestrationIssuePriority,
  OrchestrationPermissionDecision,
} from "../../orchestration/types.js";
import { asRecord, asStringArray } from "./cesium-coerce.js";

export function asOrchestrationColumnId(value: unknown): OrchestrationColumnId | undefined {
  return value === "backlog" ||
    value === "ready" ||
    value === "in_progress" ||
    value === "review" ||
    value === "blocked" ||
    value === "done"
    ? value
    : undefined;
}

export function asOrchestrationPriority(
  value: unknown
): OrchestrationIssuePriority | undefined {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "urgent"
    ? value
    : undefined;
}

export function asOrchestrationPermissionDecision(
  value: unknown
): OrchestrationPermissionDecision | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined;
}

export function asOrchestrationPermissionPolicy(
  value: unknown
): OrchestrationAssignmentPermissionPolicy {
  const record = asRecord(value);
  return {
    editFile: asOrchestrationPermissionDecision(record?.editFile) ?? "allow",
    terminal: asOrchestrationPermissionDecision(record?.terminal) ?? "allow",
    mcpCall: asOrchestrationPermissionDecision(record?.mcpCall) ?? "allow",
  };
}

export type OrchestrationWaitFor =
  | "board_update"
  | "issue_update"
  | "issue_comment"
  | "issue_done"
  | "assignment_update"
  | "assignment_status"
  | "assignment_finished"
  | "any_assignment_finished"
  | "all_issue_assignments_finished";

function asOrchestrationAssignmentStatus(
  value: unknown
): OrchestrationAssignmentStatus | undefined {
  return value === "assigned" ||
    value === "running" ||
    value === "waiting" ||
    value === "blocked" ||
    value === "reviewing" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

export function asOrchestrationAssignmentStatuses(
  value: unknown
): OrchestrationAssignmentStatus[] {
  const statuses = asStringArray(value)
    .map(asOrchestrationAssignmentStatus)
    .filter((status): status is OrchestrationAssignmentStatus => Boolean(status));
  return [...new Set(statuses)];
}

export function asOrchestrationWaitFor(value: unknown): OrchestrationWaitFor {
  return value === "issue_update" ||
    value === "issue_comment" ||
    value === "issue_done" ||
    value === "assignment_update" ||
    value === "assignment_status" ||
    value === "assignment_finished" ||
    value === "any_assignment_finished" ||
    value === "all_issue_assignments_finished"
    ? value
    : "board_update";
}

export type OrchestrationControlAction = "pause" | "resume" | "stop" | "steer";

export function asOrchestrationControlAction(
  value: unknown
): OrchestrationControlAction | undefined {
  return value === "pause" || value === "resume" || value === "stop" || value === "steer"
    ? value
    : undefined;
}
