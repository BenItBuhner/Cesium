import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentBackendId,
  AgentConversationGroup,
  AgentConversationMode,
  AgentConversationRecord,
  AgentProviderCapabilities,
} from "../src/lib/agent-types";
import {
  patchAgentConversationGroups,
  patchAgentConversationSummaryInGroups,
} from "../src/lib/agent-rail-patch";
import type { WorkspaceRecord } from "../src/lib/types";

const backendId = "cursor-sdk" as AgentBackendId;
const mode = "agent" as AgentConversationMode;

const testCaps: AgentProviderCapabilities = {
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
  supportsCompletionRetry: false,
};

function baseRecord(
  id: string,
  workspaceId: string,
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id,
    workspaceId,
    title: `t-${id}`,
    createdAt: 100,
    updatedAt: 200,
    lastEventSeq: 1,
    status: "idle",
    config: { backendId, mode, modelId: "m", modelName: "M" },
    providerSessionId: null,
    configOptions: [],
    capabilities: testCaps,
    pendingPermission: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    ...overrides,
  };
}

function group(
  wsId: string,
  conversations: AgentConversationRecord[],
  serverId?: string
): AgentConversationGroup {
  const workspace: WorkspaceRecord = {
    id: wsId,
    name: "W",
    root: "/tmp",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
  return {
    workspace,
    serverId,
    serverLabel: serverId,
    workspaceKey: serverId ? `${serverId}:${wsId}` : undefined,
    conversations: conversations.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastEventSeq: c.lastEventSeq,
      status: c.status,
      archivedAt: c.archivedAt ?? null,
      backendId: c.config.backendId,
      mode: c.config.mode,
      experimental: c.experimental,
      hasPendingPermission: c.pendingPermission != null,
    })),
  };
}

describe("patchAgentConversationGroups", () => {
  test("same updatedAt: status-only patch preserves row order", () => {
    const ws = "ws1";
    const a = baseRecord("a", ws, { updatedAt: 300, title: "A", createdAt: 10 });
    const b = baseRecord("b", ws, { updatedAt: 300, title: "B", createdAt: 20 });
    const groups = [group(ws, [a, b])];
    const bRunning = { ...b, status: "running" as const };
    const next = patchAgentConversationGroups(groups, bRunning);
    const ids = next[0]!.conversations.map((c) => c.id);
    assert.deepEqual(ids, ["a", "b"]);
    assert.equal(next[0]!.conversations[1]!.status, "running");
  });

  test("same updatedAt: rename preserves order (stable tie-break, not title)", () => {
    const ws = "ws1";
    const a = baseRecord("a", ws, { updatedAt: 400, title: "Zebra", createdAt: 10 });
    const b = baseRecord("b", ws, { updatedAt: 400, title: "Apple", createdAt: 20 });
    const groups = [group(ws, [a, b])];
    const bRenamed = { ...b, title: "Banana" };
    const next = patchAgentConversationGroups(groups, bRenamed);
    const ids = next[0]!.conversations.map((c) => c.id);
    assert.deepEqual(ids, ["a", "b"]);
    assert.equal(next[0]!.conversations[1]!.title, "Banana");
  });

  test("updatedAt bump: re-sorts by recency", () => {
    const ws = "ws1";
    const a = baseRecord("a", ws, { updatedAt: 500, createdAt: 10 });
    const b = baseRecord("b", ws, { updatedAt: 400, createdAt: 20 });
    const groups = [group(ws, [a, b])];
    const bNewer = { ...b, updatedAt: 600, lastEventSeq: 2 };
    const next = patchAgentConversationGroups(groups, bNewer);
    const ids = next[0]!.conversations.map((c) => c.id);
    assert.deepEqual(ids, ["b", "a"]);
  });

  test("stale updatedAt patch cannot demote a newer row", () => {
    const ws = "ws1";
    const a = baseRecord("a", ws, { updatedAt: 500, createdAt: 10 });
    const b = baseRecord("b", ws, { updatedAt: 400, createdAt: 20, status: "running" });
    const groups = [group(ws, [a, b])];
    const bOptimistic = { ...b, updatedAt: 600, lastEventSeq: 2 };
    const optimistic = patchAgentConversationGroups(groups, bOptimistic);
    const bStaleAck = { ...b, updatedAt: 450, lastEventSeq: 2, status: "idle" as const };
    const next = patchAgentConversationGroups(optimistic, bStaleAck);
    const ids = next[0]!.conversations.map((c) => c.id);
    assert.deepEqual(ids, ["b", "a"]);
    assert.equal(next[0]!.conversations[0]!.updatedAt, 600);
    assert.equal(next[0]!.conversations[0]!.status, "idle");
  });

  test("stale updatedAt patch cannot revert newer archive state", async () => {
    const { createDefaultAgentRailFilterState, matchesAgentRailFilters } = await import(
      "../src/lib/agent-rail"
    );
    const ws = "ws1";
    const restoredRecord = baseRecord("restored", ws, {
      archivedAt: 400,
      updatedAt: 400,
    });
    const archivedRecord = baseRecord("archived", ws, {
      archivedAt: null,
      updatedAt: 500,
    });
    const groups = [group(ws, [restoredRecord, archivedRecord])];
    const restoredTarget = groups[0]!.conversations.find((c) => c.id === "restored")!;
    const archivedTarget = groups[0]!.conversations.find((c) => c.id === "archived")!;

    const afterRestore = patchAgentConversationSummaryInGroups(groups, restoredTarget, {
      archivedAt: null,
      updatedAt: 1_000,
    });
    const staleRestoreAck = baseRecord("restored", ws, {
      archivedAt: 400,
      updatedAt: 400,
    });
    const afterStaleRestoreAck = patchAgentConversationGroups(afterRestore, staleRestoreAck);
    assert.equal(
      afterStaleRestoreAck[0]!.conversations.find((c) => c.id === "restored")!.archivedAt,
      null
    );

    const afterArchive = patchAgentConversationSummaryInGroups(afterStaleRestoreAck, archivedTarget, {
      archivedAt: 1_100,
      updatedAt: 1_100,
    });
    const staleArchiveAck = baseRecord("archived", ws, {
      archivedAt: null,
      lastEventSeq: 2,
      updatedAt: 500,
    });
    const next = patchAgentConversationGroups(afterArchive, staleArchiveAck);
    const restored = next[0]!.conversations.find((c) => c.id === "restored")!;
    const archived = next[0]!.conversations.find((c) => c.id === "archived")!;
    assert.equal(restored.archivedAt, null);
    assert.equal(archived.archivedAt, 1_100);

    const ctx = {
      pinnedConversationIds: new Set<string>(),
      unreadCompletionByConversationId: undefined,
    };
    const off = createDefaultAgentRailFilterState();
    const on = { ...off, archived: true };
    assert.equal(matchesAgentRailFilters(restored, off, ctx), true);
    assert.equal(matchesAgentRailFilters(archived, off, ctx), false);
    assert.equal(matchesAgentRailFilters(restored, on, ctx), false);
    assert.equal(matchesAgentRailFilters(archived, on, ctx), true);
  });

  test("placeholder new-chat records are not inserted into rail groups", () => {
    const ws = "ws1";
    const placeholder = baseRecord("draft-record", ws, {
      title: "Start New Chat",
      lastEventSeq: 0,
      status: "idle",
    });
    const next = patchAgentConversationGroups([group(ws, [])], placeholder);
    assert.deepEqual(next[0]!.conversations, []);
  });

  test("placeholder new-chat patches remove stale rail rows", () => {
    const ws = "ws1";
    const placeholder = baseRecord("draft-record", ws, {
      title: "Start a new chat",
      lastEventSeq: 0,
      status: "idle",
    });
    const next = patchAgentConversationGroups([group(ws, [placeholder])], placeholder);
    assert.deepEqual(next[0]!.conversations, []);
  });

  test("patches only the matching machine when workspace and conversation ids collide", () => {
    const shared = baseRecord("same-chat", "same-workspace");
    const next = patchAgentConversationGroups(
      [
        group("same-workspace", [shared], "laptop"),
        group("same-workspace", [shared], "desktop"),
      ],
      { ...shared, title: "Desktop title", updatedAt: 300 },
      "desktop"
    );
    assert.equal(next[0]?.conversations[0]?.title, "t-same-chat");
    assert.equal(next[1]?.conversations[0]?.title, "Desktop title");
    assert.equal(next[1]?.conversations[0]?.conversationKey, "desktop:same-chat");
  });

  test("conversation origin flows into rail summaries", () => {
    const ws = "ws1";
    const record = baseRecord("cloud-1", ws, {
      origin: {
        kind: "cloud",
        providerId: "github",
        taskId: "task-1",
        label: "owner/repo#42",
      },
    });
    const next = patchAgentConversationGroups([group(ws, [])], record);
    const summary = next[0]!.conversations[0]!;
    assert.equal(summary.origin?.kind, "cloud");
    assert.equal(summary.origin?.providerId, "github");
    assert.equal(summary.origin?.label, "owner/repo#42");
  });
});

describe("patchAgentConversationSummaryInGroups", () => {
  test("optimistically archives only the matching workspace and server row", () => {
    const shared = baseRecord("same-chat", "same-workspace");
    const laptop = group("same-workspace", [shared], "laptop");
    const desktop = group("same-workspace", [shared], "desktop");
    const target = {
      ...desktop.conversations[0]!,
      serverId: "desktop",
      conversationKey: "desktop:same-chat",
    };
    desktop.conversations[0] = target;
    laptop.conversations[0] = {
      ...laptop.conversations[0]!,
      serverId: "laptop",
      conversationKey: "laptop:same-chat",
    };

    const next = patchAgentConversationSummaryInGroups(
      [laptop, desktop],
      target,
      { archivedAt: 900, updatedAt: 900 }
    );

    assert.equal(next[0]?.conversations[0]?.archivedAt, null);
    assert.equal(next[1]?.conversations[0]?.archivedAt, 900);
    assert.equal(next[1]?.conversations[0]?.updatedAt, 900);
  });

  test("restores the exact prior archive state after a failed mutation", () => {
    const archived = baseRecord("chat", "ws", { archivedAt: 400, updatedAt: 400 });
    const groups = [group("ws", [archived], "server")];
    const target = {
      ...groups[0]!.conversations[0]!,
      serverId: "server",
    };
    const optimistic = patchAgentConversationSummaryInGroups(groups, target, {
      archivedAt: null,
      updatedAt: 800,
    });
    const rolledBack = patchAgentConversationSummaryInGroups(optimistic, target, {
      archivedAt: target.archivedAt,
      updatedAt: target.updatedAt,
    });

    assert.equal(rolledBack[0]?.conversations[0]?.archivedAt, 400);
    assert.equal(rolledBack[0]?.conversations[0]?.updatedAt, 400);
  });
});

describe("agent rail source filter", () => {
  const ctx = {
    pinnedConversationIds: new Set<string>(),
    unreadCompletionByConversationId: undefined,
  };

  test("hiding the in-app source narrows the rail to externally-triggered conversations", async () => {
    const { createDefaultAgentRailFilterState, matchesAgentRailFilters } = await import(
      "../src/lib/agent-rail"
    );
    const { agentRecordToRailSummary } = await import("../src/lib/agent-rail-patch");
    const cloud = agentRecordToRailSummary(
      baseRecord("cloud-1", "ws1", {
        origin: { kind: "cloud", providerId: "linear", label: "OSP" },
      })
    );
    const local = agentRecordToRailSummary(baseRecord("local-1", "ws1"));

    const off = createDefaultAgentRailFilterState();
    assert.equal(matchesAgentRailFilters(cloud, off, ctx), true);
    assert.equal(matchesAgentRailFilters(local, off, ctx), true);

    const on = { ...off, hiddenSources: ["app" as const] };
    assert.equal(matchesAgentRailFilters(cloud, on, ctx), true);
    assert.equal(matchesAgentRailFilters(local, on, ctx), false);
  });

  test("legacy external toggle migrates to hiding in-app sources", async () => {
    const { migrateAgentRailFilterToggles, defaultAgentRailFilterToggles } = await import(
      "../src/lib/agent-rail"
    );
    const migrated = migrateAgentRailFilterToggles({
      ...defaultAgentRailFilterToggles(),
      external: true,
    });
    assert.deepEqual(migrated.hiddenSources, ["app", "imported", "scheduled"]);
  });

  test("persisted legacy toggles without the external key default to off", async () => {
    const { normalizeAgentRailFilterToggles } = await import("../src/lib/agent-rail");
    const restored = normalizeAgentRailFilterToggles({ archived: true });
    assert.equal(restored.archived, true);
    assert.equal(restored.external, false);
  });
});
