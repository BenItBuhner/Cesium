import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nextAcknowledgedFailureMap } from "../src/lib/chat-acknowledged-failure.ts";
import { createDefaultWorkspaceSession } from "../src/lib/workspace-session.ts";
import type { AgentConversationRecord } from "../src/lib/agent-types.ts";
import type { ModelInfo } from "../src/lib/types.ts";

const model: ModelInfo = { id: "m", name: "m", provider: "openai" };

function record(
  overrides: Partial<AgentConversationRecord> = {}
): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: "c1",
    workspaceId: "ws1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    status: "idle",
    config: { backendId: "cesium-agent", mode: "agent", modelId: "m", modelName: "m" },
    providerSessionId: null,
    configOptions: [],
    capabilities: {
      supportsLoadSession: false,
      supportsModeSelection: false,
      supportsModelSelection: false,
      supportsSlashCommands: false,
      supportsPermissions: false,
      supportsToolCalls: false,
      supportsStructuredPlans: false,
      supportsTodos: false,
      supportsSessionResume: false,
      supportsPromptImages: false,
      supportsInlineReasoning: false,
      supportsCompletionRetry: false,
    },
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    ...overrides,
  };
}

describe("acknowledged failure map", () => {
  test("background failure stays unacked; viewing acks it", () => {
    const session = createDefaultWorkspaceSession([], model);
    const failed = record({ status: "failed", lastError: "boom", updatedAt: 10 });
    const background = nextAcknowledgedFailureMap(session, record(), failed);
    assert.equal(background, null);

    const viewing = createDefaultWorkspaceSession(
      [{ id: "c1", title: "Chat", active: true }],
      model
    );
    const acked = nextAcknowledgedFailureMap(viewing, record(), failed);
    assert.equal(acked?.c1, true);
  });

  test("a later failure clears a previous ack until seen again", () => {
    const session = createDefaultWorkspaceSession([], model);
    session.chat.acknowledgedFailureByConversationId = { c1: true };
    const nextFailure = record({
      status: "failed",
      lastError: "again",
      updatedAt: 99,
    });
    const cleared = nextAcknowledgedFailureMap(
      session,
      record({ status: "failed", lastError: "boom", updatedAt: 10 }),
      nextFailure
    );
    assert.ok(cleared);
    assert.equal(cleared.c1, undefined);
  });

  test("leaving failed removes the ack", () => {
    const session = createDefaultWorkspaceSession([], model);
    session.chat.acknowledgedFailureByConversationId = { c1: true };
    const idle = record({ status: "idle", updatedAt: 11 });
    const next = nextAcknowledgedFailureMap(
      session,
      record({ status: "failed", lastError: "boom", updatedAt: 10 }),
      idle
    );
    assert.ok(next);
    assert.equal(next.c1, undefined);
  });
});
