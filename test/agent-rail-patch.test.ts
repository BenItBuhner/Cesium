import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentBackendId,
  AgentConversationGroup,
  AgentConversationMode,
  AgentConversationRecord,
  AgentProviderCapabilities,
} from "../src/lib/agent-types";
import { patchAgentConversationGroups } from "../src/lib/agent-rail-patch";
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
});
