import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConversationRecord } from "../src/lib/agents/conversation-normalize.js";
import { AGENT_BACKENDS } from "../src/lib/agents/providers.js";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";

function record(
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  const backend = AGENT_BACKENDS["cesium-agent"];
  return {
    schemaVersion: 1,
    id: "conv-1",
    workspaceId: "ws-1",
    title: "Test conversation",
    createdAt: 1_000,
    updatedAt: 2_000,
    lastEventSeq: 4,
    status: "idle",
    config: {
      backendId: backend.id,
      mode: backend.defaultMode,
      modelId: backend.defaultModelId,
      modelName: backend.defaultModelName,
    } as AgentConversationRecord["config"],
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    settledAt: null,
    settledUntil: null,
    lastReadSeq: 4,
    queuedPrompts: [],
    ...overrides,
  };
}

test("a timed settle within its window survives normalization", () => {
  const now = Date.now();
  const normalized = normalizeConversationRecord(
    record({ settledAt: now - 1_000, settledUntil: now + 86_400_000 })
  );
  assert.equal(normalized.settledAt, now - 1_000);
  assert.equal(normalized.settledUntil, now + 86_400_000);
});

test("an elapsed timed settle lazily unsettles on read", () => {
  const now = Date.now();
  const normalized = normalizeConversationRecord(
    record({ settledAt: now - 90_000_000, settledUntil: now - 1_000 })
  );
  assert.equal(normalized.settledAt, null);
  assert.equal(normalized.settledUntil, null);
});

test("an untimed settle never expires", () => {
  const now = Date.now();
  const normalized = normalizeConversationRecord(
    record({ settledAt: now - 90_000_000, settledUntil: null })
  );
  assert.equal(normalized.settledAt, now - 90_000_000);
  assert.equal(normalized.settledUntil, null);
});
