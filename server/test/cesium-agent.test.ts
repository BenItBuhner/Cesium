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
delete process.env.OPENAI_BASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MISTRAL_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.TOGETHER_API_KEY;
delete process.env.FIREWORKS_API_KEY;
delete process.env.NVIDIA_API_KEY;
delete process.env.CEREBRAS_API_KEY;
delete process.env.CROFAI_API_KEY;
delete process.env.CESIUM_BASE_URL;
delete process.env.CESIUM_API_KEY;
delete process.env.CESIUM_DEFAULT_MODEL;
delete process.env.CESIUM_PROVIDER_ID;
delete process.env.CESIUM_MODELS;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const [
  { AGENT_BACKENDS, listAgentBackends },
  {
    getCesiumAgentSettingsPublic,
    upsertCesiumProviderKey,
    deleteCesiumProviderKey,
    patchCesiumAgentSettings,
    resolveCesiumModelRuntime,
    resolveCesiumAuth,
    refreshCesiumModelCatalog,
    normalizeCesiumContextWindow,
    DEFAULT_CESIUM_CONTEXT_WINDOW,
    findCesiumModelCatalogEntry,
    resolveCesiumModelContextWindow,
    createCesiumAgentConfigOptions,
    readCesiumEnvBootstrap,
    getCesiumModelCatalog,
  },
  { normalizeEventsToHistory, openAiMessages, cesiumPermissionToolKey, createCesiumAgentProvider, buildOpenAiToolDefinitions, sanitizeOpenAiCompatibleJsonSchema, normalizeCesiumToolResultForModel, isEmptyCesiumAdapterResult, normalizeCallMcpToolArgs },
  { buildCesiumBaseSystemPrompt },
  { resolveCesiumModeToolPolicy },
  { parsePlanEntriesFromMarkdown },
  { createGoalRecord, formatGoalForModel, validateGoalSnapshotSummary },
  { goalCompactionRecoveryContext, goalContinuationContext },
  { buildCesiumModeReminder },
  { resolveCesiumTools, resolveCesiumToolPermissionCategory },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("@cesium/core/mcp"),
  import("../src/lib/agents/cesium-mode-policy.js"),
  import("../src/lib/agents/cesium-plan-files.js"),
  import("../src/lib/agents/goal-store.js"),
  import("../src/lib/agents/goal-steering.js"),
  import("../src/lib/agents/cesium-mode-reminders.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

async function startCesiumTestSession(id: string) {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id,
    workspaceId: "ws-1",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "workflow",
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
  const events: Array<{
    kind: string;
    requestId?: string;
    detail?: string;
  }> = [];
  const handle = await provider.startSession({
    conversation,
    workspace: { id: "ws-1", root: TEST_DATA_DIR, name: "test", createdAt: 1 },
    appendEvents: async (next) => {
      events.push(...next);
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  });
  events.length = 0;
  return { handle, events, getConversation: () => conversation };
}

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
  assert.equal(
    cesiumPermissionToolKey("mcpCall", { serverId: "browser", toolName: "browser_click" }),
    "cesium:mcp:browser:browser_click"
  );
  assert.equal(
    cesiumPermissionToolKey("switchMode", { target_mode: "plan" }),
    "cesium:switch_mode:plan"
  );
  assert.equal(
    cesiumPermissionToolKey("switchMode", { targetMode: "Ask" }),
    "cesium:switch_mode:ask"
  );
  const workflowKey = cesiumPermissionToolKey("workflowLaunch", {
    script: 'export const meta = { name: "audit", description: "Audit" }; return 1;',
  });
  assert.match(workflowKey, /^cesium:workflow_launch:[a-f0-9]{24}$/);
  assert.equal(
    workflowKey,
    cesiumPermissionToolKey("workflowLaunch", {
      script: 'export const meta = { name: "audit", description: "Audit" }; return 1;',
    })
  );
});

test("workflow_run requires the dedicated workflow launch permission", () => {
  const tools = resolveCesiumTools().tools;
  assert.equal(
    resolveCesiumToolPermissionCategory(tools, "workflow_run"),
    "workflowLaunch"
  );
});

test("workflow_run describes tokenBudget as best-effort accounting", () => {
  const workflowRun = resolveCesiumTools().tools.find((tool) => tool.name === "workflow_run");
  const tokenBudget = (
    workflowRun?.parameters as {
      properties?: { tokenBudget?: { description?: string } };
    }
  ).properties?.tokenBudget;
  assert.match(tokenBudget?.description ?? "", /best-effort run-wide token budget/i);
  assert.match(tokenBudget?.description ?? "", /can make final usage exceed it/i);
  assert.doesNotMatch(tokenBudget?.description ?? "", /hard token ceiling/i);
});

test("workflow child tool execution suppresses transcript events but preserves permissions", async () => {
  const fs = await import("node:fs/promises");
  const relativePath = "workflow-child-permission.txt";
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DATA_DIR, relativePath), "before", "utf8");
  await patchCesiumAgentSettings({ toolPermissions: { editFile: "deny" } });
  try {
    const backend = AGENT_BACKENDS["cesium-agent"];
    const provider = await createCesiumAgentProvider({ backend });
    let conversation = {
      schemaVersion: 1 as const,
      id: "cesium-workflow-child-permission",
      workspaceId: "ws-1",
      title: "Workflow child permission",
      createdAt: 1,
      updatedAt: 1,
      lastEventSeq: 0,
      status: "idle" as const,
      config: {
        backendId: "cesium-agent" as const,
        mode: "workflow",
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
    const events: Array<{ kind: string }> = [];
    const handle = await provider.startSession({
      conversation,
      workspace: { id: "ws-1", root: TEST_DATA_DIR, name: "test", createdAt: 1 },
      appendEvents: async (next) => {
        events.push(...next);
      },
      readSnapshot: async () => null,
      updateConversation: async (patch) => {
        conversation =
          typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
        return conversation;
      },
    });
    events.length = 0;

    const result = await (
      handle as unknown as {
        executeTool(
          request: { id: string; name: string; arguments: Record<string, unknown> },
          options: { suppressTranscript: boolean }
        ): Promise<string>;
      }
    ).executeTool(
      {
        id: "child-edit",
        name: "edit_file",
        arguments: { path: relativePath, oldString: "before", newString: "after" },
      },
      { suppressTranscript: true }
    );

    assert.match(result, /blocked by Cesium permission settings/);
    assert.equal(await fs.readFile(path.join(TEST_DATA_DIR, relativePath), "utf8"), "before");
    assert.equal(events.some((event) => event.kind === "tool_call"), false);
    assert.equal(events.some((event) => event.kind === "tool_call_update"), false);
  } finally {
    await patchCesiumAgentSettings({ toolPermissions: { editFile: "ask" } });
  }
});

test("successful suppressed workflow child edit emits no orphan parent events", async () => {
  const fs = await import("node:fs/promises");
  const relativePath = "workflow-child-successful-edit.txt";
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DATA_DIR, relativePath), "before", "utf8");
  await patchCesiumAgentSettings({ toolPermissions: { editFile: "allow" } });
  try {
    const { handle, events } = await startCesiumTestSession(
      "cesium-workflow-child-successful-edit"
    );
    const privateHandle = handle as unknown as {
      executeTool(
        request: { id: string; name: string; arguments: Record<string, unknown> },
        options: { suppressTranscript: boolean; signal?: AbortSignal }
      ): Promise<string>;
    };
    const result = await privateHandle.executeTool(
      {
        id: "child-edit-success",
        name: "edit_file",
        arguments: { path: relativePath, oldString: "before", newString: "after" },
      },
      { suppressTranscript: true }
    );
    await privateHandle.executeTool(
      {
        id: "child-wait-success",
        name: "wait",
        arguments: { seconds: 0.001, reason: "suppressed child status" },
      },
      { suppressTranscript: true }
    );

    assert.equal(result, `Edited ${relativePath}.`);
    assert.equal(await fs.readFile(path.join(TEST_DATA_DIR, relativePath), "utf8"), "after");
    assert.deepEqual(events, []);
  } finally {
    await patchCesiumAgentSettings({ toolPermissions: { editFile: "ask" } });
  }
});

test("workflow child stop promptly interrupts wait and its terminal only", async () => {
  await patchCesiumAgentSettings({ toolPermissions: { terminal: "allow" } });
  const { handle, events } = await startCesiumTestSession(
    "cesium-workflow-child-abort-tools"
  );
  const privateHandle = handle as unknown as {
    executeTool(
      request: { id: string; name: string; arguments: Record<string, unknown> },
      options?: { suppressTranscript?: boolean; signal?: AbortSignal }
    ): Promise<string>;
    terminalRuns: Map<
      string,
      {
        process: {
          exitCode: number | null;
          killed: boolean;
          kill(signal?: NodeJS.Signals): boolean;
        };
      }
    >;
    killTerminalRuns(): void;
  };
  try {
    await privateHandle.executeTool({
      id: "unrelated-terminal",
      name: "terminal",
      arguments: {
        command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
        waitUntil: "background",
      },
    });
    const unrelated = [...privateHandle.terminalRuns.values()][0]!;
    events.length = 0;

    const waitController = new AbortController();
    const waitResult = privateHandle
      .executeTool(
        {
          id: "child-wait",
          name: "wait",
          arguments: { seconds: 60, reason: "workflow child wait" },
        },
        { suppressTranscript: true, signal: waitController.signal }
      )
      .then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.name : String(error))
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    waitController.abort();
    assert.equal(
      await Promise.race([
        waitResult,
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]),
      "AbortError"
    );

    const terminalController = new AbortController();
    const terminalResult = privateHandle
      .executeTool(
        {
          id: "child-terminal",
          name: "terminal",
          arguments: {
            command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
            waitUntil: "complete",
            timeoutMs: 60_000,
          },
        },
        { suppressTranscript: true, signal: terminalController.signal }
      )
      .then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.name : String(error))
      );
    while (privateHandle.terminalRuns.size < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    terminalController.abort();
    assert.equal(
      await Promise.race([
        terminalResult,
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]),
      "AbortError"
    );
    assert.equal(unrelated.process.exitCode, null);
    assert.equal(unrelated.process.killed, false);
    assert.deepEqual(events, []);
  } finally {
    privateHandle.killTerminalRuns();
    await patchCesiumAgentSettings({ toolPermissions: { terminal: "ask" } });
  }
});

test("parallel workflow child permissions are serialized and attributed", async () => {
  const fs = await import("node:fs/promises");
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DATA_DIR, "workflow-permission-a.txt"), "before-a", "utf8");
  await fs.writeFile(path.join(TEST_DATA_DIR, "workflow-permission-b.txt"), "before-b", "utf8");
  await patchCesiumAgentSettings({ toolPermissions: { editFile: "ask" } });
  const { handle, events, getConversation } = await startCesiumTestSession(
    "cesium-workflow-permission-queue"
  );
  const privateHandle = handle as unknown as {
    executeTool(
      request: { id: string; name: string; arguments: Record<string, unknown> },
      options: {
        suppressTranscript: boolean;
        permissionContext: string;
      }
    ): Promise<string>;
  };

  const first = privateHandle.executeTool(
    {
      id: "workflow-edit-a",
      name: "edit_file",
      arguments: {
        path: "workflow-permission-a.txt",
        oldString: "before-a",
        newString: "after-a",
      },
    },
    {
      suppressTranscript: true,
      permissionContext: "Workflow run-a child first requests this tool.",
    }
  );
  const second = privateHandle.executeTool(
    {
      id: "workflow-edit-b",
      name: "edit_file",
      arguments: {
        path: "workflow-permission-b.txt",
        oldString: "before-b",
        newString: "after-b",
      },
    },
    {
      suppressTranscript: true,
      permissionContext: "Workflow run-a child second requests this tool.",
    }
  );

  while (events.filter((event) => event.kind === "permission_request").length < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(events.filter((event) => event.kind === "permission_request").length, 1);
  const firstRequest = events.find((event) => event.kind === "permission_request")!;
  assert.match(firstRequest.detail ?? "", /Workflow run-a child first/);
  assert.equal(getConversation().pendingPermission?.requestId, firstRequest.requestId);
  await handle.answerPermission({
    requestId: firstRequest.requestId!,
    optionId: "allow_once",
  });

  while (events.filter((event) => event.kind === "permission_request").length < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const requests = events.filter((event) => event.kind === "permission_request");
  assert.match(requests[1]?.detail ?? "", /Workflow run-a child second/);
  assert.equal(getConversation().pendingPermission?.requestId, requests[1]?.requestId);
  await handle.answerPermission({
    requestId: requests[1]!.requestId!,
    optionId: "allow_once",
  });

  await Promise.all([first, second]);
  assert.equal(
    await fs.readFile(path.join(TEST_DATA_DIR, "workflow-permission-a.txt"), "utf8"),
    "after-a"
  );
  assert.equal(
    await fs.readFile(path.join(TEST_DATA_DIR, "workflow-permission-b.txt"), "utf8"),
    "after-b"
  );
});

test("workflow stop aborts a pending child permission request", async () => {
  const fs = await import("node:fs/promises");
  const relativePath = "workflow-permission-abort.txt";
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DATA_DIR, relativePath), "before", "utf8");
  await patchCesiumAgentSettings({ toolPermissions: { editFile: "ask" } });
  const { handle, events, getConversation } = await startCesiumTestSession(
    "cesium-workflow-permission-abort"
  );
  const privateHandle = handle as unknown as {
    executeTool(
      request: { id: string; name: string; arguments: Record<string, unknown> },
      options: {
        suppressTranscript: boolean;
        signal: AbortSignal;
        permissionContext: string;
      }
    ): Promise<string>;
  };
  const controller = new AbortController();
  const pending = privateHandle.executeTool(
    {
      id: "workflow-edit-abort",
      name: "edit_file",
      arguments: {
        path: relativePath,
        oldString: "before",
        newString: "after",
      },
    },
    {
      suppressTranscript: true,
      signal: controller.signal,
      permissionContext: "Workflow abort-test child requests this tool.",
    }
  );

  while (events.filter((event) => event.kind === "permission_request").length < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getConversation().pendingPermission, null);
  assert.equal(
    await fs.readFile(path.join(TEST_DATA_DIR, relativePath), "utf8"),
    "before"
  );
});

test("normalizeCallMcpToolArgs accepts nested, snake_case, and flat MCP tool shapes", () => {
  assert.deepEqual(
    normalizeCallMcpToolArgs({
      arguments: {
        server_id: "browser",
        tool_name: "browser_tabs",
        action: "list",
      },
    }),
    {
      serverId: "browser",
      toolName: "browser_tabs",
      arguments: { action: "list" },
    }
  );
  assert.deepEqual(
    normalizeCallMcpToolArgs({
      serverId: "linear",
      toolName: "search",
      query: "opencursor",
    }),
    {
      serverId: "linear",
      toolName: "search",
      arguments: { query: "opencursor" },
    }
  );
  assert.deepEqual(
    normalizeCallMcpToolArgs({
      serverId: "PHONE",
      toolName: "phone_snapshot",
    }),
    {
      serverId: "phone",
      toolName: "phone_snapshot",
      arguments: {},
    }
  );
  assert.deepEqual(
    normalizeCallMcpToolArgs({
      serverId: "browser",
      toolName: "browser_snapshot",
      arguments: { tabId: "tab-1" },
    }),
    {
      serverId: "browser",
      toolName: "browser_snapshot",
      arguments: { tabId: "tab-1" },
    }
  );
});

test("normalizeEventsToHistory preserves call_mcp_tool routing after failed tool updates", () => {
  const history = normalizeEventsToHistory([
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "u1",
      content: "Use browser MCP",
    },
    {
      seq: 2,
      eventId: "e2",
      conversationId: "c1",
      createdAt: 2,
      kind: "tool_call",
      toolCallId: "call-mcp-1",
      title: "Browser browser_tabs",
      toolKind: "mcp",
      status: "in_progress",
      raw: {
        id: "call-mcp-1",
        name: "call_mcp_tool",
        arguments: {
          serverId: "browser",
          toolName: "browser_tabs",
          arguments: { action: "list" },
        },
      },
    },
    {
      seq: 3,
      eventId: "e3",
      conversationId: "c1",
      createdAt: 3,
      kind: "tool_call_update",
      toolCallId: "call-mcp-1",
      title: "Browser browser_tabs",
      toolKind: "mcp",
      status: "failed",
      detail: "call_mcp_tool requires serverId and toolName.",
      raw: {
        request: {
          id: "call-mcp-1",
          name: "call_mcp_tool",
          arguments: {
            arguments: {
              server_id: "browser",
              tool_name: "browser_tabs",
              action: "list",
            },
          },
        },
        error: "call_mcp_tool requires serverId and toolName.",
      },
    },
  ] as never);
  const assistant = openAiMessages(history).find(
    (message) => (message as { role?: string }).role === "assistant" && "tool_calls" in message
  ) as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } | undefined;
  const call = assistant?.tool_calls?.[0];
  assert.equal(call?.function?.name, "call_mcp_tool");
  const parsed = JSON.parse(call?.function?.arguments ?? "{}") as {
    serverId?: string;
    toolName?: string;
    arguments?: { action?: string };
  };
  assert.equal(parsed.serverId, "browser");
  assert.equal(parsed.toolName, "browser_tabs");
  assert.equal(parsed.arguments?.action, "list");
});

test("Cesium compacts long tool outputs before feeding the next model call", () => {
  const first = normalizeCesiumToolResultForModel({
    toolName: "read_file",
    result: "a".repeat(50),
    usedToolResultChars: 0,
    perToolLimit: 10,
    totalLimit: 25,
  });
  assert.equal(first.content.length > 10, true);
  assert.equal(first.usedToolResultChars, 10);
  assert.equal(first.truncated, true);
  assert.match(first.content, /Full output is preserved/);

  const exhausted = normalizeCesiumToolResultForModel({
    toolName: "grep",
    result: "still large",
    usedToolResultChars: 25,
    perToolLimit: 10,
    totalLimit: 25,
  });
  assert.equal(exhausted.usedToolResultChars, 25);
  assert.equal(exhausted.truncated, true);
  assert.match(exhausted.content, /omitted from model context/);
});

test("Cesium detects upstream empty model responses without blocking text-only turns", () => {
  assert.equal(
    isEmptyCesiumAdapterResult({
      text: "",
      toolRequests: [],
      raw: { choices: [{ message: { content: "" } }] },
    }),
    true
  );
  assert.equal(
    isEmptyCesiumAdapterResult({
      text: "Here is a normal text-only response.",
      toolRequests: [],
    }),
    false
  );
  assert.equal(
    isEmptyCesiumAdapterResult({
      text: "",
      toolRequests: [{ id: "call-1", name: "orchestration_wait", arguments: {} }],
    }),
    false
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

test("upsertCesiumProviderKey allows OpenAI-format sk keys on OpenAI-compatible providers", async () => {
  const result = await upsertCesiumProviderKey({
    providerId: "model-proxy",
    label: "Model Proxy",
    apiKind: "openai-compatible",
    apiKey: "sk-proxy-style-key-abcdef123456",
    baseUrl: "https://infer.example.test/v1",
  });
  const stored = result.providerKeys.find((key) => key.providerId === "model-proxy");
  assert.ok(stored);
  assert.equal(stored?.lastFour, "3456");
});

test("readCesiumEnvBootstrap maps OPENAI_API_KEY onto a custom OpenAI-compatible host", () => {
  process.env.CESIUM_BASE_URL = "https://infer.techlitnow.com/v1";
  process.env.OPENAI_API_KEY = "sk-test-techlit-key";
  process.env.CESIUM_DEFAULT_MODEL = "glm-5.2";
  try {
    const bootstrap = readCesiumEnvBootstrap();
    assert.ok(bootstrap);
    assert.equal(bootstrap?.providerId, "techlit");
    assert.equal(bootstrap?.baseUrl, "https://infer.techlitnow.com/v1");
    assert.equal(bootstrap?.apiKey, "sk-test-techlit-key");
    assert.equal(bootstrap?.defaultModelId, "techlit/glm-5.2");
    assert.ok(bootstrap?.models.some((model) => model.id === "glm-5.2" && !model.supportsImages));
    assert.ok(bootstrap?.models.some((model) => model.id === "kimi-k2.7-code" && model.supportsImages));
  } finally {
    delete process.env.CESIUM_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CESIUM_DEFAULT_MODEL;
  }
});

test("resolveCesiumAuth uses env bootstrap for techlit models", async () => {
  process.env.CESIUM_BASE_URL = "https://infer.techlitnow.com/v1";
  process.env.OPENAI_API_KEY = "sk-test-techlit-auth-key";
  process.env.CESIUM_DEFAULT_MODEL = "kimi-k2.7-code";
  try {
    const auth = await resolveCesiumAuth({
      modelId: "techlit/kimi-k2.7-code",
    });
    assert.equal(auth.providerId, "techlit");
    assert.equal(auth.apiKey, "sk-test-techlit-auth-key");
    assert.equal(auth.baseUrl, "https://infer.techlitnow.com/v1");
    assert.equal(auth.apiKind, "openai-chat-completions");

    const catalog = await getCesiumModelCatalog();
    const kimi = findCesiumModelCatalogEntry("techlit/kimi-k2.7-code", catalog);
    const glm = findCesiumModelCatalogEntry("techlit/glm-5.2", catalog);
    assert.equal(kimi?.supportsImages, true);
    assert.equal(glm?.supportsImages, false);

    const publicSettings = await getCesiumAgentSettingsPublic();
    assert.ok(
      publicSettings.providerKeys.some(
        (key) => key.providerId === "techlit" && key.source === "env"
      )
    );
  } finally {
    delete process.env.CESIUM_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CESIUM_DEFAULT_MODEL;
  }
});

test("resolveCesiumAuth maps GROQ_API_KEY env onto the groq provider", async () => {
  process.env.GROQ_API_KEY = "gsk-test-groq-key-1234";
  try {
    const auth = await resolveCesiumAuth({
      modelId: "groq/llama-3.3-70b-versatile",
    });
    assert.equal(auth.providerId, "groq");
    assert.equal(auth.apiKey, "gsk-test-groq-key-1234");
    assert.equal(auth.baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(auth.apiKind, "openai-chat-completions");
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});

test("openAiMessages encodes image attachments as multimodal content parts", () => {
  const encoded = openAiMessages([
    { role: "system", content: "sys" },
    {
      role: "user",
      content: "describe this",
      images: [{ mimeType: "image/png", data: "aaaabbbb", name: "shot.png" }],
    },
  ]);
  const user = encoded.find((message) => (message as { role?: string }).role === "user") as {
    content?: Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
  };
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content?.[0]?.type, "text");
  assert.equal(user.content?.[0]?.text, "describe this");
  assert.equal(user.content?.[1]?.type, "image_url");
  assert.equal(user.content?.[1]?.image_url?.url, "data:image/png;base64,aaaabbbb");
});

test("normalizeEventsToHistory preserves user image attachments", () => {
  const history = normalizeEventsToHistory([
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "u1",
      content: "look",
      attachments: [{ mimeType: "image/jpeg", data: "deadbeef", name: "a.jpg" }],
    },
  ] as never);
  const user = history.find((message) => message.role === "user");
  assert.equal(user?.content, "look");
  assert.equal(user?.images?.length, 1);
  assert.equal(user?.images?.[0]?.mimeType, "image/jpeg");
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

test("resolveCesiumAuth matches custom provider keys without custom prefix", async () => {
  await upsertCesiumProviderKey({
    providerId: "model-proxy",
    label: "Model Proxy",
    apiKind: "openai-compatible",
    apiKey: "model-proxy-test-key",
    baseUrl: "https://infer.example.test/v1",
  });
  await patchCesiumAgentSettings({
    customProviders: [
      {
        id: "custom-model-proxy",
        name: "Model Proxy",
        apiKind: "openai-chat-completions",
        baseUrl: "https://infer.example.test/v1",
        models: [{ id: "glm-5.1-precision", name: "GLM 5.1 Precision" }],
      },
    ],
  });

  const auth = await resolveCesiumAuth({
    modelId: "custom-model-proxy/glm-5.1-precision",
  });

  assert.equal(auth.providerId, "custom-model-proxy");
  assert.equal(auth.apiKey, "model-proxy-test-key");
  assert.equal(auth.apiKind, "openai-chat-completions");
  assert.equal(auth.baseUrl, "https://infer.example.test/v1");
});

test("custom provider models can advertise image/multimodal support", async () => {
  await patchCesiumAgentSettings({
    customProviders: [
      {
        id: "vision-proxy",
        name: "Vision Proxy",
        apiKind: "openai-compatible",
        baseUrl: "https://infer.example.test/v1",
        models: [
          { id: "text-only", name: "Text Only" },
          { id: "vision-model", name: "Vision Model", supportsImages: true },
        ],
      },
    ],
  });

  const catalog = await getCesiumModelCatalog();
  const textOnly = catalog.find((entry) => entry.modelId === "vision-proxy/text-only");
  const vision = catalog.find((entry) => entry.modelId === "vision-proxy/vision-model");
  assert.equal(textOnly?.supportsImages, false);
  assert.equal(vision?.supportsImages, true);

  await patchCesiumAgentSettings({ customProviders: [] });
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

test("Cesium session initialize preserves orchestration mode in configOptions", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id: "cesium-orchestration-init",
    workspaceId: "ws-1",
    title: "Orchestration init",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "orchestration",
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
  await provider.startSession({
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
  assert.equal(conversation.config.mode, "orchestration");
  assert.equal(
    conversation.configOptions.find((option) => option.id === "mode")?.currentValue,
    "orchestration"
  );
});

test("Cesium config options include dynamic prompt modes", async () => {
  const options = await createCesiumAgentConfigOptions();
  const modeOption = options.find((option) => option.id === "mode");
  assert.equal(modeOption?.options.some((option) => option.value === "ask"), true);
  assert.equal(modeOption?.options.some((option) => option.value === "plan"), true);
  assert.deepEqual(modeOption?.options.map((option) => option.value), [
    "agent",
    "plan",
    "orchestration",
    "goal",
    "workflow",
    "ask",
  ]);
  assert.equal(modeOption?.options.some((option) => option.value === "goal"), true);
  assert.equal(modeOption?.options.some((option) => option.value === "workflow"), true);
});

test("Cesium mode preferences remove disabled modes from the live catalog", async () => {
  await patchCesiumAgentSettings({
    modes: {
      enabled: {
        plan: false,
        goal: false,
      },
    },
  });
  const options = await createCesiumAgentConfigOptions();
  const modeIds = options
    .find((option) => option.id === "mode")
    ?.options.map((option) => option.value);
  assert.deepEqual(modeIds, ["agent", "orchestration", "workflow", "ask"]);

  await patchCesiumAgentSettings({
    modes: {
      enabled: {
        plan: true,
        goal: true,
      },
    },
  });
});

test("Goal records start in planning with durable milestones and todos", () => {
  const goal = createGoalRecord({
    workspace: {
      id: "ws-burn",
      root: TEST_DATA_DIR,
      name: "Goal workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversationId: "conv-burn",
    objective: "Ship the hybrid Goal mode.",
  });
  assert.equal(goal.status, "planning");
  assert.equal(goal.phase, "planning");
  assert.equal(goal.objective, "Ship the hybrid Goal mode.");
  assert.deepEqual(goal.milestones, []);
  assert.deepEqual(goal.todos, []);
  assert.equal(goal.progressPercent, null);
  assert.equal(goal.headline, null);
  assert.equal(goal.revision, 0);
  assert.deepEqual(goal.snapshots, []);
  assert.equal(goal.compaction.generation, 0);
});

test("Goal progress snapshots require the OpenCode-style markdown sections", () => {
  assert.doesNotThrow(() =>
    validateGoalSnapshotSummary([
      "## Progress",
      "- Implemented snapshot storage.",
      "## Current State",
      "- Goal is still active.",
      "## Blockers",
      "- None.",
      "## Next Steps",
      "- Add verification.",
    ].join("\n"))
  );
  assert.throws(
    () => validateGoalSnapshotSummary("## Progress\n- Only one section."),
    /missing the ## Current State section/
  );
});

test("Goal continuation context preserves objective and blocker audit rules", () => {
  const goal = createGoalRecord({
    workspace: {
      id: "ws-burn",
      root: TEST_DATA_DIR,
      name: "Goal workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversationId: "conv-burn",
    objective: "Finish <all> requirements & verify them.",
  });
  const context = goalContinuationContext({
    ...goal,
    progressPercent: 42,
    headline: "Halfway through Goal verification",
    revision: 3,
    snapshots: [
      {
        id: "snapshot-1",
        createdAt: 1,
        progressPercent: 42,
        headline: "Halfway through Goal verification",
        summary: [
          "## Progress",
          "- Wrote snapshot plumbing.",
          "## Current State",
          "- Verification remains.",
          "## Blockers",
          "- None.",
          "## Next Steps",
          "- Run focused tests.",
        ].join("\n"),
        revision: 3,
      },
    ],
  });
  assert.match(context, /<goal_context>/);
  assert.match(context, /Finish &lt;all&gt; requirements &amp; verify them\./);
  assert.match(context, /at least three Goal turns/);
  assert.match(context, /Do not call goal_complete/);
  assert.match(context, /Latest progress snapshot:/);
  assert.match(context, /Progress: 42%/);
  assert.match(context, /Halfway through Goal verification/);
  assert.match(context, /Freshness: stale/);
  assert.match(context, /Recent progress summary history:/);
  assert.match(context, /Do not stop after a progress snapshot/);
  const recovery = goalCompactionRecoveryContext({
    ...goal,
    progressPercent: 42,
    headline: "Halfway through Goal verification",
    revision: 3,
    snapshots: [
      {
        id: "snapshot-1",
        createdAt: 1,
        progressPercent: 42,
        headline: "Halfway through Goal verification",
        summary: [
          "## Progress",
          "- Wrote snapshot plumbing.",
          "## Current State",
          "- Verification remains.",
          "## Blockers",
          "- None.",
          "## Next Steps",
          "- Run focused tests.",
        ].join("\n"),
        revision: 3,
      },
    ],
  });
  assert.match(recovery, /Latest progress snapshot:/);
  assert.match(recovery, /Progress: 42%/);
  assert.match(recovery, /Recent progress summary history:/);
});

test("Goal model summary includes snapshot freshness and recent history", () => {
  const goal = createGoalRecord({
    workspace: {
      id: "ws-burn-model",
      root: TEST_DATA_DIR,
      name: "Goal workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversationId: "conv-burn-model",
    objective: "Ship the Goal UI summary view.",
  });
  const summary = formatGoalForModel({
    ...goal,
    progressPercent: 70,
    headline: "Summary view is underway",
    revision: 2,
    snapshots: [
      {
        id: "snapshot-old",
        createdAt: 1,
        progressPercent: 35,
        headline: "Backend summary stored",
        summary: [
          "## Progress",
          "- Stored backend summary.",
          "## Current State",
          "- UI remains.",
          "## Blockers",
          "- None.",
          "## Next Steps",
          "- Add UI.",
        ].join("\n"),
        revision: 1,
      },
      {
        id: "snapshot-new",
        createdAt: Date.now(),
        progressPercent: 70,
        headline: "Summary view is underway",
        summary: [
          "## Progress",
          "- Added UI shell.",
          "## Current State",
          "- Tests remain.",
          "## Blockers",
          "- None.",
          "## Next Steps",
          "- Verify.",
        ].join("\n"),
        revision: 2,
      },
    ],
  });

  assert.match(summary, /Latest summary freshness: fresh/);
  assert.match(summary, /## Recent Progress Snapshot History/);
  assert.match(summary, /Previous Progress Snapshot/);
  assert.match(summary, /Latest Progress Snapshot/);
  assert.match(summary, /Summary view is underway/);
});

test("Cesium base prompt and tool schema are stable across dynamic modes", () => {
  const base = buildCesiumBaseSystemPrompt();
  assert.equal(base, buildCesiumBaseSystemPrompt());
  assert.doesNotMatch(base, /current mode is \*\*/i);
  const tools = buildOpenAiToolDefinitions();
  assert.deepEqual(tools, buildOpenAiToolDefinitions());
  const names = tools.map((tool) => tool.function.name);
  assert.equal(names.includes("goal_set"), true);
  assert.equal(names.includes("goal_summarize"), true);
  assert.equal(names.includes("goal_pause"), true);
  assert.equal(names.includes("goal_block"), true);
  assert.equal(names.includes("goal_complete"), true);
  assert.equal(names.includes("workflow_run"), true);
  assert.equal(names.includes("workflow_status"), true);
  assert.equal(names.includes("workflow_await"), true);
  assert.equal(names.includes("workflow_control"), true);
  assert.equal(names.includes("wait"), true);
  assert.equal(names.includes("switch_mode"), true);
  assert.equal(names.includes("goal_update_plan"), false);
  assert.equal(names.includes("goal_update_progress"), false);
  assert.equal(names.includes("goal_summarize_state"), false);
  assert.equal(names.includes("goal_resume"), false);
});

test("Cesium Goal reminder uses Goal tools instead of generic goal state phrases", () => {
  const reminder = buildCesiumModeReminder({
    mode: "goal",
    workspaceRoot: TEST_DATA_DIR,
    dateLabel: "today",
    gitSummary: "clean",
    mcpSummaries: [],
  });
  assert.match(reminder, /goal_set/);
  assert.match(reminder, /goal_summarize/);
  assert.match(reminder, /goal_complete/);
  assert.match(reminder, /latest summary is missing or materially stale/);
  assert.match(reminder, /Do not call it every turn/);
  assert.doesNotMatch(reminder, /GOAL_STATE:/);
});

test("Cesium system reminders are injected into targeted user turns", () => {
  const history = normalizeEventsToHistory([
    {
      seq: 1,
      eventId: "u1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message",
      messageId: "m1",
      content: "What mode am I in?",
    },
    {
      seq: 2,
      eventId: "r1",
      conversationId: "c1",
      createdAt: 2,
      kind: "system_reminder",
      reminderId: "mode-m1",
      targetMessageId: "m1",
      reason: "mode",
      text: "<system-reminder>You are now in **ask mode**.</system-reminder>",
    },
  ] as never);
  const user = history.find((message) => message.role === "user");
  assert.match(user?.content as string, /system-reminder/);
  assert.match(user?.content as string, /What mode am I in/);
});

test("Cesium mode policy blocks write tools in Ask and permits plan tools in Plan", () => {
  assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName: "edit_file" }).allowed, false);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName: "read_file" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName: "wait" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName: "switch_mode" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "plan", toolName: "create_plan" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "plan", toolName: "wait" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "plan", toolName: "switch_mode" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "orchestration", toolName: "wait" }).allowed, true);
  assert.equal(
    resolveCesiumModeToolPolicy({ mode: "orchestration", toolName: "switch_mode" }).allowed,
    true
  );
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "wait" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "switch_mode" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "orchestration_create_issue" }).allowed, false);
});

test("Cesium switch_mode tool is registered with switchMode permission metadata", async () => {
  const { resolveCesiumTools, resolveCesiumToolPermissionCategory, toolTitle } = await import(
    "../src/lib/agents/cesium/cesium-tools.js"
  );
  const harness = resolveCesiumTools();
  const switchMode = harness.tools.find((tool) => tool.name === "switch_mode");
  assert.ok(switchMode);
  assert.equal(switchMode?.requiresPermission, "switchMode");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "edit_file"), "editFile");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "terminal"), "terminal");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "call_mcp_tool"), "mcpCall");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "switch_mode"), "switchMode");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "read_file"), undefined);
  assert.equal(toolTitle("switch_mode", { target_mode: "plan" }), "Switch to plan mode");
});

test("Cesium wait tool parses seconds, caps duration, and formats titles", async () => {
  const { parseWaitToolArgs, toolTitle, formatWaitDurationLabel } = await import(
    "../src/lib/agents/cesium/cesium-tools.js"
  );
  const { WAIT_MAX_SECONDS } = await import("../src/lib/agents/cesium/cesium-prompt.js");

  assert.deepEqual(parseWaitToolArgs({ seconds: 2.5, reason: "deploy settle" }), {
    seconds: 2.5,
    durationMs: 2500,
    reason: "deploy settle",
    capped: false,
  });
  assert.equal(parseWaitToolArgs({ seconds: WAIT_MAX_SECONDS + 10 }).capped, true);
  assert.equal(parseWaitToolArgs({ seconds: WAIT_MAX_SECONDS + 10 }).seconds, WAIT_MAX_SECONDS);
  assert.throws(() => parseWaitToolArgs({ seconds: 0 }), /positive number/);
  assert.throws(() => parseWaitToolArgs({}), /positive number/);
  assert.equal(formatWaitDurationLabel(90), "1m 30s");
  assert.equal(formatWaitDurationLabel(3600), "1h");
  assert.equal(toolTitle("wait", { seconds: 120, reason: "build" }), "Wait 2m: build");
  assert.equal(toolTitle("wait", { seconds: 0.5 }), "Wait 0.5s");
});

test("Cesium tool schema includes dedicated wait tool", () => {
  const tools = buildOpenAiToolDefinitions();
  const wait = tools.find((tool) => tool.function.name === "wait");
  assert.ok(wait);
  assert.match(wait.function.description, /seconds/i);
  assert.equal(
    (wait.function.parameters as { required?: string[] }).required?.includes("seconds"),
    true
  );
});

test("Cesium plan markdown parser projects checklist statuses", () => {
  const entries = parsePlanEntriesFromMarkdown(
    ["# Example", "", "- [ ] Discover files", "- [x] Draft plan", "- [!] Blocked by auth"].join("\n")
  );
  assert.deepEqual(entries.map((entry) => entry.status), ["pending", "completed", "blocked"]);
  assert.equal(entries[0]?.content, "Discover files");
});

test("Cesium setConfigOption does not clobber orchestration mode when changing model", async () => {
  const backend = AGENT_BACKENDS["cesium-agent"];
  const provider = await createCesiumAgentProvider({ backend });
  let conversation = {
    schemaVersion: 1 as const,
    id: "cesium-orchestration-model",
    workspaceId: "ws-1",
    title: "Orchestration model",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle" as const,
    config: {
      backendId: "cesium-agent" as const,
      mode: "orchestration",
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
  await handle.setConfigOption!("model", "anthropic/claude-sonnet-4-5-20250929");
  assert.equal(conversation.config.mode, "orchestration");
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

test("buildOpenAiToolDefinitions avoids JSON Schema union type arrays for OpenAI-compatible hosts", () => {
  const tools = buildOpenAiToolDefinitions();
  assert.ok(tools.length > 0);
  const serialized = JSON.stringify(tools);
  assert.equal(serialized.includes('"type":["string","null"]'), false);
  assert.deepEqual(sanitizeOpenAiCompatibleJsonSchema({ type: ["string", "null"] }), {
    type: "string",
  });
  const updateIssue = tools.find((tool) => tool.function.name === "orchestration_update_issue");
  assert.ok(updateIssue);
  const blockedReason = (updateIssue!.function.parameters as { properties?: Record<string, unknown> })
    .properties?.blockedReason as { type?: unknown } | undefined;
  assert.equal(blockedReason?.type, "string");
});

test("default Cesium orchestration settings continue when work remains", async () => {
  const settings = await getCesiumAgentSettingsPublic();
  assert.equal(settings.orchestration.continueWhenIncomplete, true);
});

test("patchCesiumAgentSettings persists orchestration continue toggle", async () => {
  const patched = await patchCesiumAgentSettings({
    orchestration: { continueWhenIncomplete: false },
  });
  assert.equal(patched.orchestration.continueWhenIncomplete, false);
  await patchCesiumAgentSettings({
    orchestration: { continueWhenIncomplete: true },
  });
});

test("normalizeCesiumContextWindow defaults invalid provider values to 100k", () => {
  assert.equal(DEFAULT_CESIUM_CONTEXT_WINDOW, 100_000);
  assert.equal(normalizeCesiumContextWindow(undefined), 100_000);
  assert.equal(normalizeCesiumContextWindow(null), 100_000);
  assert.equal(normalizeCesiumContextWindow(0), 100_000);
  assert.equal(normalizeCesiumContextWindow(-1), 100_000);
  assert.equal(normalizeCesiumContextWindow({ context: 128_000 }), 100_000);
  assert.equal(normalizeCesiumContextWindow("not-a-number"), 100_000);
  assert.equal(normalizeCesiumContextWindow(128_000), 128_000);
  assert.equal(normalizeCesiumContextWindow("262144"), 262_144);
});

test("findCesiumModelCatalogEntry applies default context window for missing values", () => {
  const entry = findCesiumModelCatalogEntry("custom/host-model", [
    {
      providerId: "custom",
      providerName: "Custom",
      modelId: "custom/host-model",
      modelName: "Custom/Host Model",
      apiKind: "openai-compatible",
      supportsTools: true,
      supportsReasoning: false,
      supportsStructuredOutput: false,
    },
  ]);
  assert.ok(entry);
  assert.equal(entry!.contextWindow, 100_000);
});

test("createCesiumAgentConfigOptions includes default context window metadata", async () => {
  await patchCesiumAgentSettings({
    customProviders: [
      {
        id: "custom-host",
        name: "Custom Host",
        apiKind: "openai-compatible",
        baseUrl: "https://example.com/v1",
        models: [{ id: "plain-model", name: "Plain Model" }],
      },
    ],
  });
  const options = await createCesiumAgentConfigOptions();
  const modelOption = options
    .find((option) => option.id === "model")
    ?.options.find((option) => option.value === "custom-host/plain-model");
  assert.ok(modelOption);
  assert.match(modelOption!.description ?? "", /100,000 ctx/);
  assert.equal(modelOption!.metadata?.contextWindow, "100000");
});

test("resolveCesiumModelContextWindow falls back to default for unknown models", async () => {
  assert.equal(await resolveCesiumModelContextWindow("missing/provider-model"), 100_000);
});
