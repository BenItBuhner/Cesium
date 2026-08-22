import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentOptions, SDKAgent } from "@cursor/sdk";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-cursor-cloud-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
  {
    buildCursorSdkCloudOptions,
    isCloudExecutionTarget,
    normalizeCursorSdkCloudRepoUrl,
    CURSOR_SDK_CLOUD_METADATA_CONVERSATION_KEY,
  },
  { createCursorSdkProvider },
  { propagateCloudExecutionLifecycle },
  { AGENT_CAPABILITIES },
  { AGENT_BACKENDS },
  { AgentRuntimeManager },
  { ensureWorkspaceRegistered },
] = await Promise.all([
  import("../src/lib/agents/cursor-sdk-cloud-options.js"),
  import("../src/lib/agents/cursor-sdk-provider.js"),
  import("../src/lib/agents/cloud-execution-lifecycle.js"),
  import("../src/lib/agents/agent-contract.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/workspace-registry.js"),
]);

import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type { AgentPluginAttachmentSnapshot } from "../src/lib/plugins/attachments.js";
import type { CursorSdkProviderDependencies } from "../src/lib/agents/cursor-sdk-provider.js";

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

// --- Repo URL normalization -------------------------------------------------

test("normalizeCursorSdkCloudRepoUrl rewrites SSH remotes to https", () => {
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("git@github.com:owner/repo.git"),
    "https://github.com/owner/repo"
  );
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("ssh://git@github.com/owner/repo.git"),
    "https://github.com/owner/repo"
  );
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("git://github.com/owner/repo.git"),
    "https://github.com/owner/repo"
  );
});

test("normalizeCursorSdkCloudRepoUrl keeps https remotes and strips .git", () => {
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo"
  );
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("https://github.com/owner/repo"),
    "https://github.com/owner/repo"
  );
  assert.equal(
    normalizeCursorSdkCloudRepoUrl("https://git.example.com:8443/team/repo.git"),
    "https://git.example.com:8443/team/repo"
  );
});

test("normalizeCursorSdkCloudRepoUrl rejects non-network remotes", () => {
  assert.equal(normalizeCursorSdkCloudRepoUrl("/srv/git/repo.git"), null);
  assert.equal(normalizeCursorSdkCloudRepoUrl("../relative/repo"), null);
  assert.equal(normalizeCursorSdkCloudRepoUrl("file:///srv/git/repo.git"), null);
  assert.equal(normalizeCursorSdkCloudRepoUrl(""), null);
});

// --- Cloud options builder ---------------------------------------------------

test("buildCursorSdkCloudOptions maps the workspace repo onto cloud repos", async () => {
  const options = await buildCursorSdkCloudOptions({
    workspaceRoot: "/tmp/example",
    conversationId: "conversation-1",
    resolveRepo: async () => ({
      url: "https://github.com/owner/repo",
      startingRef: "feature/cloud",
    }),
  });
  assert.deepEqual(options.repos, [
    { url: "https://github.com/owner/repo", startingRef: "feature/cloud" },
  ]);
  assert.equal(options.workOnCurrentBranch, true);
  assert.equal(options.autoCreatePR, false);
  assert.equal(
    options.metadata?.[CURSOR_SDK_CLOUD_METADATA_CONVERSATION_KEY],
    "conversation-1"
  );
});

test("buildCursorSdkCloudOptions falls back to a no-repo cloud VM", async () => {
  const options = await buildCursorSdkCloudOptions({
    workspaceRoot: "/tmp/example",
    conversationId: "conversation-2",
    resolveRepo: async () => null,
  });
  assert.deepEqual(options.repos, []);
  assert.equal("workOnCurrentBranch" in options, false);
});

test("isCloudExecutionTarget only matches cloud", () => {
  assert.equal(isCloudExecutionTarget("cloud"), true);
  assert.equal(isCloudExecutionTarget("local"), false);
  assert.equal(isCloudExecutionTarget(undefined), false);
});

// --- Provider branch ---------------------------------------------------------

function fakeConversation(input: {
  executionTarget?: "local" | "cloud";
}): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: "conversation-cursor-cloud-test",
    workspaceId: "workspace-cursor-cloud-test",
    title: "Cursor cloud test",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cursor-sdk",
      mode: "agent",
      modelId: "composer-2.5",
      modelName: "Composer 2.5",
      ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: AGENT_CAPABILITIES["cursor-sdk"],
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
}

function fakeCallbacks(conversation: AgentConversationRecord): {
  callbacks: AgentRuntimeCallbacks;
  appendedEvents: AgentEventInput[];
} {
  const appendedEvents: AgentEventInput[] = [];
  let current = conversation;
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: conversation.workspaceId,
      root: "/tmp/cursor-cloud-test-workspace",
      name: "Cloud test workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversation,
    async appendEvents(events) {
      appendedEvents.push(...events);
      return events.map(
        (event, index) =>
          ({
            ...event,
            seq: index + 1,
            createdAt: event.createdAt ?? 1,
          }) as AgentStoredEvent
      );
    },
    async readSnapshot() {
      return null;
    },
    async updateConversation(patch) {
      current = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      return current;
    },
  };
  return { callbacks, appendedEvents };
}

function fakeProviderSetup(input: { mcpServers?: boolean }) {
  const createdOptions: AgentOptions[] = [];
  const resumedOptions: Array<Partial<AgentOptions> | undefined> = [];
  let cloudOptionCalls = 0;

  const fakeAgent = (agentId: string): SDKAgent =>
    ({
      agentId,
      async [Symbol.asyncDispose]() {},
    }) as unknown as SDKAgent;

  const dependencies: CursorSdkProviderDependencies = {
    agent: {
      async create(options) {
        createdOptions.push(options);
        return fakeAgent("bc-fake-cloud-agent");
      },
      async resume(agentId, options) {
        resumedOptions.push(options);
        return fakeAgent(agentId);
      },
    },
    async getApiKey() {
      return "test-key";
    },
    async resolvePluginAttachments(attachmentInput) {
      return {
        ...attachmentInput,
        plugins: [],
        skillsList: "",
        promptSection: "",
        mcpSummaries: [],
        mcpServers: [],
        sdkMcp: {
          servers: input.mcpServers
            ? { "local-tools": { type: "stdio" as const, command: "node" } }
            : {},
          skipped: [],
        },
        warnings: [],
        toolDisplays: [],
      } satisfies AgentPluginAttachmentSnapshot;
    },
    async buildCloudOptions(cloudInput) {
      cloudOptionCalls += 1;
      return {
        repos: [{ url: "https://github.com/owner/repo" }],
        workOnCurrentBranch: true,
        autoCreatePR: false,
        metadata: { cesiumConversationId: cloudInput.conversationId },
      };
    },
  };

  const backend: AgentBackendInfo = {
    id: "cursor-sdk",
    label: "Cursor SDK",
    description: "test",
    available: true,
    defaultMode: "agent",
    defaultModelId: "composer-2.5",
    defaultModelName: "Composer 2.5",
    capabilities: AGENT_CAPABILITIES["cursor-sdk"],
  };
  const configOptions: AgentConfigOption[] = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "composer-2.5",
      options: [{ value: "composer-2.5", name: "Composer 2.5" }],
    },
    {
      id: "sdk_sandbox",
      name: "Local Sandbox",
      category: "permission",
      currentValue: "disabled",
      options: [
        { value: "disabled", name: "Disabled" },
        { value: "enabled", name: "Enabled" },
      ],
    },
  ];

  return {
    createdOptions,
    resumedOptions,
    dependencies,
    backend,
    configOptions,
    get cloudOptionCalls() {
      return cloudOptionCalls;
    },
  };
}

test("cursor-sdk provider passes cloud options and omits local runtime for cloud conversations", async () => {
  const setup = fakeProviderSetup({ mcpServers: true });
  const conversation = fakeConversation({ executionTarget: "cloud" });
  const { callbacks, appendedEvents } = fakeCallbacks(conversation);

  const provider = createCursorSdkProvider({
    backend: setup.backend,
    configOptions: setup.configOptions,
    dependencies: setup.dependencies,
  });
  const handle = await provider.startSession(callbacks);

  assert.equal(setup.createdOptions.length, 1);
  const options = setup.createdOptions[0]!;
  assert.equal(options.local, undefined);
  assert.ok(options.cloud, "cloud options are set");
  assert.deepEqual(options.cloud?.repos, [{ url: "https://github.com/owner/repo" }]);
  assert.equal(
    options.cloud?.metadata?.cesiumConversationId,
    conversation.id
  );
  assert.equal(setup.cloudOptionCalls, 1);
  // Locally configured MCP servers never ship to the cloud VM.
  assert.equal(options.mcpServers, undefined);
  const mcpNotice = appendedEvents.find(
    (event) =>
      event.kind === "system" && /Cursor Cloud/.test((event as { text: string }).text)
  );
  assert.ok(mcpNotice, "cloud MCP notice event appended");

  // Sandbox/setting-source changes are local-only: no SDK rebind on cloud.
  await handle.setConfigOption("sdk_sandbox", "enabled");
  assert.equal(setup.resumedOptions.length, 0);

  await handle.dispose();
});

test("cursor-sdk provider keeps the local runtime for local conversations", async () => {
  const setup = fakeProviderSetup({ mcpServers: true });
  const conversation = fakeConversation({});
  const { callbacks } = fakeCallbacks(conversation);

  const provider = createCursorSdkProvider({
    backend: setup.backend,
    configOptions: setup.configOptions,
    dependencies: setup.dependencies,
  });
  const handle = await provider.startSession(callbacks);

  assert.equal(setup.createdOptions.length, 1);
  const options = setup.createdOptions[0]!;
  assert.equal(options.cloud, undefined);
  assert.equal(options.local?.cwd, callbacks.workspace.root);
  assert.ok(options.mcpServers, "local runs still forward MCP servers");
  assert.equal(setup.cloudOptionCalls, 0);

  await handle.dispose();
});

// --- Remote lifecycle propagation ---------------------------------------------

test("propagateCloudExecutionLifecycle mirrors archive to the backend handler", async () => {
  const calls: Array<{ providerSessionId: string; action: string }> = [];
  await propagateCloudExecutionLifecycle(
    {
      id: "conversation-cloud-1",
      config: {
        backendId: "cursor-sdk",
        mode: "agent",
        modelId: "composer-2.5",
        modelName: "Composer 2.5",
        executionTarget: "cloud",
      },
      providerSessionId: "bc-remote-agent",
    },
    "archive",
    {
      "cursor-sdk": async (input) => {
        calls.push(input);
      },
    }
  );
  assert.deepEqual(calls, [
    { providerSessionId: "bc-remote-agent", action: "archive" },
  ]);
});

test("propagateCloudExecutionLifecycle skips local conversations and swallows handler errors", async () => {
  const calls: string[] = [];
  await propagateCloudExecutionLifecycle(
    {
      id: "conversation-local-1",
      config: {
        backendId: "cursor-sdk",
        mode: "agent",
        modelId: "composer-2.5",
        modelName: "Composer 2.5",
      },
      providerSessionId: "agent-local",
    },
    "archive",
    {
      "cursor-sdk": async () => {
        calls.push("called");
      },
    }
  );
  assert.deepEqual(calls, []);

  // A vendor API failure never rejects.
  await assert.doesNotReject(
    propagateCloudExecutionLifecycle(
      {
        id: "conversation-cloud-2",
        config: {
          backendId: "cursor-sdk",
          mode: "agent",
          modelId: "composer-2.5",
          modelName: "Composer 2.5",
          executionTarget: "cloud",
        },
        providerSessionId: "bc-remote-agent",
      },
      "delete",
      {
        "cursor-sdk": async () => {
          throw new Error("vendor 500");
        },
      }
    )
  );
});

// --- Runtime-manager create validation and immutability -----------------------

const testRuntimeManager = new AgentRuntimeManager({
  backends: AGENT_BACKENDS,
  listBackends: () => Object.values(AGENT_BACKENDS),
  createProvider: async () => {
    throw new Error("providers are not started in this test");
  },
});

test("createConversation rejects cloud execution on backends without the capability", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  await assert.rejects(
    testRuntimeManager.createConversation(workspace, {
      backendId: "cesium-agent",
      executionTarget: "cloud",
    }),
    /does not support cloud execution/
  );
});

test("createConversation persists cloud execution for cloud-capable backends", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const record = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    executionTarget: "cloud",
    title: `Cloud chat ${randomUUID().slice(0, 8)}`,
  });
  assert.equal(record.config.executionTarget, "cloud");

  // Config patches cannot flip the execution target after creation.
  const patched = await testRuntimeManager.updateConversationConfig(
    workspace,
    record.id,
    { executionTarget: "local", modelId: "composer-2.5", modelName: "Composer 2.5" }
  );
  assert.equal(patched.config.executionTarget, "cloud");

  // Handing off to a different backend drops the cloud target (fresh local session).
  const switched = await testRuntimeManager.updateConversationConfig(
    workspace,
    record.id,
    { backendId: "cesium-agent" }
  );
  assert.equal(switched.config.executionTarget, undefined);
});

test("local conversations stay local by default", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const record = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    title: `Local chat ${randomUUID().slice(0, 8)}`,
  });
  assert.equal(record.config.executionTarget, undefined);
});
