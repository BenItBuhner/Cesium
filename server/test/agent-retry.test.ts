import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_BACKENDS } from "../src/lib/agents/providers.js";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `agent-retry-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const [
  { ensureWorkspaceRegistered },
  { AgentRuntimeManager },
  {
    readConversationRecord,
    saveConversationRecord,
    createConversationId,
    appendConversationEvents,
  },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
]);

const manager = new AgentRuntimeManager();
const cursorSdk = AGENT_BACKENDS["cursor-sdk"]!;

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

test("retryConversationTurn rejects backends without completion retry", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "retry-test");
  const conversationId = createConversationId();
  const now = Date.now();
  const record: AgentConversationRecord = {
    schemaVersion: 1,
    id: conversationId,
    workspaceId: workspace.id,
    title: "Retry test",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 1,
    status: "failed",
    config: {
      backendId: "cursor-sdk",
      mode: "agent",
      modelId: cursorSdk.defaultModelId,
      modelName: cursorSdk.defaultModelName,
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: cursorSdk.capabilities,
    pendingPermission: null,
    lastError: "Provider exploded",
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  await saveConversationRecord(record);
  await appendConversationEvents(workspace.id, conversationId, [
    {
      seq: 1,
      eventId: randomUUID(),
      conversationId,
      createdAt: now,
      kind: "user_message",
      messageId: randomUUID(),
      content: "hello",
    },
  ]);

  await assert.rejects(
    () => manager.retryConversationTurn(workspace, conversationId),
    /does not support completion retry/i
  );

  const persisted = await readConversationRecord(workspace.id, conversationId);
  assert.equal(persisted?.status, "failed");
  assert.equal(persisted?.lastError, "Provider exploded");
});
