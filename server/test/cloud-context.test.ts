import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Cesium Cloud Context server pieces:
 * - portable conversation snapshots (export → materialize round trip,
 *   sanitization, idempotency, transcript truncation)
 * - the one-click CLI install registry
 * - live backend runtime refresh after installs
 */

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-cloud-context-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";

const [
  { exportConversationSnapshot, materializeCloudSnapshot },
  sessionStore,
  { ensureWorkspaceRegistered },
  {
    CLI_INSTALL_SPECS,
    buildInstallCommand,
    getCesiumToolsDir,
    getInstallSpecForBackend,
    isInstallSupportedOnThisHost,
    resolveCesiumToolBin,
  },
  { AGENT_BACKENDS },
  { refreshHarnessCliDetection },
] = await Promise.all([
  import("../src/lib/agents/cloud-snapshot.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/install/cli-install-registry.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/harness-runtime.js"),
]);

import type {
  AgentConversationRecord,
  AgentEventInput,
} from "../src/lib/agents/types.js";

async function makeWorkspace(name: string) {
  const root = path.join(TEST_DATA_DIR, `ws-${name}`);
  await fs.mkdir(root, { recursive: true });
  return await ensureWorkspaceRegistered(root, name);
}

function makeRecord(workspaceId: string): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: sessionStore.createConversationId(),
    workspaceId,
    title: "Refactor the websocket reconnect logic",
    createdAt: now - 60_000,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cesium-agent",
      mode: "agent",
      modelId: "techlit/kimi-k3",
      modelName: "Kimi K3",
    },
    providerSessionId: "cesium-old-session",
    configOptions: [],
    capabilities: AGENT_BACKENDS["cesium-agent"].capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [
      {
        promptId: randomUUID(),
        text: "queued prompt that must not travel",
        createdAt: now,
      },
    ],
  };
}

function makeEvents(conversationId: string, turns: number): AgentEventInput[] {
  const events: AgentEventInput[] = [];
  let at = Date.now() - 50_000;
  for (let index = 0; index < turns; index += 1) {
    const messageId = randomUUID();
    events.push({
      eventId: randomUUID(),
      conversationId,
      createdAt: (at += 10),
      kind: "user_message",
      messageId: randomUUID(),
      content: `question ${index}`,
      raw: { bulky: "x".repeat(64) },
    });
    events.push({
      eventId: randomUUID(),
      conversationId,
      createdAt: (at += 10),
      kind: "assistant_message_chunk",
      messageId,
      text: `answer ${index}`,
    });
    events.push({
      eventId: randomUUID(),
      conversationId,
      createdAt: (at += 10),
      kind: "assistant_message_end",
      messageId,
    });
    events.push({
      eventId: randomUUID(),
      conversationId,
      createdAt: (at += 10),
      kind: "status",
      status: "idle",
    });
  }
  return events;
}

test("snapshot export sanitizes runtime state and strips seq/raw", async () => {
  const workspace = await makeWorkspace("export");
  const record = makeRecord(workspace.id);
  await sessionStore.saveConversationRecord(record);
  await sessionStore.appendConversationEvents(
    workspace.id,
    record.id,
    makeEvents(record.id, 3)
  );

  const snapshot = await exportConversationSnapshot(workspace, record.id);
  assert.ok(snapshot);
  assert.equal(snapshot.snapshotKey, record.id);
  assert.equal(snapshot.title, record.title);
  assert.equal(snapshot.backendId, "cesium-agent");
  assert.equal(snapshot.modelId, "techlit/kimi-k3");
  assert.equal(snapshot.messageCount, 6); // 3 user + 3 assistant
  assert.equal(snapshot.truncated, false);

  const parsedRecord = JSON.parse(snapshot.recordJson) as Record<string, unknown>;
  assert.equal(parsedRecord.id, undefined);
  assert.equal(parsedRecord.workspaceId, undefined);
  assert.equal(parsedRecord.providerSessionId, null);
  assert.equal(parsedRecord.status, "idle");
  assert.deepEqual(parsedRecord.queuedPrompts, []);
  // Config options can embed the engine's whole model catalog — never travel.
  assert.deepEqual(parsedRecord.configOptions, []);

  const parsedEvents = JSON.parse(snapshot.eventsJson) as Array<
    Record<string, unknown>
  >;
  assert.equal(parsedEvents.length, 12);
  for (const event of parsedEvents) {
    assert.equal(event.seq, undefined);
    assert.equal(event.raw, undefined);
  }
});

test("snapshot materializes on another engine and is idempotent", async () => {
  const source = await makeWorkspace("mat-source");
  const record = makeRecord(source.id);
  await sessionStore.saveConversationRecord(record);
  await sessionStore.appendConversationEvents(
    source.id,
    record.id,
    makeEvents(record.id, 2)
  );
  const snapshot = await exportConversationSnapshot(source, record.id);
  assert.ok(snapshot);

  // "Another engine": a different workspace registry entry with a fresh id.
  const target = await makeWorkspace("mat-target");
  const first = await materializeCloudSnapshot({
    workspace: target,
    snapshotKey: snapshot.snapshotKey,
    recordJson: snapshot.recordJson,
    eventsJson: snapshot.eventsJson,
    sourceServerName: "workstation",
    sourceWorkspaceName: "demo",
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
  });
  assert.equal(first.created, true);
  assert.equal(first.title, record.title);
  assert.equal(first.eventCount, 8);
  assert.notEqual(first.conversationId, record.id);

  const materialized = await sessionStore.readConversationRecord(
    target.id,
    first.conversationId
  );
  assert.ok(materialized);
  assert.equal(materialized.origin?.kind, "cloud-snapshot");
  assert.equal(
    materialized.origin?.kind === "cloud-snapshot"
      ? materialized.origin.snapshotKey
      : null,
    snapshot.snapshotKey
  );
  assert.equal(materialized.providerSessionId, null);
  assert.equal(materialized.status, "idle");

  const events = await sessionStore.readConversationEvents(
    target.id,
    first.conversationId
  );
  assert.equal(events.length, 8);

  // Re-materializing the same snapshot updates in place — no duplicates.
  const second = await materializeCloudSnapshot({
    workspace: target,
    snapshotKey: snapshot.snapshotKey,
    recordJson: snapshot.recordJson,
    eventsJson: snapshot.eventsJson,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
  });
  assert.equal(second.created, false);
  assert.equal(second.conversationId, first.conversationId);
  const eventsAfter = await sessionStore.readConversationEvents(
    target.id,
    first.conversationId
  );
  assert.equal(eventsAfter.length, 8);
});

test("oversized transcripts are truncated from the oldest events", async () => {
  const workspace = await makeWorkspace("truncate");
  const record = makeRecord(workspace.id);
  record.title = "huge";
  await sessionStore.saveConversationRecord(record);
  const bulky: AgentEventInput[] = [];
  for (let index = 0; index < 40; index += 1) {
    bulky.push({
      eventId: randomUUID(),
      conversationId: record.id,
      createdAt: Date.now() + index,
      kind: "user_message",
      messageId: randomUUID(),
      content: `${index}:${"y".repeat(40_000)}`,
    });
  }
  await sessionStore.appendConversationEvents(workspace.id, record.id, bulky);

  const snapshot = await exportConversationSnapshot(workspace, record.id);
  assert.ok(snapshot);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.eventsJson.length <= 900_000);
  const events = JSON.parse(snapshot.eventsJson) as Array<{ content: string }>;
  // The newest events survive; the oldest are dropped.
  assert.ok(events.length > 0);
  assert.ok(events[events.length - 1].content.startsWith("39:"));
});

test("install registry only exposes vetted argv installers", () => {
  assert.ok(CLI_INSTALL_SPECS.length >= 2);
  for (const spec of CLI_INSTALL_SPECS) {
    assert.ok(spec.backendId in AGENT_BACKENDS, `unknown backend ${spec.backendId}`);
    assert.ok(spec.platforms.length > 0);
    // No shell strings — plain argv with a known package manager, and never
    // the ambient global prefix (bun/desktop servers have no reliable one).
    const invocation = buildInstallCommand(spec);
    assert.ok(invocation.command === "npm" || invocation.command === "npm.cmd");
    assert.equal(invocation.args[0], "install");
    const prefixIndex = invocation.args.indexOf("--prefix");
    assert.ok(prefixIndex > 0);
    assert.equal(invocation.args[prefixIndex + 1], getCesiumToolsDir());
    assert.equal(invocation.args[invocation.args.length - 1], spec.packageName);
    assert.ok(!invocation.args.includes("-g"));
  }
  assert.equal(getInstallSpecForBackend("codex-app-server")?.binName, "codex");
  assert.equal(getInstallSpecForBackend("cesium-agent"), null);
  // Claude Code SDK authenticates with an API key — no CLI installer.
  assert.equal(getInstallSpecForBackend("claude-code-sdk"), null);
  const codexSpec = getInstallSpecForBackend("codex-app-server");
  assert.ok(codexSpec && isInstallSupportedOnThisHost(codexSpec));
});

test("tools-dir installs are picked up after a detection refresh", async () => {
  const binDir = path.join(getCesiumToolsDir(), "node_modules", ".bin");
  await fs.mkdir(binDir, { recursive: true });
  const fakeOpencode = path.join(binDir, "opencode");
  await fs.writeFile(fakeOpencode, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    assert.equal(resolveCesiumToolBin("opencode"), fakeOpencode);
    // Filesystem-only changes are not in the detection fingerprint; the
    // install route drops the cache explicitly, exactly like this.
    refreshHarnessCliDetection();
    assert.equal(AGENT_BACKENDS["opencode-server"].available, true);
    assert.ok(
      AGENT_BACKENDS["opencode-server"].commandPreview?.includes("opencode")
    );
  } finally {
    await fs.rm(fakeOpencode, { force: true });
    refreshHarnessCliDetection();
    assert.equal(AGENT_BACKENDS["opencode-server"].available, false);
  }
});

test("live registry flips availability when a CLI env override appears", async () => {
  const binDir = path.join(TEST_DATA_DIR, "fake-bin");
  await fs.mkdir(binDir, { recursive: true });
  const fakeCodex = path.join(binDir, "codex");
  await fs.writeFile(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const before = AGENT_BACKENDS["codex-app-server"].available;
  process.env.OPENCURSOR_CODEX_BIN = fakeCodex;
  try {
    // Env changes invalidate the detection fingerprint automatically — the
    // getter-based registry reflects them on the next property read.
    assert.equal(AGENT_BACKENDS["codex-app-server"].available, true);
    assert.ok(
      AGENT_BACKENDS["codex-app-server"].commandPreview?.includes("app-server")
    );
  } finally {
    delete process.env.OPENCURSOR_CODEX_BIN;
    assert.equal(AGENT_BACKENDS["codex-app-server"].available, before);
  }
});
