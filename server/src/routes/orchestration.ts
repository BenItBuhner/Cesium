import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { agentRuntimeManager } from "../lib/agents/runtime-manager.js";
import { listAgentBackendsWithCache } from "../lib/agents/providers.js";
import type {
  AgentConversationConfig,
  AgentConversationStatus,
} from "../lib/agents/types.js";
import {
  addOrchestrationComment,
  createOrchestrationBoard,
  createOrchestrationIssue,
  deleteOrchestrationBoard,
  deleteOrchestrationIssue,
  listOrchestrationBoards,
  readOrchestrationBoardSnapshot,
  mutateOrchestrationBoardSnapshot,
  upsertOrchestrationAssignment,
  upsertOrchestrationIssue,
} from "../lib/orchestration/store.js";
import type {
  OrchestrationAssignmentRecord,
  OrchestrationBoardSnapshot,
  OrchestrationColumnId,
  OrchestrationIssueRecord,
  OrchestrationIssuePriority,
} from "../lib/orchestration/types.js";
import type { WorkspaceRecord } from "../lib/workspace-registry.js";

export const orchestrationRoutes = new Hono();

const NON_NOTIFYABLE_ASSIGNMENT_STATUSES = new Set(["cancelled"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asColumnId(value: unknown): OrchestrationColumnId | undefined {
  return value === "backlog" ||
    value === "ready" ||
    value === "in_progress" ||
    value === "review" ||
    value === "blocked" ||
    value === "done"
    ? value
    : undefined;
}

function asPriority(value: unknown): OrchestrationIssuePriority | undefined {
  return value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "urgent"
    ? value
    : undefined;
}

function notifyIssueAssignments(input: {
  workspace: WorkspaceRecord;
  snapshot: OrchestrationBoardSnapshot;
  issueId: string;
  message: string;
}): void {
  const assignments = input.snapshot.assignments.filter(
    (assignment) =>
      assignment.issueId === input.issueId &&
      !NON_NOTIFYABLE_ASSIGNMENT_STATUSES.has(assignment.status)
  );
  for (const assignment of assignments) {
    void agentRuntimeManager
      .promptConversation(
        input.workspace,
        assignment.conversationId,
        input.message,
        undefined,
        { delivery: "steer" }
      )
      .catch((error) => {
        console.warn("[orchestration] assignment notification failed:", error);
      });
  }
}

orchestrationRoutes.get("/api/orchestration/boards", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  return c.json(await listOrchestrationBoards(workspace.id));
});

orchestrationRoutes.post("/api/orchestration/boards", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    title?: unknown;
    description?: unknown;
    headConversationId?: unknown;
  }>();
  const backends = await listAgentBackendsWithCache();
  const allowedBackendIds = backends.map((backend) => backend.id);
  const snapshot = await createOrchestrationBoard({
    workspace,
    title: asString(body.title),
    description: asString(body.description),
    headConversationId: asString(body.headConversationId) ?? null,
    allowedBackendIds,
  });
  return c.json({ snapshot }, 201);
});

orchestrationRoutes.post("/api/orchestration/start", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    title?: unknown;
    description?: unknown;
    prompt?: unknown;
  }>();
  const title = asString(body.title) ?? "Orchestration Mode";
  const backends = await listAgentBackendsWithCache();
  const cesium = backends.find((backend) => backend.id === "cesium-agent");
  const headConversation = await agentRuntimeManager.createConversation(workspace, {
    title,
    backendId: "cesium-agent",
    mode: "orchestration",
    ...(cesium?.defaultModelId
      ? { modelId: cesium.defaultModelId, modelName: cesium.defaultModelName }
      : {}),
  });
  const snapshot = await createOrchestrationBoard({
    workspace,
    title,
    description: asString(body.description),
    headConversationId: headConversation.id,
    allowedBackendIds: backends.map((backend) => backend.id),
  });
  const prompt = asString(body.prompt);
  if (prompt) {
    void agentRuntimeManager
      .promptConversation(workspace, headConversation.id, prompt)
      .catch((error) => {
        console.warn("[orchestration] failed to prompt head conversation:", error);
      });
  }
  return c.json({ snapshot, headConversation }, 201);
});

orchestrationRoutes.get("/api/orchestration/boards/:boardId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const boardId = c.req.param("boardId");
  const snapshot = await readOrchestrationBoardSnapshot(boardId);
  if (!snapshot || snapshot.board.workspaceId !== workspace.id) {
    return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
  }
  return c.json({ snapshot });
});

orchestrationRoutes.patch("/api/orchestration/boards/:boardId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const boardId = c.req.param("boardId");
  const body = await c.req.json<{
    title?: unknown;
    description?: unknown;
    headConversationId?: unknown;
    archived?: unknown;
  }>();
  const current = await readOrchestrationBoardSnapshot(boardId);
  if (!current || current.board.workspaceId !== workspace.id) {
    return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
  }
  const now = Date.now();
  const snapshot = await mutateOrchestrationBoardSnapshot(boardId, (existing) => ({
    ...existing,
    board: {
      ...existing.board,
      title: asString(body.title) ?? existing.board.title,
      description:
        typeof body.description === "string"
          ? body.description
          : existing.board.description,
      headConversationId:
        typeof body.headConversationId === "string"
          ? body.headConversationId
          : body.headConversationId === null
            ? null
            : existing.board.headConversationId,
      archivedAt:
        typeof body.archived === "boolean"
          ? body.archived
            ? now
            : null
          : existing.board.archivedAt,
      updatedAt: now,
    },
  }));
  return c.json({ snapshot });
});

orchestrationRoutes.delete("/api/orchestration/boards/:boardId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const boardId = c.req.param("boardId");
  const snapshot = await readOrchestrationBoardSnapshot(boardId);
  if (!snapshot || snapshot.board.workspaceId !== workspace.id) {
    return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
  }
  await deleteOrchestrationBoard(boardId);
  return c.json({ ok: true });
});

orchestrationRoutes.post("/api/orchestration/boards/:boardId/issues", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const boardId = c.req.param("boardId");
  const current = await readOrchestrationBoardSnapshot(boardId);
  if (!current || current.board.workspaceId !== workspace.id) {
    return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
  }
  const body = await c.req.json<{
    title?: unknown;
    description?: unknown;
    columnId?: unknown;
    priority?: unknown;
    acceptanceCriteria?: unknown;
    blockedReason?: unknown;
    blockerExplanation?: unknown;
  }>();
  const title = asString(body.title);
  if (!title) {
    return c.json({ error: "Issue title is required." }, 400);
  }
  const columnId = asColumnId(body.columnId);
  if (body.columnId !== undefined && !columnId) {
    return c.json({ error: "Invalid issue column." }, 400);
  }
  const priority = asPriority(body.priority);
  if (body.priority !== undefined && !priority) {
    return c.json({ error: "Invalid issue priority." }, 400);
  }
  const blockedReason = asString(body.blockerExplanation) ?? asString(body.blockedReason);
  if (columnId === "blocked" && !blockedReason) {
    return c.json({ error: "A blocker explanation is required for blocked issues." }, 400);
  }
  const snapshot = await createOrchestrationIssue({
    boardId,
    title,
    description: typeof body.description === "string" ? body.description : undefined,
    columnId,
    priority,
    acceptanceCriteria: asStringArray(body.acceptanceCriteria),
    blockedReason,
  });
  return c.json({ snapshot }, 201);
});

orchestrationRoutes.patch(
  "/api/orchestration/boards/:boardId/issues/:issueId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const boardId = c.req.param("boardId");
    const issueId = c.req.param("issueId");
    const current = await readOrchestrationBoardSnapshot(boardId);
    if (!current || current.board.workspaceId !== workspace.id) {
      return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const existingIssue = current.issues.find((candidate) => candidate.id === issueId);
    if (!existingIssue) {
      return c.json({ error: `Unknown issue: ${issueId}` }, 404);
    }
    const columnId = asColumnId(body.columnId);
    if (body.columnId !== undefined && !columnId) {
      return c.json({ error: "Invalid issue column." }, 400);
    }
    const priority = asPriority(body.priority);
    if (body.priority !== undefined && !priority) {
      return c.json({ error: "Invalid issue priority." }, 400);
    }
    if (body.title !== undefined && !asString(body.title)) {
      return c.json({ error: "Issue title cannot be empty." }, 400);
    }
    const blockerExplanation =
      body.blockerExplanation === null
        ? null
        : asString(body.blockerExplanation) ??
          (body.blockedReason === null ? null : asString(body.blockedReason));
    const effectiveBlockedReason =
      blockerExplanation !== undefined ? blockerExplanation : existingIssue.blockedReason;
    if ((columnId ?? existingIssue.columnId) === "blocked" && !effectiveBlockedReason) {
      return c.json({ error: "A blocker explanation is required when blocking an issue." }, 400);
    }
    const patch: Partial<OrchestrationIssueRecord> & { id: string } = {
      id: issueId,
      ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
      ...(typeof body.description === "string"
        ? { description: body.description }
        : {}),
      ...(columnId ? { columnId } : {}),
      ...(priority ? { priority } : {}),
      ...(typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
        ? { sortOrder: body.sortOrder }
        : {}),
      ...(Array.isArray(body.acceptanceCriteria)
        ? { acceptanceCriteria: asStringArray(body.acceptanceCriteria) }
        : {}),
      ...(Array.isArray(body.dependencyIssueIds)
        ? { dependencyIssueIds: asStringArray(body.dependencyIssueIds) }
        : {}),
      ...(blockerExplanation !== undefined
        ? { blockedReason: blockerExplanation }
        : {}),
    };
    const snapshot = await upsertOrchestrationIssue(boardId, patch);
    const issue = snapshot.issues.find((candidate) => candidate.id === issueId);
    notifyIssueAssignments({
      workspace,
      snapshot,
      issueId,
      message: [
        `The orchestration issue "${issue?.title ?? issueId}" was updated by the user on the Kanban board.`,
        typeof patch.title === "string" ? `New title: ${patch.title}` : "",
        typeof patch.description === "string" ? `New description:\n${patch.description}` : "",
        patch.columnId ? `Current column: ${patch.columnId}` : "",
        patch.blockedReason ? `Blocked reason: ${patch.blockedReason}` : "",
        "Adjust your work to match the current issue state and comment back if this changes your plan.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return c.json({ snapshot });
  }
);

orchestrationRoutes.delete(
  "/api/orchestration/boards/:boardId/issues/:issueId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const boardId = c.req.param("boardId");
    const issueId = c.req.param("issueId");
    const current = await readOrchestrationBoardSnapshot(boardId);
    if (!current || current.board.workspaceId !== workspace.id) {
      return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
    }
    const issue = current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      return c.json({ error: `Unknown issue: ${issueId}` }, 404);
    }
    notifyIssueAssignments({
      workspace,
      snapshot: current,
      issueId,
      message: `The orchestration issue "${issue.title}" was deleted from the Kanban board. Stop work on that issue and wait for further steering if needed.`,
    });
    await Promise.all(
      current.assignments
        .filter(
          (assignment) =>
            assignment.issueId === issueId &&
            assignment.status !== "completed" &&
            assignment.status !== "failed" &&
            assignment.status !== "cancelled"
        )
        .map((assignment) =>
          agentRuntimeManager
            .cancelConversation(workspace, assignment.conversationId)
            .catch(() => undefined)
        )
    );
    const snapshot = await deleteOrchestrationIssue(boardId, issueId);
    return c.json({ snapshot });
  }
);

orchestrationRoutes.post(
  "/api/orchestration/boards/:boardId/issues/:issueId/comments",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const boardId = c.req.param("boardId");
    const issueId = c.req.param("issueId");
    const current = await readOrchestrationBoardSnapshot(boardId);
    if (!current || current.board.workspaceId !== workspace.id) {
      return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
    }
    const body = await c.req.json<{ message?: unknown }>();
    const message = asString(body.message);
    if (!message) {
      return c.json({ error: "Comment message is required." }, 400);
    }
    const snapshot = await addOrchestrationComment({ boardId, issueId, message });
    const issue = snapshot.issues.find((candidate) => candidate.id === issueId);
    notifyIssueAssignments({
      workspace,
      snapshot,
      issueId,
      message: [
        `New Kanban comment on issue "${issue?.title ?? issueId}":`,
        message,
        "Treat this as steering from the orchestration board and adjust your work if relevant.",
      ].join("\n\n"),
    });
    return c.json({ snapshot }, 201);
  }
);

orchestrationRoutes.post(
  "/api/orchestration/boards/:boardId/issues/:issueId/assignments",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const boardId = c.req.param("boardId");
    const issueId = c.req.param("issueId");
    const current = await readOrchestrationBoardSnapshot(boardId);
    if (!current || current.board.workspaceId !== workspace.id) {
      return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
    }
    const body = await c.req.json<{
      conversationId?: unknown;
      role?: unknown;
      status?: unknown;
      config?: unknown;
      lastKnownConversationStatus?: unknown;
    }>();
    const conversationId = asString(body.conversationId);
    if (!conversationId) {
      return c.json({ error: "conversationId is required." }, 400);
    }
    const now = Date.now();
    const assignment: OrchestrationAssignmentRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      boardId,
      issueId,
      conversationId,
      role: asString(body.role) ?? "implementation",
      status:
        body.status === "running" ||
        body.status === "waiting" ||
        body.status === "blocked" ||
        body.status === "reviewing" ||
        body.status === "completed" ||
        body.status === "failed" ||
        body.status === "cancelled"
          ? body.status
          : "assigned",
      createdAt: now,
      updatedAt: now,
      config:
        body.config && typeof body.config === "object" && !Array.isArray(body.config)
          ? (body.config as Partial<AgentConversationConfig>)
          : {},
      lastKnownConversationStatus:
        typeof body.lastKnownConversationStatus === "string"
          ? (body.lastKnownConversationStatus as AgentConversationStatus)
          : null,
    };
    const snapshot = await upsertOrchestrationAssignment(boardId, assignment);
    return c.json({ snapshot }, 201);
  }
);

orchestrationRoutes.patch(
  "/api/orchestration/boards/:boardId/assignments/:assignmentId",
  async (c) => {
    const workspace = await requireWorkspaceFromRequest(c);
    const boardId = c.req.param("boardId");
    const assignmentId = c.req.param("assignmentId");
    const current = await readOrchestrationBoardSnapshot(boardId);
    if (!current || current.board.workspaceId !== workspace.id) {
      return c.json({ error: `Unknown orchestration board: ${boardId}` }, 404);
    }
    const existing = current.assignments.find((assignment) => assignment.id === assignmentId);
    if (!existing) {
      return c.json({ error: `Unknown assignment: ${assignmentId}` }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const assignment: OrchestrationAssignmentRecord = {
      ...existing,
      role: asString(body.role) ?? existing.role,
      status:
        body.status === "assigned" ||
        body.status === "running" ||
        body.status === "waiting" ||
        body.status === "blocked" ||
        body.status === "reviewing" ||
        body.status === "completed" ||
        body.status === "failed" ||
        body.status === "cancelled"
          ? body.status
          : existing.status,
      config:
        body.config && typeof body.config === "object" && !Array.isArray(body.config)
          ? (body.config as Partial<AgentConversationConfig>)
          : existing.config,
      lastKnownConversationStatus:
        typeof body.lastKnownConversationStatus === "string"
          ? (body.lastKnownConversationStatus as AgentConversationStatus)
          : existing.lastKnownConversationStatus,
    };
    const snapshot = await upsertOrchestrationAssignment(boardId, assignment);
    return c.json({ snapshot });
  }
);
