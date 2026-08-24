import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AgentConversationRecord,
  AgentConversationStatus,
} from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `stale-run-reconciler-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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

// All runtime imports of src modules must stay dynamic and come after the
// OPENCURSOR_DATA_DIR override: a hoisted static import would transitively
// load persistence.ts first and freeze DATA_DIR to the real data directory,
// leaking the stale-run fixtures seeded here into the user's actual store.
const [
  { AGENT_BACKENDS },
  { ensureWorkspaceRegistered },
  {
    createConversationId,
    readConversationEvents,
    readConversationRecord,
    saveConversationRecord,
  },
  {
    interruptStaleAgentRun,
    reconcileStaleAgentRunsOnBoot,
    startStaleAgentRunWatchdog,
  },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/stale-run-reconciler.js"),
]);

const cesiumBackend = AGENT_BACKENDS["cesium-agent"]!;

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

async function seedConversation(
  workspaceId: string,
  status: AgentConversationStatus,
  overrides: Partial<AgentConversationRecord> = {}
): Promise<AgentConversationRecord> {
  const now = Date.now();
  const record: AgentConversationRecord = {
    schemaVersion: 1,
    id: createConversationId(),
    workspaceId,
    title: `Stale ${status}`,
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
    status,
    config: {
      backendId: "cesium-agent",
      mode: "agent",
      modelId: cesiumBackend.defaultModelId,
      modelName: cesiumBackend.defaultModelName,
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: cesiumBackend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    ...overrides,
  };
  await saveConversationRecord(record);
  return record;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("boot sweep interrupts busy conversations left behind by a dead process", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "stale-boot-test");
  const running = await seedConversation(workspace.id, "running");
  const awaiting = await seedConversation(workspace.id, "awaiting_permission", {
    pendingPermission: {
      requestId: "perm-1",
      requestedAt: Date.now(),
      title: "Allow?",
      options: [],
    },
  });
  const idle = await seedConversation(workspace.id, "idle");
  const failed = await seedConversation(workspace.id, "failed");

  const interrupted = await reconcileStaleAgentRunsOnBoot({
    hasLiveRuntime: () => false,
  });
  assert.ok(interrupted >= 2);

  const runningAfter = await readConversationRecord(workspace.id, running.id);
  assert.equal(runningAfter?.status, "interrupted");
  const awaitingAfter = await readConversationRecord(workspace.id, awaiting.id);
  assert.equal(awaitingAfter?.status, "interrupted");
  assert.equal(awaitingAfter?.pendingPermission, null);
  const idleAfter = await readConversationRecord(workspace.id, idle.id);
  assert.equal(idleAfter?.status, "idle");
  const failedAfter = await readConversationRecord(workspace.id, failed.id);
  assert.equal(failedAfter?.status, "failed");

  // Clients learn about the interruption from a terminal status event.
  const events = await readConversationEvents(workspace.id, running.id);
  const statusEvent = events.find(
    (event) => event.kind === "status" && event.status === "interrupted"
  );
  assert.ok(statusEvent, "expected an interrupted status event to be appended");
});

test("boot sweep leaves conversations with a live runtime untouched", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "stale-boot-live-test");
  const running = await seedConversation(workspace.id, "running");

  await reconcileStaleAgentRunsOnBoot({
    hasLiveRuntime: (conversationId) => conversationId === running.id,
  });

  const after = await readConversationRecord(workspace.id, running.id);
  assert.equal(after?.status, "running");
});

test("interruptStaleAgentRun refuses when the status raced to something else", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "stale-race-test");
  const conversation = await seedConversation(workspace.id, "idle");

  const flipped = await interruptStaleAgentRun(
    workspace.id,
    conversation.id,
    "The server restarted while this agent run was in progress."
  );
  assert.equal(flipped, false);

  const after = await readConversationRecord(workspace.id, conversation.id);
  assert.equal(after?.status, "idle");
  const events = await readConversationEvents(workspace.id, conversation.id);
  assert.equal(events.length, 0);
});

test("watchdog interrupts a running conversation whose runtime disappeared", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "stale-watchdog-test");
  const stop = startStaleAgentRunWatchdog({
    tickMs: 25,
    graceMs: 40,
    hasLiveRuntime: () => false,
  });
  try {
    // Saving with a busy status emits the store event the watchdog listens to.
    const running = await seedConversation(workspace.id, "running");
    await delay(250);
    const after = await readConversationRecord(workspace.id, running.id);
    assert.equal(after?.status, "interrupted");
    const events = await readConversationEvents(workspace.id, running.id);
    assert.ok(
      events.some((event) => event.kind === "status" && event.status === "interrupted")
    );
  } finally {
    stop();
  }
});

test("watchdog leaves runs with a live runtime alone", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "healthy-watchdog-test");
  const stop = startStaleAgentRunWatchdog({
    tickMs: 25,
    graceMs: 40,
    hasLiveRuntime: () => true,
  });
  try {
    const running = await seedConversation(workspace.id, "running");
    await delay(200);
    const after = await readConversationRecord(workspace.id, running.id);
    assert.equal(after?.status, "running");
  } finally {
    stop();
  }
});

test("watchdog never touches awaiting states (recoverable on demand)", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "awaiting-watchdog-test");
  const stop = startStaleAgentRunWatchdog({
    tickMs: 25,
    graceMs: 40,
    hasLiveRuntime: () => false,
  });
  try {
    const awaiting = await seedConversation(workspace.id, "awaiting_question");
    await delay(200);
    const after = await readConversationRecord(workspace.id, awaiting.id);
    assert.equal(after?.status, "awaiting_question");
  } finally {
    stop();
  }
});
