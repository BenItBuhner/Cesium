import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  availableDriverKinds,
  bootstrapFixtureEnv,
  createFixture,
} from "./helpers/storage-fixture.js";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";
import type { OrchestrationBoardSnapshot } from "../src/lib/orchestration/types.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

function makeWorkspace(): WorkspaceRecord {
  const now = Date.now();
  return {
    id: `ws-${randomUUID().slice(0, 8)}`,
    name: "Orchestration Test",
    root: `/tmp/orchestration-${randomUUID().slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

function makeConversation(
  workspaceId: string,
  id = `conv-${randomUUID().slice(0, 8)}`
): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    workspaceId,
    title: "Child worker",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 1,
    status: "idle",
    config: {
      backendId: "cesium-agent",
      mode: "agent",
      modelId: "test-model",
      modelName: "Test Model",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: {
      supportsLoadSession: true,
      supportsModeSelection: true,
      supportsModelSelection: true,
      supportsSlashCommands: true,
      supportsPermissions: true,
      supportsToolCalls: true,
      supportsStructuredPlans: true,
      supportsTodos: true,
      supportsSessionResume: true,
      supportsPromptImages: true,
      supportsInlineReasoning: true,
      supportsCompletionRetry: true,
    },
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
}

for (const kind of availableDriverKinds()) {
  test(`orchestration storage[${kind}]: snapshot round trip`, async () => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    try {
      const workspace = makeWorkspace();
      await fixture.driver.upsertWorkspace(workspace);
      const now = Date.now();
      const snapshot: OrchestrationBoardSnapshot = {
        board: {
          schemaVersion: 1,
          id: `board-${randomUUID().slice(0, 8)}`,
          workspaceId: workspace.id,
          title: "Launch",
          description: "Massive task board",
          headConversationId: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settings: {
            allowedBackendIds: ["cesium-agent"],
            defaultChildBackendId: "cesium-agent",
            defaultModelByBackend: {},
            maxConcurrentIssues: null,
            maxConcurrentAgents: 3,
            userQuestionTimeoutMs: 600_000,
            mcpEnabled: true,
          },
        },
        issues: [
          {
            schemaVersion: 1,
            id: `issue-${randomUUID().slice(0, 8)}`,
            boardId: "",
            title: "Build board",
            description: "Create kanban shell",
            columnId: "ready",
            priority: "high",
            sortOrder: 1000,
            acceptanceCriteria: ["Board opens in editor"],
            dependencyIssueIds: [],
            blockedReason: null,
            verification: { status: "unchecked" },
            createdAt: now,
            updatedAt: now,
            completedAt: null,
          },
        ],
        assignments: [],
        events: [
          {
            schemaVersion: 1,
            id: `event-${randomUUID().slice(0, 8)}`,
            boardId: "",
            issueId: null,
            assignmentId: null,
            kind: "board_created",
            actor: { type: "system" },
            message: "Created board.",
            payload: {},
            createdAt: now,
          },
        ],
      };
      snapshot.issues[0]!.boardId = snapshot.board.id;
      snapshot.events[0]!.boardId = snapshot.board.id;

      await fixture.driver.saveOrchestrationBoardSnapshot(snapshot);
      const list = await fixture.driver.listOrchestrationBoards(workspace.id);
      assert.equal(list.boards.length, 1);
      assert.equal(list.boards[0]!.title, "Launch");

      const loaded = await fixture.driver.getOrchestrationBoardSnapshot(snapshot.board.id);
      assert.ok(loaded);
      assert.equal(loaded.board.settings.maxConcurrentAgents, 3);
      assert.equal(loaded.issues[0]!.acceptanceCriteria[0], "Board opens in editor");
      assert.equal(loaded.events[0]!.kind, "board_created");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`orchestration storage[${kind}]: resolves missing head board links`, async () => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    const [{ __setStorageForTesting }, store] = await Promise.all([
      import("../src/storage/runtime.js"),
      import("../src/lib/orchestration/store.js"),
    ]);
    __setStorageForTesting(fixture.driver);
    try {
      const workspace = makeWorkspace();
      await fixture.driver.upsertWorkspace(workspace);
      const unlinked = await store.createOrchestrationBoard({
        workspace,
        title: "Recovered Board",
        headConversationId: null,
        allowedBackendIds: ["cesium-agent"],
      });

      const resolved = await store.resolveOrCreateOrchestrationBoardForHeadConversation({
        workspace,
        conversationId: "head-1",
        title: "Should reuse",
        allowedBackendIds: ["cesium-agent"],
      });

      assert.equal(resolved.board.id, unlinked.board.id);
      assert.equal(resolved.board.headConversationId, "head-1");

      const second = await store.resolveOrCreateOrchestrationBoardForHeadConversation({
        workspace,
        conversationId: "head-2",
        title: "New Board",
        allowedBackendIds: ["cesium-agent"],
      });

      assert.notEqual(second.board.id, resolved.board.id);
      assert.equal(second.board.headConversationId, "head-2");
    } finally {
      __setStorageForTesting(null);
      await fixture.cleanup();
    }
  });

  test(`orchestration storage[${kind}]: detects active board work`, async () => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    const [{ __setStorageForTesting }, store] = await Promise.all([
      import("../src/storage/runtime.js"),
      import("../src/lib/orchestration/store.js"),
    ]);
    __setStorageForTesting(fixture.driver);
    try {
      const workspace = makeWorkspace();
      await fixture.driver.upsertWorkspace(workspace);
      const empty = await store.createOrchestrationBoard({
        workspace,
        title: "Empty",
        headConversationId: "head-empty",
        allowedBackendIds: ["cesium-agent"],
      });
      assert.equal(store.orchestrationBoardHasActiveWork(empty), false);
      assert.equal(
        store.orchestrationBoardNeedsManagement(empty, { includeEmptyBoard: true }),
        true
      );

      const active = await store.createOrchestrationIssue({
        boardId: empty.board.id,
        title: "Still running",
        columnId: "in_progress",
      });
      assert.equal(store.orchestrationBoardHasActiveWork(active), true);
    } finally {
      __setStorageForTesting(null);
      await fixture.cleanup();
    }
  });

  test(`orchestration storage[${kind}]: requires and clears blocker explanations`, async () => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    const [{ __setStorageForTesting }, store] = await Promise.all([
      import("../src/storage/runtime.js"),
      import("../src/lib/orchestration/store.js"),
    ]);
    __setStorageForTesting(fixture.driver);
    try {
      const workspace = makeWorkspace();
      await fixture.driver.upsertWorkspace(workspace);
      const board = await store.createOrchestrationBoard({
        workspace,
        title: "Blockers",
        headConversationId: "head-blockers",
        allowedBackendIds: ["cesium-agent"],
      });
      const created = await store.createOrchestrationIssue({
        boardId: board.board.id,
        title: "Needs credentials",
        columnId: "in_progress",
      });
      const issue = created.issues[0]!;

      await assert.rejects(
        () =>
          store.upsertOrchestrationIssue(board.board.id, {
            id: issue.id,
            columnId: "blocked",
          }),
        /blocker explanation is required/i
      );

      const blocked = await store.upsertOrchestrationIssue(board.board.id, {
        id: issue.id,
        columnId: "blocked",
        blockedReason: "Waiting for a test account.",
      });
      assert.equal(blocked.issues[0]!.blockedReason, "Waiting for a test account.");

      const resumed = await store.upsertOrchestrationIssue(board.board.id, {
        id: issue.id,
        columnId: "in_progress",
      });
      assert.equal(resumed.issues[0]!.blockedReason, null);
    } finally {
      __setStorageForTesting(null);
      await fixture.cleanup();
    }
  });

  test(`orchestration storage[${kind}]: finds child assignment conversations`, async () => {
    bootstrapFixtureEnv(kind);
    const fixture = await createFixture(kind);
    const [{ __setStorageForTesting }, store] = await Promise.all([
      import("../src/storage/runtime.js"),
      import("../src/lib/orchestration/store.js"),
    ]);
    __setStorageForTesting(fixture.driver);
    try {
      const workspace = makeWorkspace();
      await fixture.driver.upsertWorkspace(workspace);
      const child = makeConversation(workspace.id);
      await fixture.driver.upsertAgentConversation(child);
      const board = await store.createOrchestrationBoard({
        workspace,
        title: "Hidden Children",
        headConversationId: "head-hidden",
        allowedBackendIds: ["cesium-agent"],
      });
      const withIssue = await store.createOrchestrationIssue({
        boardId: board.board.id,
        title: "Do child work",
        columnId: "in_progress",
      });
      const issue = withIssue.issues[0]!;

      await store.upsertOrchestrationAssignment(
        board.board.id,
        {
          schemaVersion: 1,
          id: `assignment-${randomUUID().slice(0, 8)}`,
          boardId: board.board.id,
          issueId: issue.id,
          conversationId: child.id,
          role: "worker",
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          config: {
            ...child.config,
            permissionPolicy: {
              editFile: "allow",
              terminal: "ask",
              mcpCall: "deny",
            },
          },
          lastKnownConversationStatus: child.status,
        }
      );

      const childIds = await store.listOrchestrationChildConversationIds(workspace.id);
      assert.equal(childIds.has(child.id), true);
      const assignment = await store.findOrchestrationAssignmentForConversation(
        workspace.id,
        child.id
      );
      assert.equal(assignment?.config.permissionPolicy?.terminal, "ask");
      assert.equal(assignment?.config.permissionPolicy?.mcpCall, "deny");
    } finally {
      __setStorageForTesting(null);
      await fixture.cleanup();
    }
  });
}
