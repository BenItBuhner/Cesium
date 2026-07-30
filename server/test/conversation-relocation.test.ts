import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-relocation-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
// Workspace roots live in os.tmpdir(), outside the default allow-list.
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";

const [
  { ensureWorkspaceRegistered },
  { AgentRuntimeManager },
  {
    appendConversationEvents,
    readConversationEvents,
    readConversationRecord,
    relocateConversationStorage,
    saveConversationRecord,
  },
  { getConversationDir },
  { AGENT_BACKENDS },
  { cesiumRelocationChangeNotice },
  {
    listConversationsForAgent,
    readConversationTranscriptForAgent,
    searchConversationsForAgent,
  },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/session-store-legacy-fs.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium/cesium-environment-reminders.js"),
  import("../src/lib/agents/cesium/cesium-conversation-tools.js"),
]);

const testCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: false,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: false,
  supportsPromptImages: false,
  supportsInlineReasoning: false,
  supportsCompletionRetry: false,
};

const testBackends: Record<AgentBackendId, AgentBackendInfo> = {
  ...AGENT_BACKENDS,
  "cesium-agent": {
    ...AGENT_BACKENDS["cesium-agent"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
  "cursor-sdk": {
    ...AGENT_BACKENDS["cursor-sdk"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
};

class NoopSessionHandle implements AgentSessionHandle {
  readonly sessionId = randomUUID();
  configOptions = [];
  capabilities = testCapabilities;
  constructor(private readonly callbacks: AgentRuntimeCallbacks) {}
  async prompt(): Promise<void> {}
  async cancel(): Promise<void> {}
  async setConfigOption(): Promise<void> {}
  async answerPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function createFakeProvider(backendId: AgentBackendId): AgentProvider {
  return {
    backend: testBackends[backendId],
    async startSession(callbacks) {
      return new NoopSessionHandle(callbacks);
    },
    async loadSession(callbacks) {
      return new NoopSessionHandle(callbacks);
    },
  };
}

const manager = new AgentRuntimeManager({
  backends: testBackends,
  createProvider: async (backendId) => createFakeProvider(backendId),
  listBackends: () => Object.values(testBackends),
});

async function makeWorkspaceDir(name: string): Promise<string> {
  const dir = path.join(TEST_DATA_DIR, "roots", name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

test("cesiumRelocationChangeNotice covers workspace + branch moves and re-learn guidance", () => {
  const text = cesiumRelocationChangeNotice({
    fromWorkspaceId: "ws-a",
    fromWorkspaceName: "Alpha",
    fromWorkspaceRoot: "/tmp/alpha",
    toWorkspaceId: "ws-b",
    toWorkspaceName: "Beta",
    toWorkspaceRoot: "/tmp/beta",
    fromBranch: "main",
    toBranch: "feature/x",
    movedAt: Date.now(),
    initiatedBy: "user",
  });
  assert.ok(text);
  assert.match(text!, /relocated by the user/i);
  assert.match(text!, /"Alpha" \(\/tmp\/alpha\)/);
  assert.match(text!, /"Beta" \(\/tmp\/beta\)/);
  assert.match(text!, /from main to feature\/x/);
  assert.match(text!, /re-verify paths/i);
  assert.match(text!, /reuse this context/i);
  assert.equal(cesiumRelocationChangeNotice(null), null);
});

test("relocateConversationStorage physically moves legacy-json conversations", async () => {
  const wsA = await ensureWorkspaceRegistered(await makeWorkspaceDir("store-a"));
  const wsB = await ensureWorkspaceRegistered(await makeWorkspaceDir("store-b"));
  const conversation = await manager.createConversation(wsA, {
    backendId: "cesium-agent",
    title: "Storage move",
  });
  await appendConversationEvents(wsA.id, conversation.id, [
    {
      eventId: randomUUID(),
      conversationId: conversation.id,
      kind: "user_message",
      messageId: randomUUID(),
      content: "hello from workspace A",
    },
  ]);

  const moved = await relocateConversationStorage(conversation.id, wsA.id, wsB.id, {
    providerSessionId: null,
  });
  assert.equal(moved.workspaceId, wsB.id);

  const oldDirExists = await fs
    .stat(getConversationDir(wsA.id, conversation.id))
    .then(() => true)
    .catch(() => false);
  assert.equal(oldDirExists, false);

  const fromOld = await readConversationRecord(wsA.id, conversation.id);
  assert.equal(fromOld, null);
  const fromNew = await readConversationRecord(wsB.id, conversation.id);
  assert.equal(fromNew?.workspaceId, wsB.id);

  const events = await readConversationEvents(wsB.id, conversation.id);
  assert.ok(
    events.some(
      (event) => event.kind === "user_message" && event.content.includes("hello from workspace A")
    )
  );
});

test("relocateConversation moves cesium chats and stamps the pending relocation notice", async () => {
  const wsA = await ensureWorkspaceRegistered(await makeWorkspaceDir("reloc-a"));
  const wsB = await ensureWorkspaceRegistered(await makeWorkspaceDir("reloc-b"));
  const conversation = await manager.createConversation(wsA, {
    backendId: "cesium-agent",
    title: "Relocatable chat",
  });

  const result = await manager.relocateConversation(wsA, conversation.id, {
    workspaceId: wsB.id,
  });
  assert.equal(result.workspace.id, wsB.id);
  assert.equal(result.conversation.workspaceId, wsB.id);
  assert.equal(result.conversation.providerSessionId, null);
  assert.equal(result.conversation.pendingRelocation?.fromWorkspaceId, wsA.id);
  assert.equal(result.conversation.pendingRelocation?.toWorkspaceId, wsB.id);
  assert.equal(result.conversation.pendingRelocation?.initiatedBy, "user");

  const events = await readConversationEvents(wsB.id, conversation.id);
  assert.ok(
    events.some(
      (event) => event.kind === "system" && /moved from/i.test(event.text)
    ),
    "expected a system timeline event describing the move"
  );
});

test("relocateConversation rejects non-cesium harnesses and no-op targets", async () => {
  const wsA = await ensureWorkspaceRegistered(await makeWorkspaceDir("guard-a"));
  const wsB = await ensureWorkspaceRegistered(await makeWorkspaceDir("guard-b"));

  const cursorConversation = await manager.createConversation(wsA, {
    backendId: "cursor-sdk",
    title: "Pinned harness",
  });
  await assert.rejects(
    manager.relocateConversation(wsA, cursorConversation.id, { workspaceId: wsB.id }),
    /Only Cesium harness conversations/i
  );

  const cesiumConversation = await manager.createConversation(wsA, {
    backendId: "cesium-agent",
    title: "No-op move",
  });
  await assert.rejects(
    manager.relocateConversation(wsA, cesiumConversation.id, { workspaceId: wsA.id }),
    /different workspace and\/or a branch/i
  );
});

test("conversation context tools list, read, and search across workspaces", async () => {
  const wsA = await ensureWorkspaceRegistered(await makeWorkspaceDir("tools-a"));
  const wsB = await ensureWorkspaceRegistered(await makeWorkspaceDir("tools-b"));

  const alpha = await manager.createConversation(wsA, {
    backendId: "cesium-agent",
    title: "Alpha research",
  });
  await appendConversationEvents(wsA.id, alpha.id, [
    {
      eventId: randomUUID(),
      conversationId: alpha.id,
      kind: "user_message",
      messageId: randomUUID(),
      content: "Investigate the flux capacitor regression",
    },
    {
      eventId: randomUUID(),
      conversationId: alpha.id,
      kind: "assistant_message_chunk",
      messageId: randomUUID(),
      text: "The flux capacitor overflows at 88mph; clamp the input.",
    },
  ]);
  const beta = await manager.createConversation(wsB, {
    backendId: "cesium-agent",
    title: "Beta planning",
  });
  await appendConversationEvents(wsB.id, beta.id, [
    {
      eventId: randomUUID(),
      conversationId: beta.id,
      kind: "user_message",
      messageId: randomUUID(),
      content: "Draft the beta rollout plan",
    },
  ]);

  const listing = await listConversationsForAgent({ query: "alpha" });
  assert.match(listing, /Alpha research/);
  assert.match(listing, new RegExp(alpha.id));
  assert.doesNotMatch(listing, /Beta planning/);

  const transcript = await readConversationTranscriptForAgent({ conversationId: alpha.id });
  assert.match(transcript, /Alpha research/);
  assert.match(transcript, /flux capacitor regression/);
  assert.match(transcript, /clamp the input/);

  const hits = await searchConversationsForAgent({ query: "flux capacitor" });
  assert.match(hits, new RegExp(alpha.id));
  assert.match(hits, /flux capacitor/i);

  const misses = await searchConversationsForAgent({ query: "totally-absent-token-xyz" });
  assert.match(misses, /No matches/);

  await assert.rejects(
    readConversationTranscriptForAgent({ conversationId: "does-not-exist" }),
    /Unknown conversation/
  );
});
