import assert from "node:assert/strict";
import { test } from "node:test";

const [
  { AGENT_BACKENDS, listAgentBackends },
  { CodexAppServerTransport },
  {
    codexAppServerConfigDefaultsFromConfigRead,
    codexAppServerOptionsFromModels,
    isStaleCodexAppServerCache,
  },
  {
    approvalPolicyForPermission,
    codexMcpServerConfigFromSdk,
    contextUsageFromTokenUsage,
    isCodexThreadNotFoundError,
    resolveCodexModelEffort,
    sandboxModeForPermission,
    sandboxPolicyForPermission,
  },
  {
    canonicalizeCodexAppServerItem,
    codexAppServerApprovalResponse,
    codexAppServerAssistantTextFromItem,
    codexAppServerAsyncQuestionsFromItem,
    codexAppServerCommandLabel,
    codexAppServerDecisionForOption,
    codexAppServerElicitationFormResponse,
    codexAppServerElicitationQuestion,
    codexAppServerErrorSummary,
    codexAppServerPermissionRequestFromServerRequest,
    codexAppServerPlanEntriesFromTurnPlan,
    codexAppServerPlanTextFromItem,
    codexAppServerReasoningTextFromItem,
    codexAppServerStatusFromTurn,
    codexAppServerTextDelta,
    codexAppServerTokenUsage,
    codexAppServerToolEventFromItem,
    codexAppServerUnwrapErrorMessage,
    codexAppServerUserInputRequest,
    codexAppServerUserInputResponse,
  },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/codex-app-server-transport.js"),
  import("../src/lib/agents/provider-cache-store.js"),
  import("../src/lib/agents/codex-app-server-provider.js"),
  import("../src/lib/agents/codex-app-server-normalize.js"),
]);

test("codex app server backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const appServerIndex = backends.findIndex((backend) => backend.id === "codex-app-server");
  assert.ok(appServerIndex >= 0);
  assert.equal(AGENT_BACKENDS["codex-app-server"].label, "Codex");
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsStructuredPlans, true);
  // Codex records `<turn_aborted>` and `thread/resume` restores the context, so
  // Stop must keep the thread instead of restarting a blank session.
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsCancelResume, true);
});

test("codex app server treats old gpt-5.1-only catalogs as stale", () => {
  assert.equal(
    isStaleCodexAppServerCache([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [
          { value: "gpt-5.1-codex", name: "gpt-5.1-codex" },
          { value: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini" },
          { value: "gpt-5.1", name: "gpt-5.1" },
        ],
      },
    ]),
    true
  );

  assert.equal(
    isStaleCodexAppServerCache([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.5",
        options: [
          { value: "gpt-5.5", name: "GPT-5.5" },
          { value: "gpt-5.4", name: "gpt-5.4" },
          { value: "gpt-5.2", name: "gpt-5.2" },
        ],
      },
    ]),
    false
  );
});

test("codex app server keeps effort capabilities scoped to each model", () => {
  const options = codexAppServerOptionsFromModels([
    {
      id: "gpt-5.6-soul",
      displayName: "GPT-5.6 Soul",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
    },
    {
      id: "claude-fable-5",
      displayName: "Claude Fable 5",
      supportedReasoningEfforts: [],
    },
  ]);
  const models = options.find((option) => option.id === "model")?.options;
  assert.deepEqual(models?.[0]?.metadata?.reasoningLevels, ["low", "high"]);
  assert.equal(models?.[0]?.metadata?.defaultReasoningEffort, "high");
  assert.equal(models?.[1]?.metadata?.reasoningLevels, undefined);
  assert.deepEqual(
    options.find((option) => option.id === "model_reasoning_effort")?.options.map((option) => option.value),
    ["low", "high"]
  );
  assert.equal(resolveCodexModelEffort(options, "gpt-5.6-soul", "high"), "high");
  // Unsupported requests fall back to the model's own default, never a guess.
  assert.equal(resolveCodexModelEffort(options, "gpt-5.6-soul", "xhigh"), "high");
  assert.equal(resolveCodexModelEffort(options, "claude-fable-5", "high"), undefined);
  assert.equal(resolveCodexModelEffort(options, "kimi-k3", "high"), undefined, "unknown custom models let Codex decide");
});

test("codex app server catalog surfaces the config.toml model for custom providers", () => {
  const defaults = codexAppServerConfigDefaultsFromConfigRead({
    config: { model: "kimi-k3", model_provider: "techlit", model_reasoning_effort: null },
  });
  assert.deepEqual(defaults, { model: "kimi-k3", modelProvider: "techlit", reasoningEffort: undefined });
  const options = codexAppServerOptionsFromModels(
    [
      {
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "ultra" }],
      },
    ],
    defaults
  );
  const model = options.find((option) => option.id === "model");
  assert.equal(model?.currentValue, "kimi-k3");
  assert.equal(model?.options[0]?.value, "kimi-k3");
  assert.match(model?.options[0]?.name ?? "", /kimi-k3 \(techlit\)/);
  assert.equal(model?.options[1]?.value, "gpt-6-astra");
  const effort = options.find((option) => option.id === "model_reasoning_effort");
  assert.equal(effort?.currentValue, "medium");
  assert.deepEqual(effort?.options.map((option) => option.value), ["low", "medium", "ultra"]);

  // Without a custom provider the server default wins.
  const openai = codexAppServerOptionsFromModels(
    [{ id: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }],
    codexAppServerConfigDefaultsFromConfigRead({ config: { model_provider: "openai" } })
  );
  assert.equal(openai.find((option) => option.id === "model")?.currentValue, "gpt-6-astra");
  assert.equal(openai.find((option) => option.id === "model_reasoning_effort")?.currentValue, "low");
});

test("codex app server maps Cesium execution modes onto v2 approval and sandbox policies", () => {
  delete process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS;
  assert.equal(approvalPolicyForPermission("workspace-write"), "on-request");
  assert.equal(approvalPolicyForPermission("read-only"), "on-request");
  assert.equal(approvalPolicyForPermission("on-request"), "untrusted");
  assert.equal(approvalPolicyForPermission("bypassPermissions"), "on-request", "bypass requires the env opt-in");
  assert.deepEqual(sandboxPolicyForPermission("workspace-write", "/repo"), {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.deepEqual(sandboxPolicyForPermission("read-only", "/repo"), { type: "readOnly", networkAccess: true });
  assert.deepEqual(sandboxPolicyForPermission("workspace-write", "/repo", "plan"), { type: "readOnly", networkAccess: true });
  assert.equal(sandboxModeForPermission("workspace-write"), "workspace-write");
  assert.equal(sandboxModeForPermission("workspace-write", "ask"), "read-only");
  process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS = "1";
  assert.equal(approvalPolicyForPermission("bypassPermissions"), "never");
  assert.deepEqual(sandboxPolicyForPermission("bypassPermissions", "/repo"), { type: "dangerFullAccess" });
  assert.equal(sandboxModeForPermission("bypassPermissions"), "danger-full-access");
  delete process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS;
});

test("codex app server converts Cesium MCP servers into config.toml overrides", () => {
  const { config, skipped } = codexMcpServerConfigFromSdk({
    "cesium-browser": { type: "http", url: "http://127.0.0.1:9100/mcp/browser", headers: { Authorization: "Bearer x" } },
    "local tools!": { type: "stdio", command: "npx", args: ["-y", "tool"], env: { A: "1" }, cwd: "/repo" },
    "sse-thing": { type: "sse", url: "http://127.0.0.1:1/sse" },
  });
  assert.deepEqual(config["cesium-browser"], {
    url: "http://127.0.0.1:9100/mcp/browser",
    http_headers: { Authorization: "Bearer x" },
  });
  assert.deepEqual(config.local_tools_, { command: "npx", args: ["-y", "tool"], env: { A: "1" }, cwd: "/repo" });
  assert.deepEqual(config["sse-thing"], { url: "http://127.0.0.1:1/sse" });
  assert.deepEqual(skipped, []);
});

test("codex app server normalizes assistant, plan and reasoning items", () => {
  assert.deepEqual(
    codexAppServerTextDelta({ itemId: "item_1", delta: "pong" }),
    { itemId: "item_1", text: "pong" }
  );
  assert.equal(
    codexAppServerAssistantTextFromItem({ id: "item_1", type: "agentMessage", text: "final pong" }),
    "final pong"
  );
  assert.equal(codexAppServerPlanTextFromItem({ id: "p", type: "plan", text: "# Plan" }), "# Plan");
  assert.equal(codexAppServerPlanTextFromItem({ id: "p", type: "agentMessage", text: "x" }), null);
  assert.equal(
    codexAppServerReasoningTextFromItem({ id: "r", type: "reasoning", summary: [], content: ["raw thinking"] }),
    "raw thinking"
  );
  assert.equal(
    codexAppServerReasoningTextFromItem({ id: "r", type: "reasoning", summary: ["part one", "part two"], content: ["raw"] }),
    "part one\n\npart two",
    "summaries win over raw content when both exist"
  );
  assert.deepEqual(
    codexAppServerAsyncQuestionsFromItem({
      id: "m",
      type: "agentMessage",
      text: "Should I continue?",
      delivery: "async",
      questions: [{ title: "Continue?", options: ["Yes", "No"] }, { title: "Free form", options: null }],
    }),
    [
      { id: "q1", prompt: "Continue?", options: [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }], allowMultiple: false },
      { id: "q2", prompt: "Free form", options: [], allowMultiple: false },
    ]
  );
});

test("codex app server normalizes plan status values", () => {
  const entries = codexAppServerPlanEntriesFromTurnPlan({
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "inProgress" },
      { step: "Wait for deploy", status: "blocked" },
      { step: "Verify", status: "pending" },
    ],
  });
  assert.deepEqual(
    entries.map((entry) => entry.status),
    ["completed", "in_progress", "blocked", "pending"]
  );
});

test("codex app server canonicalizes collab task raw payloads for frontend routing", () => {
  const legacy = canonicalizeCodexAppServerItem({
    id: "task_1",
    type: "collabToolCall",
    receiverThreadId: "child_1",
    newThreadId: "child_2",
    prompt: "Inspect the repo",
  });
  assert.equal(legacy.type, "collab_tool_call");
  assert.deepEqual(legacy.receiver_thread_ids, ["child_1"]);
  assert.equal(legacy.receiver_thread_id, "child_1");
  assert.equal(legacy.new_thread_id, "child_2");

  const current = canonicalizeCodexAppServerItem({
    id: "task_2",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    senderThreadId: "root",
    receiverThreadIds: ["child_9"],
    agentsStates: { child_9: { status: "running", message: null } },
    status: "inProgress",
  });
  assert.equal(current.type, "collab_tool_call");
  assert.deepEqual(current.receiver_thread_ids, ["child_9"]);
  assert.equal(current.receiver_thread_id, "child_9");
  assert.equal(current.sender_thread_id, "root");
  assert.deepEqual(current.agents_states, { child_9: { status: "running", message: null } });

  const event = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "task_2", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child_9"], status: "completed", agentsStates: { child_9: { status: "completed", message: "done" } } },
  });
  assert.equal(event?.title, "Wait for agent");
  assert.equal(event?.toolKind, "task");
  assert.equal(event?.status, "completed");
  assert.match(event?.detail ?? "", /child_9 · completed · done/);

  const activity = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "act_1", type: "subAgentActivity", kind: "interrupted", agentThreadId: "child_3", agentPath: "root/reviewer" },
  });
  assert.equal(activity?.title, "reviewer interrupted");
  assert.equal(activity?.status, "cancelled");
  assert.deepEqual((activity?.raw as { receiver_thread_ids?: string[] }).receiver_thread_ids, ["child_3"]);
});

test("codex app server unwraps shell wrappers when labelling commands", () => {
  assert.equal(codexAppServerCommandLabel("/bin/bash -lc pwd"), "pwd");
  assert.equal(codexAppServerCommandLabel("/bin/bash -lc 'ls -la && cat x'"), "ls -la && cat x");
  assert.equal(codexAppServerCommandLabel('bash -c "echo hi"'), "echo hi");
  assert.equal(codexAppServerCommandLabel("pwsh -NoProfile -Command Get-ChildItem"), "Get-ChildItem");
  assert.equal(codexAppServerCommandLabel(["npm", "test"]), "npm test");
  assert.equal(
    codexAppServerCommandLabel("/bin/bash -lc irrelevant", [{ type: "read", command: "cat README.md", name: "README.md", path: "/repo/README.md" }]),
    "cat README.md",
    "parsed command actions are preferred"
  );
});

test("codex app server normalizes command and file items", () => {
  const command = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: {
      id: "cmd_1",
      type: "commandExecution",
      command: "/bin/bash -lc pwd",
      commandActions: [{ type: "unknown", command: "pwd" }],
      status: "inProgress",
      aggregatedOutput: "/tmp\n",
    },
  });
  assert.equal(command?.kind, "tool_call");
  assert.equal(command?.toolKind, "terminal");
  assert.match(String(command?.title), /pwd/);
  assert.doesNotMatch(String(command?.title), /bash/);

  const failed = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    emitAsUpdate: true,
    item: { id: "cmd_2", type: "commandExecution", command: "false", commandActions: [], status: "failed", aggregatedOutput: "", exitCode: 1 },
  });
  assert.equal(failed?.status, "failed");
  assert.match(failed?.detail ?? "", /Exit code 1/);

  const declined = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    emitAsUpdate: true,
    item: { id: "cmd_3", type: "commandExecution", command: "rm -rf /", commandActions: [], status: "declined" },
  });
  assert.equal(declined?.status, "cancelled");

  const file = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event2",
    emitAsUpdate: true,
    item: {
      id: "file_1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/tmp/example.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
    },
  });
  assert.equal(file?.kind, "tool_call_update");
  assert.equal(file?.toolKind, "edit");
  assert.equal(file?.status, "completed");
  assert.deepEqual(file?.locations, [{ path: "/tmp/example.txt" }]);
  assert.match(file?.title ?? "", /example\.txt/);
  assert.equal(file?.editPreview?.addedLines, 1);
  assert.equal(file?.editPreview?.removedLines, 1);

  const added = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event3",
    item: { id: "file_2", type: "fileChange", status: "inProgress", changes: [{ path: "/tmp/new.txt", kind: { type: "add" }, diff: "hello\nworld\n" }] },
  });
  assert.equal(added?.title, "Create new.txt");
  assert.equal(added?.editPreview?.addedLines, 2);

  const deleted = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event4",
    item: { id: "file_3", type: "fileChange", status: "inProgress", changes: [{ path: "/tmp/old.txt", kind: "delete", diff: "bye\n" }] },
  });
  assert.match(deleted?.title ?? "", /Delete/);
  assert.equal(deleted?.editPreview?.removedLines, 1);

  const moved = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event5",
    item: { id: "file_4", type: "fileChange", status: "inProgress", changes: [{ path: "/tmp/a.txt", kind: { type: "update", move_path: "/tmp/b.txt" }, diff: "" }] },
  });
  assert.equal(moved?.title, "Move a.txt → b.txt");
});

test("codex app server classifies dynamic, MCP, web search and misc items", () => {
  const grep = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "dyn_1", type: "dynamicToolCall", tool: "grep", arguments: { pattern: "TODO", path: "src" }, status: "completed" },
  });
  assert.equal(grep?.toolKind, "grep");
  assert.match(String(grep?.title), /Grep/);
  assert.deepEqual(grep?.locations, [{ path: "src" }]);

  const mcp = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: {
      id: "mcp_1",
      type: "mcpToolCall",
      server: "context7",
      tool: "query_docs",
      status: "completed",
      result: { content: [{ type: "text", text: "Hono docs" }] },
    },
  });
  assert.equal(mcp?.toolKind, "mcp");
  assert.equal((mcp?.raw as { type?: string } | undefined)?.type, "mcp_tool_call");
  assert.equal(mcp?.detail, "Hono docs");

  const mcpError = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "mcp_2", type: "mcpToolCall", server: "context7", tool: "query_docs", status: "failed", error: { message: "boom" } },
  });
  assert.equal(mcpError?.detail, "boom");
  assert.equal(mcpError?.status, "failed");

  const search = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "ws_1", type: "webSearch", query: "hono middleware", action: { type: "search", query: "hono middleware" } },
  });
  assert.equal(search?.toolKind, "search_web");
  assert.match(search?.title ?? "", /hono middleware/);
  const open = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "ws_2", type: "webSearch", query: "", action: { type: "openPage", url: "https://hono.dev" } },
  });
  assert.equal(open?.title, "Open https://hono.dev");

  const sleep = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "sleep_1", type: "sleep", durationMs: 1500 },
  });
  assert.equal(sleep?.title, "Wait 1.5s");
  assert.equal(sleep?.toolKind, "wait");

  const image = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: { id: "img_1", type: "imageGeneration", status: "completed", result: "ok", savedPath: "/tmp/out.png", revisedPrompt: "a cat" },
  });
  assert.equal(image?.title, "Generate out.png");
  assert.deepEqual(image?.locations, [{ path: "/tmp/out.png" }]);

  assert.equal(
    codexAppServerToolEventFromItem({ conversationId: "conv", eventId: "e", item: { id: "u", type: "userMessage" } }),
    null
  );
});

test("codex app server normalizes approval requests with structured decisions", () => {
  const permission = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "42",
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "cmd_1",
      command: "/bin/bash -lc 'npm test'",
      commandActions: [{ type: "unknown", command: "npm test" }],
      cwd: "/tmp/project",
      proposedExecpolicyAmendment: ["npm", "test"],
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }, "cancel"],
    },
  });
  assert.equal(permission?.kind, "permission_request");
  assert.equal(permission?.toolCallId, "cmd_1");
  assert.match(permission?.detail ?? "", /npm test/);
  assert.deepEqual(
    permission?.options.map((option) => [option.optionId, option.kind]),
    [
      ["accept", "allow_once"],
      ['{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["npm","test"]}}', "allow_always"],
      ["decline", "reject_once"],
      ["cancel", "reject_once"],
    ]
  );
  assert.equal(permission?.options[1]?.name, "Always allow `npm test`");

  const network = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "43",
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "cmd_2",
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
      availableDecisions: ["accept", { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "registry.npmjs.org", action: "allow" } } }, "decline", "cancel"],
    },
  });
  assert.equal(network?.title, "Approve network access");
  assert.match(network?.detail ?? "", /registry\.npmjs\.org/);
  assert.equal(network?.options[1]?.name, "Always allow registry.npmjs.org");

  // Fallback decision set when the server omits availableDecisions.
  const fallback = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "44",
    method: "item/fileChange/requestApproval",
    params: { itemId: "patch_1", reason: "Needs write access", grantRoot: "/tmp/project" },
  });
  assert.deepEqual(
    fallback?.options.map((option) => option.optionId),
    ["accept", "acceptForSession", "decline", "cancel"]
  );
  assert.match(fallback?.detail ?? "", /Grant writes under \/tmp\/project/);

  const permissions = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "45",
    method: "item/permissions/requestApproval",
    params: {
      itemId: "call_1",
      cwd: "/repo",
      reason: "Cache dir",
      permissions: { fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/var/cache" } }] }, network: { enabled: true } },
    },
  });
  assert.match(permissions?.detail ?? "", /Write \/var\/cache/);
  assert.match(permissions?.detail ?? "", /Network access/);
});

test("codex app server approval responses use the v2 envelopes", () => {
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "item/commandExecution/requestApproval", params: {}, optionId: "accept" }),
    { decision: "accept" }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({
      method: "item/commandExecution/requestApproval",
      params: {},
      optionId: '{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["pwd"]}}',
    }),
    { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } } }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "item/fileChange/requestApproval", params: {}, optionId: "x", cancelled: true }),
    { decision: "cancel" }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "item/fileChange/requestApproval", params: {}, optionId: undefined }),
    { decision: "decline" }
  );
  const requested = { fileSystem: { write: ["/tmp/shared"] } };
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "item/permissions/requestApproval", params: { permissions: requested }, optionId: "grantTurn" }),
    { permissions: requested, scope: "turn" }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "item/permissions/requestApproval", params: { permissions: requested }, optionId: "deny" }),
    { permissions: {} }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "mcpServer/elicitation/request", params: {}, optionId: "acceptAlways" }),
    { action: "accept", content: null, _meta: { persist: "always" } }
  );
  assert.deepEqual(
    codexAppServerApprovalResponse({ method: "mcpServer/elicitation/request", params: {}, optionId: "decline" }),
    { action: "decline", content: null }
  );
  assert.equal(codexAppServerDecisionForOption("accept"), "accept");
  assert.equal(codexAppServerDecisionForOption(undefined, true), "cancel");
});

test("codex app server normalizes MCP elicitations", () => {
  const approval = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "50",
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "linear",
      mode: "form",
      message: "Allow create_issue?",
      requestedSchema: { type: "object", properties: {} },
      meta: { codex_approval_kind: "mcp_tool_call", persist: "always", tool_name: "create_issue" },
    },
  });
  assert.equal(approval?.title, "Approve MCP tool create_issue (linear)");
  assert.deepEqual(
    approval?.options.map((option) => option.optionId),
    ["accept", "acceptAlways", "decline", "cancel"]
  );

  const url = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "51",
    method: "mcpServer/elicitation/request",
    params: { serverName: "github", mode: "url", message: "Sign in", url: "https://example.com/oauth" },
  });
  assert.match(url?.title ?? "", /open a link/);
  assert.match(url?.detail ?? "", /https:\/\/example\.com\/oauth/);

  const formParams = {
    serverName: "tickets",
    mode: "form",
    message: "Details?",
    requestedSchema: {
      type: "object",
      properties: {
        priority: { type: "string", enum: ["low", "high"], enumNames: ["Low", "High"] },
        urgent: { type: "boolean", title: "Urgent" },
        count: { type: "integer", title: "Count" },
      },
      required: ["priority"],
    },
  };
  assert.equal(codexAppServerPermissionRequestFromServerRequest({ conversationId: "c", eventId: "e", requestId: "52", method: "mcpServer/elicitation/request", params: formParams }), null);
  const form = codexAppServerElicitationQuestion(formParams);
  assert.equal(form?.prompt, "tickets: Details?");
  assert.deepEqual(form?.steps.map((step) => step.id), ["priority", "urgent", "count"]);
  assert.deepEqual(form?.steps[0]?.options.map((option) => option.label), ["Low", "High"]);
  const response = codexAppServerElicitationFormResponse({
    fields: form!.fields,
    steps: form!.steps,
    answer: "priority: High\nUrgent: No\nCount: 3",
  });
  assert.deepEqual(response, { action: "accept", content: { priority: "high", urgent: false, count: 3 } });
  assert.deepEqual(
    codexAppServerElicitationFormResponse({ fields: form!.fields, steps: form!.steps, answer: "" }),
    { action: "cancel", content: null }
  );
});

test("codex app server maps request_user_input to question steps and back", () => {
  const request = codexAppServerUserInputRequest({
    itemId: "call_1",
    isBlocking: true,
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which packages should change?",
        options: [
          { label: "core", description: "Shared protocol types" },
          { label: "server", description: "Bun backend" },
        ],
        isOther: true,
      },
      { id: "notes", header: "Notes", question: "Anything else?", options: null },
    ],
  });
  assert.ok(request);
  assert.equal(request.isBlocking, true);
  assert.equal(request.prompt, "Codex has a few questions");
  assert.equal(request.steps[0]?.prompt, "Scope: Which packages should change?");
  assert.deepEqual(request.steps[0]?.options, [
    { id: "core", label: "core — Shared protocol types" },
    { id: "server", label: "server — Bun backend" },
  ]);
  assert.deepEqual(request.steps[1]?.options, []);

  const response = codexAppServerUserInputResponse({
    request,
    answer: "Scope: Which packages should change?: core — Shared protocol types, server — Bun backend\nNotes: Anything else?: Keep the tests green",
  });
  assert.deepEqual(response, {
    answers: { scope: { answers: ["core", "server"] }, notes: { answers: ["Keep the tests green"] } },
  });

  const single = codexAppServerUserInputRequest({
    itemId: "call_2",
    isBlocking: false,
    questions: [{ id: "confirm", header: "Confirm", question: "Proceed?", options: [{ label: "Yes", description: "Go" }, { label: "No", description: "Stop" }] }],
  });
  assert.equal(single?.prompt, "Confirm: Proceed?");
  assert.deepEqual(codexAppServerUserInputResponse({ request: single!, answer: "Yes — Go" }), {
    answers: { confirm: { answers: ["Yes"] } },
  });
  assert.deepEqual(codexAppServerUserInputResponse({ request: single!, answer: "Confirm: Proceed?: Only the server" }), {
    answers: { confirm: { answers: ["Only the server"] } },
  });
  assert.equal(codexAppServerUserInputRequest({ itemId: "x", isBlocking: true, questions: [] }), null);
});

test("codex app server summarizes turn errors and unwraps provider JSON", () => {
  assert.equal(
    codexAppServerUnwrapErrorMessage('{"error":{"message":"Model \'x\' not found","type":"invalid_request_error"}}'),
    "Model 'x' not found"
  );
  assert.equal(codexAppServerUnwrapErrorMessage("plain"), "plain");
  assert.equal(
    codexAppServerErrorSummary({ message: "upstream blew up", codexErrorInfo: "other" }),
    "upstream blew up"
  );
  assert.equal(
    codexAppServerErrorSummary({ message: "429 Too Many Requests", codexErrorInfo: "rateLimitExceeded" }),
    "Rate limited by the model provider: 429 Too Many Requests"
  );
  assert.equal(
    codexAppServerErrorSummary({ message: "connect failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }),
    "Could not connect to the model provider · HTTP 502: connect failed"
  );
  assert.equal(
    codexAppServerErrorSummary({
      message: "blocked",
      codexErrorInfo: "misalignmentPolicyViolation",
      misalignment: { detailedExplanation: "The request looked like credential exfiltration." },
    }),
    "Blocked by misalignment policy: blocked\nThe request looked like credential exfiltration."
  );
  const status = codexAppServerStatusFromTurn({
    turn: { status: "failed", error: { message: "upstream blew up", codexErrorInfo: { type: "Other" } } },
  });
  assert.deepEqual(status, { status: "failed", detail: "upstream blew up" });
  assert.deepEqual(codexAppServerStatusFromTurn({ turn: { status: "interrupted" } }), { status: "interrupted", detail: undefined });
  assert.deepEqual(codexAppServerStatusFromTurn({ turn: { status: "completed" } }), { status: "idle", detail: undefined });
  assert.equal(codexAppServerStatusFromTurn({ turn: { status: "inProgress" } }), null);
});

test("codex app server converts token usage into a context snapshot", () => {
  const params = {
    threadId: "t",
    turnId: "u",
    tokenUsage: {
      total: { inputTokens: 5000, cachedInputTokens: 1000, outputTokens: 700, reasoningOutputTokens: 100, totalTokens: 5700 },
      last: { inputTokens: 3000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 50, totalTokens: 3200 },
      modelContextWindow: 64000,
    },
  };
  const usage = codexAppServerTokenUsage(params);
  assert.equal(usage?.total.totalTokens, 5700);
  assert.equal(usage?.last?.totalTokens, 3200);
  assert.equal(usage?.modelContextWindow, 64000);
  const snapshot = contextUsageFromTokenUsage(params);
  assert.equal(snapshot?.supported, true);
  assert.equal(snapshot?.usedTokens, 3150);
  assert.equal(snapshot?.limitTokens, 64000);
  assert.equal(snapshot?.percentFull, 4.9);
  assert.deepEqual(
    snapshot?.categories.map((category) => [category.id, category.tokens]),
    [["conversation", 2350], ["summarized_conversation", 800]]
  );
  const unknownWindow = contextUsageFromTokenUsage({ tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 } } });
  assert.equal(unknownWindow?.approximate, true);
  assert.equal(unknownWindow?.limitTokens, 0);
  assert.equal(codexAppServerTokenUsage({ tokenUsage: "[redacted]" }), null);
});

test("codex app server transport dispatches server requests, responses and notifications", () => {
  const seen: Array<{ kind: string; payload: unknown }> = [];
  const transport = Object.create(CodexAppServerTransport.prototype) as {
    handleLine: (line: string) => void;
    pending: Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: null }>;
    onStderrLine?: (line: string) => void;
    onServerRequest?: (message: unknown) => void;
    onNotification?: (message: unknown) => void;
  };
  transport.pending = new Map();
  transport.onStderrLine = (line: string) => seen.push({ kind: "stderr", payload: line });
  transport.onServerRequest = (message: unknown) => seen.push({ kind: "request", payload: message });
  transport.onNotification = (message: unknown) => seen.push({ kind: "notification", payload: message });
  transport.pending.set(0, {
    method: "initialize",
    resolve: (value) => seen.push({ kind: "response", payload: value }),
    reject: (error) => seen.push({ kind: "reject", payload: error.message }),
    timer: null,
  });

  transport.handleLine("SUCCESS: The process with PID 36972 (child process of PID 28724) has been terminated.");
  // Server request ids are independent from client ids: id 0 with a method is a request.
  transport.handleLine(JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { itemId: "c" } }));
  transport.handleLine(JSON.stringify({ id: 0, result: { userAgent: "x" } }));
  transport.handleLine(JSON.stringify({ method: "turn/started", params: { turn: { id: "t" } } }));
  transport.handleLine(JSON.stringify({ id: 99, result: {} }));
  transport.handleLine("not json");

  assert.deepEqual(
    seen.map((entry) => entry.kind),
    ["request", "response", "notification", "stderr"]
  );
  assert.deepEqual((seen[0]?.payload as { method: string }).method, "item/commandExecution/requestApproval");
  assert.deepEqual(seen[1]?.payload, { userAgent: "x" });
  assert.match(String(seen[3]?.payload), /Non-JSON stdout/);
});

test("codex app server recognises missing-thread resume errors", async () => {
  const { CodexAppServerRpcError } = await import("../src/lib/agents/codex-app-server-transport.js");
  assert.equal(
    isCodexThreadNotFoundError(
      new CodexAppServerRpcError({ method: "thread/resume", code: -32600, message: "no rollout found for thread id abc" })
    ),
    true
  );
  assert.equal(isCodexThreadNotFoundError(new Error("timed out")), false);
});
