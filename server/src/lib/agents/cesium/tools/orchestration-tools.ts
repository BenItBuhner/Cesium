import { addOrchestrationComment, createOrchestrationIssue, deleteOrchestrationIssue, readOrchestrationBoardSnapshot, upsertOrchestrationAssignment, upsertOrchestrationIssue } from "../../../orchestration/store.js";
import type { OrchestrationAssignmentPermissionPolicy, OrchestrationAssignmentRecord, OrchestrationAssignmentStatus, OrchestrationBoardSnapshot } from "../../../orchestration/types.js";
import { openWorkLedgerBoard, syncLedgerPlanFiles, workLedgerItems } from "../../work-ledger.js";
import { appendTodoPlanEvent, ledgerScope } from "./plan-tools.js";
import { generateTranscriptFromEvents } from "../../event-log-read.js";
import { markChildReported } from "../../child-reports.js";
import { asNumber } from "../../json-coerce.js";
import type { AgentBackendId, AgentConversationStatus } from "../../types.js";
import { asRecord, asString, asStringArray, safeJson } from "../cesium-coerce.js";
import { asOrchestrationColumnId, asOrchestrationControlAction, asOrchestrationPermissionDecision, asOrchestrationPermissionPolicy, asOrchestrationPriority } from "../cesium-orchestration-args.js";
import { randomUUID } from "node:crypto";
import type { CesiumToolContext } from "./types.js";

/** The conversation's board, which is also its work ledger. */
export async function resolveCurrentOrchestrationBoard(ctx: CesiumToolContext) {
  const snapshot = await openWorkLedgerBoard(
    { ...ledgerScope(ctx), title: ctx.conversation.title || "Orchestration" },
    { create: true, reuseUnlinkedBoard: true }
  );
  if (!snapshot) {
    throw new Error("No orchestration board is linked to this head conversation.");
  }
  return snapshot;
}

/** The issue an `issueId` argument names: its id, or its ledger key such as todo-2. */
function resolveIssueId(snapshot: OrchestrationBoardSnapshot, issueId: string | undefined): string | undefined {
  if (!issueId) return undefined;
  return (
    snapshot.issues.find((issue) => issue.id === issueId)?.id ??
    snapshot.issues.find((issue) => issue.ledger?.key === issueId)?.id ??
    issueId
  );
}

/** Ledger tasks changed through the board show up in the chat's todo list too. */
async function showLedgerTasks(ctx: CesiumToolContext, snapshot: OrchestrationBoardSnapshot, raw: unknown) {
  await appendTodoPlanEvent(ctx, workLedgerItems(snapshot), raw);
  await syncLedgerPlanFiles(ledgerScope(ctx), snapshot);
}

export async function resolveOrchestrationBoardFromArgs(
  ctx: CesiumToolContext,
  args: Record<string, unknown>) {
  const boardId = asString(args.boardId);
  if (boardId) {
    const snapshot = await readOrchestrationBoardSnapshot(boardId);
    if (!snapshot || snapshot.board.workspaceId !== ctx.workspace.id) {
      throw new Error(`Unknown orchestration board: ${boardId}`);
    }
    return snapshot;
  }
  const snapshot = await resolveCurrentOrchestrationBoard(ctx);
  if (!snapshot) {
    throw new Error("No orchestration board is linked to this head conversation.");
  }
  return snapshot;
}

export async function orchestrationBoardSnapshotTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const snapshot = await resolveOrchestrationBoardFromArgs(ctx, args);
  return safeJson({
    board: snapshot.board,
    issues: snapshot.issues,
    assignments: snapshot.assignments,
    recentEvents: snapshot.events.slice(-30),
  });
}

export async function orchestrationCreateIssueTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveOrchestrationBoardFromArgs(ctx, args);
  const title = asString(args.title);
  if (!title) {
    throw new Error("orchestration_create_issue.title is required.");
  }
  const columnId = asOrchestrationColumnId(args.columnId);
  const blockerExplanation = asString(args.blockerExplanation);
  if (columnId === "blocked" && !blockerExplanation) {
    throw new Error(
      "orchestration_create_issue.blockerExplanation is required for blocked issues."
    );
  }
  const snapshot = await createOrchestrationIssue({
    boardId: current.board.id,
    title,
    description: asString(args.description),
    columnId,
    priority: asOrchestrationPriority(args.priority),
    acceptanceCriteria: asStringArray(args.acceptanceCriteria),
    blockedReason: blockerExplanation,
    actor: { type: "head_agent", conversationId: ctx.conversationId },
  });
  const issue = snapshot.issues[snapshot.issues.length - 1];
  if (snapshot.board.headConversationId === ctx.conversationId) {
    await showLedgerTasks(ctx, snapshot, args);
  }
  return safeJson({ issue, boardId: snapshot.board.id });
}

export async function orchestrationUpdateIssueTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveOrchestrationBoardFromArgs(ctx, args);
  const issueId = resolveIssueId(current, asString(args.issueId));
  if (!issueId) {
    throw new Error("orchestration_update_issue.issueId is required.");
  }
  const columnId = asOrchestrationColumnId(args.columnId);
  const priority = asOrchestrationPriority(args.priority);
  const blockerExplanation =
    asString(args.blockerExplanation) ?? asString(args.blockedReason);
  const existingIssue = current.issues.find((issue) => issue.id === issueId);
  if (!existingIssue) {
    throw new Error(`Unknown orchestration issue: ${issueId}`);
  }
  if (columnId === "blocked" && !blockerExplanation && !existingIssue.blockedReason) {
    throw new Error(
      "orchestration_update_issue.blockerExplanation is required when moving an issue to blocked."
    );
  }
  const snapshot = await upsertOrchestrationIssue(
    current.board.id,
    {
      id: issueId,
      ...(asString(args.title) ? { title: asString(args.title)! } : {}),
      ...(typeof args.description === "string"
        ? { description: args.description }
        : {}),
      ...(columnId ? { columnId } : {}),
      ...(priority ? { priority } : {}),
      ...(Array.isArray(args.acceptanceCriteria)
        ? { acceptanceCriteria: asStringArray(args.acceptanceCriteria) }
        : {}),
      ...(blockerExplanation
        ? { blockedReason: blockerExplanation }
        : {}),
    },
    { type: "head_agent", conversationId: ctx.conversationId }
  );
  if (snapshot.board.headConversationId === ctx.conversationId) {
    await showLedgerTasks(ctx, snapshot, args);
  }
  return safeJson({
    issue: snapshot.issues.find((issue) => issue.id === issueId),
    boardId: snapshot.board.id,
  });
}

export async function orchestrationCommentIssueTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveOrchestrationBoardFromArgs(ctx, args);
  const issueId = resolveIssueId(current, asString(args.issueId));
  const message = asString(args.message);
  if (!issueId || !message) {
    throw new Error("orchestration_comment_issue requires issueId and message.");
  }
  const snapshot = await addOrchestrationComment({
    boardId: current.board.id,
    issueId,
    message,
    actor: { type: "head_agent", conversationId: ctx.conversationId },
  });
  return safeJson({ boardId: snapshot.board.id, issueId, message });
}

export async function orchestrationDeleteIssueTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const current = await resolveOrchestrationBoardFromArgs(ctx, args);
  const issueId = resolveIssueId(current, asString(args.issueId));
  if (!issueId) {
    throw new Error("orchestration_delete_issue.issueId is required.");
  }
  const issue = current.issues.find((candidate) => candidate.id === issueId);
  if (!issue) {
    throw new Error(`Unknown orchestration issue: ${issueId}`);
  }
  const assignments = current.assignments.filter(
    (assignment) => assignment.issueId === issueId
  );
  const reason = asString(args.reason);
  const { agentRuntimeManager } = await import("../../runtime-manager.js");
  await Promise.all(
    assignments.map((assignment) =>
      agentRuntimeManager
        .cancelConversation(ctx.workspace, assignment.conversationId)
        .catch(() => undefined)
    )
  );
  const snapshot = await deleteOrchestrationIssue(
    current.board.id,
    issueId,
    { type: "head_agent", conversationId: ctx.conversationId }
  );
  if (snapshot.board.headConversationId === ctx.conversationId) {
    await showLedgerTasks(ctx, snapshot, args);
  }
  return safeJson({
    boardId: snapshot.board.id,
    deletedIssue: issue,
    cancelledAssignments: assignments.map((assignment) => assignment.id),
    reason: reason ?? null,
  });
}

export async function orchestrationAssignAgentTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveOrchestrationBoardFromArgs(ctx, args);
  const issueId = resolveIssueId(current, asString(args.issueId));
  const instructions = asString(args.instructions);
  if (!issueId || !instructions) {
    throw new Error("orchestration_assign_agent requires issueId and instructions.");
  }
  const issue = current.issues.find((candidate) => candidate.id === issueId);
  if (!issue) {
    throw new Error(`Unknown orchestration issue: ${issueId}`);
  }
  const backendId =
    (asString(args.backendId) as AgentBackendId | undefined) ??
    current.board.settings.defaultChildBackendId ??
    "cesium-agent";
  const modelId =
    asString(args.modelId) ??
    current.board.settings.defaultModelByBackend[backendId] ??
    (backendId === ctx.conversation.config.backendId
      ? ctx.conversation.config.modelId
      : undefined);
  const modelName =
    modelId === ctx.conversation.config.modelId
      ? ctx.conversation.config.modelName
      : undefined;
  const { agentRuntimeManager } = await import("../../runtime-manager.js");
  const promptText = [
    `You are assigned to orchestration issue "${issue.title}".`,
    "",
    issue.description ? `Description:\n${issue.description}` : "",
    issue.acceptanceCriteria.length
      ? `Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : "",
    "",
    "Manager instructions:",
    instructions,
    "",
    "Work end-to-end, verify your result, and report blockers clearly.",
  ]
    .filter(Boolean)
    .join("\n");
  const childSnapshot = await agentRuntimeManager.createConversationWithPrompt(
    ctx.workspace,
    {
      title: asString(args.title) ?? `Issue: ${issue.title}`,
      archived: true,
      backendId,
      mode: "agent",
      ...(modelId ? { modelId } : {}),
      ...(modelName ? { modelName } : {}),
    },
    { text: promptText }
  );
  const child = childSnapshot.conversation;
  const permissionPolicy = asOrchestrationPermissionPolicy(args.permissions);
  const assignment: OrchestrationAssignmentRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    boardId: current.board.id,
    issueId,
    conversationId: child.id,
    role: asString(args.role) ?? "implementation",
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { ...child.config, permissionPolicy },
    lastKnownConversationStatus: child.status,
  };
  // The child's whole first turn is news for the head, even if it ends before the assignment is saved.
  await markChildReported(child.id, 0, { quiet: false });
  await upsertOrchestrationAssignment(
    current.board.id,
    assignment,
    { type: "head_agent", conversationId: ctx.conversationId }
  );
  return safeJson({ assignment, childConversation: child });
}

export async function orchestrationUpdateAgentPermissionsTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveCurrentOrchestrationBoard(ctx);
  const assignmentId = asString(args.assignmentId);
  const conversationId = asString(args.conversationId);
  if (!assignmentId && !conversationId) {
    throw new Error(
      "orchestration_update_agent_permissions requires assignmentId or conversationId."
    );
  }
  const assignment = current.assignments.find((candidate) =>
    assignmentId
      ? candidate.id === assignmentId
      : candidate.conversationId === conversationId
  );
  if (!assignment) {
    throw new Error(
      `Unknown orchestration assignment: ${assignmentId ?? conversationId}`
    );
  }
  const requestedPermissions = asRecord(args.permissions);
  const existingPolicy = assignment.config.permissionPolicy;
  const permissionPolicy: OrchestrationAssignmentPermissionPolicy = {
    editFile:
      asOrchestrationPermissionDecision(requestedPermissions?.editFile) ??
      existingPolicy?.editFile ??
      "allow",
    terminal:
      asOrchestrationPermissionDecision(requestedPermissions?.terminal) ??
      existingPolicy?.terminal ??
      "allow",
    mcpCall:
      asOrchestrationPermissionDecision(requestedPermissions?.mcpCall) ??
      existingPolicy?.mcpCall ??
      "allow",
  };
  const nextAssignment: OrchestrationAssignmentRecord = {
    ...assignment,
    config: {
      ...assignment.config,
      permissionPolicy,
    },
  };
  const snapshot = await upsertOrchestrationAssignment(
    current.board.id,
    nextAssignment,
    { type: "head_agent", conversationId: ctx.conversationId }
  );
  return safeJson({
    assignment: snapshot.assignments.find(
      (candidate) => candidate.id === assignment.id
    ),
  });
}

export async function orchestrationControlAgentTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>): Promise<string> {
  const current = await resolveCurrentOrchestrationBoard(ctx);
  const action = asOrchestrationControlAction(args.action);
  if (!action) {
    throw new Error("orchestration_control_agent requires action.");
  }
  const assignmentId = asString(args.assignmentId);
  const conversationId = asString(args.conversationId);
  if (!assignmentId && !conversationId) {
    throw new Error("orchestration_control_agent requires assignmentId or conversationId.");
  }
  const assignment = current.assignments.find((candidate) =>
    assignmentId
      ? candidate.id === assignmentId
      : candidate.conversationId === conversationId
  );
  if (!assignment) {
    throw new Error(`Unknown orchestration assignment: ${assignmentId ?? conversationId}`);
  }
  const issue = current.issues.find((candidate) => candidate.id === assignment.issueId);
  const reason = asString(args.reason);
  const instructions = asString(args.instructions);
  const resumeAfterSteer = args.resumeAfterSteer === true;
  const { agentRuntimeManager } = await import("../../runtime-manager.js");

  let nextAssignmentStatus: OrchestrationAssignmentStatus = assignment.status;
  let childConversationStatus: AgentConversationStatus | null =
    assignment.lastKnownConversationStatus;
  let message: string;

  switch (action) {
    case "pause": {
      const conversation = await agentRuntimeManager.pauseConversation(
        ctx.workspace,
        assignment.conversationId
      );
      nextAssignmentStatus = "waiting";
      childConversationStatus = conversation.status;
      message = `Paused child agent ${assignment.conversationId}${
        reason ? `: ${reason}` : "."
      }`;
      break;
    }
    case "resume": {
      const conversation = await agentRuntimeManager.resumeConversation(
        ctx.workspace,
        assignment.conversationId
      );
      nextAssignmentStatus = "running";
      childConversationStatus = conversation.status;
      message = `Resumed child agent ${assignment.conversationId}${
        reason ? `: ${reason}` : "."
      }`;
      break;
    }
    case "stop": {
      await markChildReported(assignment.conversationId, 0, { quiet: true });
      const conversation = await agentRuntimeManager.cancelConversation(
        ctx.workspace,
        assignment.conversationId
      );
      nextAssignmentStatus = "cancelled";
      childConversationStatus = conversation.status;
      await markChildReported(conversation.id, conversation.lastEventSeq, { quiet: true });
      message = `Stopped child agent ${assignment.conversationId}${
        reason ? `: ${reason}` : "."
      }`;
      break;
    }
    case "steer": {
      if (!instructions) {
        throw new Error("orchestration_control_agent steer requires instructions.");
      }
      const steerText = [
        issue ? `Steering update for orchestration issue "${issue.title}".` : "Steering update.",
        reason ? `Reason: ${reason}` : "",
        "",
        instructions,
      ]
        .filter(Boolean)
        .join("\n");
      const snapshot = await agentRuntimeManager.promptConversation(
        ctx.workspace,
        assignment.conversationId,
        steerText,
        undefined,
        { delivery: "steer" }
      );
      if (resumeAfterSteer) {
        try {
          const conversation = await agentRuntimeManager.resumeConversation(
            ctx.workspace,
            assignment.conversationId
          );
          childConversationStatus = conversation.status;
          nextAssignmentStatus = "running";
        } catch {
          childConversationStatus = snapshot.conversation.status;
          nextAssignmentStatus =
            snapshot.conversation.status === "paused" ? "waiting" : "running";
        }
      } else {
        childConversationStatus = snapshot.conversation.status;
        nextAssignmentStatus =
          snapshot.conversation.status === "paused" ? "waiting" : "running";
      }
      message = `Steered child agent ${assignment.conversationId}${
        reason ? `: ${reason}` : "."
      }`;
      break;
    }
  }

  const commented = await addOrchestrationComment({
    boardId: current.board.id,
    issueId: assignment.issueId,
    actor: { type: "head_agent", conversationId: ctx.conversationId },
    message,
  });
  const updated = await upsertOrchestrationAssignment(
    current.board.id,
    {
      ...assignment,
      status: nextAssignmentStatus,
      lastKnownConversationStatus: childConversationStatus,
    },
    { type: "head_agent", conversationId: ctx.conversationId }
  );
  return safeJson({
    action,
    message,
    assignment:
      updated.assignments.find((candidate) => candidate.id === assignment.id) ??
      commented.assignments.find((candidate) => candidate.id === assignment.id) ??
      null,
  });
}

export async function orchestrationReadAgentTranscriptTool(
  ctx: CesiumToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const current = await resolveCurrentOrchestrationBoard(ctx);
  const assignmentId = asString(args.assignmentId);
  const conversationId = asString(args.conversationId);
  if (!assignmentId && !conversationId) {
    throw new Error(
      "orchestration_read_agent_transcript requires assignmentId or conversationId."
    );
  }
  const assignment = current.assignments.find((candidate) =>
    assignmentId
      ? candidate.id === assignmentId
      : candidate.conversationId === conversationId
  );
  if (!assignment) {
    throw new Error(`Unknown orchestration assignment: ${assignmentId ?? conversationId}`);
  }
  const issue = current.issues.find((candidate) => candidate.id === assignment.issueId);
  const { agentRuntimeManager } = await import("../../runtime-manager.js");
  const limitEvents = Math.max(1, Math.min(200, Math.floor(asNumber(args.limitEvents) ?? 80)));
  const limitTurns = Math.max(1, Math.min(100, Math.floor(asNumber(args.limitTurns) ?? 25)));
  const beforeSeq = Math.floor(asNumber(args.beforeSeq) ?? Number.MAX_SAFE_INTEGER);
  const head = await agentRuntimeManager.getConversationSnapshotHead(
    ctx.workspace,
    assignment.conversationId,
    { limitEvents, limitTurns }
  );
  if (!head) {
    return `No conversation found for child agent ${assignment.conversationId}.`;
  }
  const events = head.events.filter((event) => event.seq < beforeSeq);
  const header = [
    "Kanban child agent transcript",
    `Assignment: ${assignment.id}`,
    `Conversation: ${assignment.conversationId}`,
    issue ? `Issue: ${issue.title} (${issue.id})` : `Issue: ${assignment.issueId}`,
    `Assignment status: ${assignment.status}`,
    `Conversation status: ${head.conversation.status}`,
    head.conversation.lastError ? `Last error: ${head.conversation.lastError}` : null,
    head.window.hasOlder
      ? `Older events available before seq ${head.window.oldestSeq}. Pass beforeSeq=${head.window.oldestSeq} to load more.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  if (events.length === 0) {
    return `${header}\n\nNo transcript events in this page.`;
  }
  return `${header}\n\n${generateTranscriptFromEvents(events).trim()}`;
}
