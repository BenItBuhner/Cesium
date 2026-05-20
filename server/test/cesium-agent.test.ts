import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-agent-settings-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  { AGENT_BACKENDS, listAgentBackends },
  {
    getCesiumAgentSettingsPublic,
    upsertCesiumProviderKey,
    deleteCesiumProviderKey,
    resolveCesiumModelRuntime,
    resolveCesiumAuth,
    refreshCesiumModelCatalog,
  },
  { normalizeEventsToHistory, openAiMessages, cesiumPermissionToolKey, createCesiumAgentProvider },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium-provider.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("Cesium Agent is registered first and marked beta", () => {
  assert.equal(listAgentBackends()[0]?.id, "cesium-agent");
  assert.equal(AGENT_BACKENDS["cesium-agent"].label, "Cesium Agent (Beta)");
  assert.equal(AGENT_BACKENDS["cesium-agent"].experimental, true);
  assert.equal(AGENT_BACKENDS["cesium-agent"].capabilities.supportsToolCalls, true);
  assert.equal(AGENT_BACKENDS["cesium-agent"].capabilities.supportsPermissions, true);
});

test("cesiumPermissionToolKey scopes remembered rules by tool shape", () => {
  assert.equal(
    cesiumPermissionToolKey("editFile", { path: "src/app.ts" }),
    "cesium:edit_file:src/app.ts"
  );
  assert.equal(
    cesiumPermissionToolKey("terminal", { command: "npm test" }),
    "cesium:terminal:npm test"
  );
  assert.equal(
    cesiumPermissionToolKey("mcpCall", { serverId: "linear", toolName: "search" }),
    "cesium:mcp:linear:search"
  );
});

test("Cesium provider keys are stored server-side and returned redacted", async () => {
  let publicSettings = await getCesiumAgentSettingsPublic();
  assert.equal(publicSettings.configured, false);

  publicSettings = await upsertCesiumProviderKey({
    providerId: "openai",
    apiKind: "openai-responses",
    apiKey: "sk-test-1234567890",
  });

  assert.equal(publicSettings.configured, true);
  assert.equal(publicSettings.providerKeys.length, 1);
  assert.equal(publicSettings.providerKeys[0]?.providerId, "openai");
  assert.equal(publicSettings.providerKeys[0]?.label, "OpenAI");
  assert.equal(publicSettings.providerKeys[0]?.lastFour, "7890");
  assert.equal("apiKey" in (publicSettings.providerKeys[0] as Record<string, unknown>), false);

  publicSettings = await deleteCesiumProviderKey(publicSettings.providerKeys[0]!.id);
  assert.equal(publicSettings.configured, false);
});

test("resolveCesiumModelRuntime routes Nvidia models to chat completions with NIM base URL", async () => {
  await refreshCesiumModelCatalog().catch(() => undefined);
  const runtime = await resolveCesiumModelRuntime({
    modelId: "nvidia/minimaxai/minimax-m2.7",
    configuredApiKind: "openai-responses",
  });
  assert.equal(runtime.providerId, "nvidia");
  assert.equal(runtime.apiKind, "openai-chat-completions");
  assert.equal(runtime.baseUrl, "https://integrate.api.nvidia.com/v1");
});

test("upsertCesiumProviderKey keeps one stored key per provider", async () => {
  let publicSettings = await upsertCesiumProviderKey({
    providerId: "openai",
    apiKind: "openai-responses",
    apiKey: "sk-test-1111111111",
  });
  publicSettings = await upsertCesiumProviderKey({
    providerId: "openai",
    apiKind: "openai-responses",
    apiKey: "sk-test-9999999999",
  });
  const stored = publicSettings.providerKeys.filter((key) => key.source === "stored");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.providerId, "openai");
  assert.equal(stored[0]?.lastFour, "9999");
});

test("normalizeEventsToHistory backfills missing tool responses for OpenAI", () => {
  const toolIds = ["call-a", "call-b", "call-c"];
  const events = [
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message" as const,
      messageId: "u1",
      content: "Ask me a question",
    },
    ...toolIds.flatMap((toolCallId, index) => [
      {
        seq: 2 + index * 2,
        eventId: `tc-${toolCallId}`,
        conversationId: "c1",
        createdAt: 2 + index,
        kind: "tool_call" as const,
        toolCallId,
        title: "Ask question",
        toolKind: "question" as const,
        status: "in_progress" as const,
        raw: { id: toolCallId, name: "ask_question", arguments: {} },
      },
      ...(index === 0
        ? [
            {
              seq: 3 + index * 2,
              eventId: `tu-${toolCallId}`,
              conversationId: "c1",
              createdAt: 3 + index,
              kind: "tool_call_update" as const,
              toolCallId,
              title: "Ask question",
              toolKind: "question" as const,
              status: "completed" as const,
              detail: "ok",
            },
          ]
        : []),
    ]),
    {
      seq: 20,
      eventId: "end",
      conversationId: "c1",
      createdAt: 20,
      kind: "assistant_message_end" as const,
      messageId: "assistant-1",
      stopReason: "end_turn" as const,
    },
    {
      seq: 21,
      eventId: "u2",
      conversationId: "c1",
      createdAt: 21,
      kind: "user_message" as const,
      messageId: "u2",
      content: "next",
    },
  ];

  const apiMessages = openAiMessages(normalizeEventsToHistory(events as never));
  const assistant = apiMessages.find(
    (message) => (message as { role?: string }).role === "assistant" && "tool_calls" in message
  ) as { tool_calls?: Array<{ id: string }> } | undefined;
  assert.ok(assistant?.tool_calls?.length === 3);
  for (const id of toolIds) {
    const tool = apiMessages.find(
      (message) =>
        (message as { role?: string }).role === "tool" &&
        (message as { tool_call_id?: string }).tool_call_id === id
    );
    assert.ok(tool, `missing tool response for ${id}`);
  }
});

test("normalizeEventsToHistory pairs tool results with assistant tool_calls", () => {
  const history = normalizeEventsToHistory([
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "u1",
      content: "Run a command",
    },
    {
      seq: 2,
      eventId: "e2",
      conversationId: "c1",
      createdAt: 2,
      kind: "tool_call",
      toolCallId: "call-1",
      title: "Run uname -a",
      toolKind: "terminal",
      status: "in_progress",
      raw: { id: "call-1", name: "terminal", arguments: { command: "uname -a" } },
    },
    {
      seq: 3,
      eventId: "e3",
      conversationId: "c1",
      createdAt: 3,
      kind: "tool_call_update",
      toolCallId: "call-1",
      title: "Run uname -a",
      toolKind: "terminal",
      status: "completed",
      detail: "Linux",
    },
  ]);
  const apiMessages = openAiMessages(history);
  const assistant = apiMessages.find(
    (message) => (message as { role?: string }).role === "assistant" && "tool_calls" in message
  ) as { tool_calls?: Array<{ id: string }> } | undefined;
  const tool = apiMessages.find((message) => (message as { role?: string }).role === "tool") as
    | { tool_call_id?: string }
    | undefined;
  assert.ok(assistant?.tool_calls?.some((call) => call.id === "call-1"));
  assert.equal(tool?.tool_call_id, "call-1");
});

test("upsertCesiumProviderKey accepts csk- keys for Cerebras", async () => {
  const result = await upsertCesiumProviderKey({
    providerId: "cerebras",
    apiKind: "openai-compatible",
    apiKey: "csk-test-cerebras-style-key-12345678",
  });
  const stored = result.providerKeys.find((key) => key.providerId === "cerebras");
  assert.ok(stored);
  assert.equal(stored?.lastFour, "5678");
});

test("upsertCesiumProviderKey rejects unambiguous cross-provider keys", async () => {
  await assert.rejects(
    () =>
      upsertCesiumProviderKey({
        providerId: "openai",
        apiKind: "openai-responses",
        apiKey: "nvapi-test-nvidia-key-should-not-be-openai",
      }),
    /Nvidia/
  );
});

test("resolveCesiumModelRuntime uses catalog base URL for third-party providers", async () => {
  await refreshCesiumModelCatalog().catch(() => undefined);
  const runtime = await resolveCesiumModelRuntime({
    modelId: "nvidia/minimaxai/minimax-m2.7",
    configuredApiKind: "openai-responses",
  });
  assert.equal(runtime.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(runtime.apiKind, "openai-chat-completions");
});

test("resolveCesiumAuth prefers provider-specific keys over unrelated defaults", async () => {
  await upsertCesiumProviderKey({
    providerId: "openai",
    label: "OpenAI default",
    apiKind: "openai-responses",
    apiKey: "sk-openai-default-key",
  });
  await upsertCesiumProviderKey({
    providerId: "nvidia",
    label: "Nvidia NIM",
    apiKind: "openai-compatible",
    apiKey: "nvapi-test-nvidia-key-1234",
  });
  const auth = await resolveCesiumAuth({
    modelId: "nvidia/minimaxai/minimax-m2.7",
    configuredApiKind: "openai-responses",
  });
  assert.equal(auth.providerId, "nvidia");
  assert.equal(auth.apiKey, "nvapi-test-nvidia-key-1234");
  assert.equal(auth.apiKind, "openai-chat-completions");
  assert.equal(auth.baseUrl, "https://integrate.api.nvidia.com/v1");
});

test("Cesium session handle exposes pause and resume", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id: "cesium-pause-test",
    workspaceId: "ws-1",
    title: "Pause test",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "agent",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const statusEvents: string[] = [];
  const handle = await provider.startSession({
    conversation,
    workspace: { id: "ws-1", root: TEST_DATA_DIR, name: "test", createdAt: 1 },
    appendEvents: async (events) => {
      for (const event of events) {
        if (event.kind === "status") {
          statusEvents.push(event.status);
        }
      }
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });
  assert.equal(typeof handle.pause, "function");
  assert.equal(typeof handle.resume, "function");
  await handle.pause!();
  assert.equal(conversation.status, "pause_requested");
  assert.ok(statusEvents.includes("pause_requested"));
});

test("Cesium resume is a no-op until the session reaches paused", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id: "cesium-resume-noop",
    workspaceId: "ws-1",
    title: "Resume noop",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "running" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "agent",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const handle = await provider.startSession({
    conversation,
    workspace: { id: "ws-1", root: TEST_DATA_DIR, name: "test", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });

  await handle.pause!();
  assert.equal(conversation.status, "pause_requested");
  await handle.resume!();
  assert.equal(conversation.status, "pause_requested");
});

test("Cesium cancel always emits cancelled status", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id: "cesium-cancel-test",
    workspaceId: "ws-1",
    title: "Cancel test",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "running" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "agent",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const statusEvents: string[] = [];
  const handle = await provider.startSession({
    conversation,
    workspace: { id: "ws-1", root: TEST_DATA_DIR, name: "test", createdAt: 1 },
    appendEvents: async (events) => {
      for (const event of events) {
        if (event.kind === "status") {
          statusEvents.push(event.status);
        }
      }
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });

  await handle.cancel!();
  assert.equal(conversation.status, "cancelled");
  assert.ok(statusEvents.includes("cancelled"));
});
