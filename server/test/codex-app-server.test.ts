import assert from "node:assert/strict";
import { test } from "node:test";

const [
  { AGENT_BACKENDS, listAgentBackends },
  { CodexAppServerTransport },
  { isStaleCodexAppServerCache },
  {
    codexAppServerAssistantTextFromItem,
    canonicalizeCodexAppServerItem,
    codexAppServerPermissionRequestFromServerRequest,
    codexAppServerPlanEntriesFromTurnPlan,
    codexAppServerStatusFromTurn,
    codexAppServerTextDelta,
    codexAppServerToolEventFromItem,
  },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/codex-app-server-transport.js"),
  import("../src/lib/agents/provider-cache-store.js"),
  import("../src/lib/agents/codex-app-server-normalize.js"),
]);

test("codex app server backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const appServerIndex = backends.findIndex((backend) => backend.id === "codex-app-server");
  assert.ok(appServerIndex >= 0);
  assert.equal(AGENT_BACKENDS["codex-app-server"].label, "Codex App Server");
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_BACKENDS["codex-app-server"].capabilities.supportsStructuredPlans, true);
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

test("codex app server normalizes assistant and reasoning deltas", () => {
  assert.deepEqual(
    codexAppServerTextDelta({ itemId: "item_1", delta: "pong" }),
    { itemId: "item_1", text: "pong" }
  );
  assert.equal(
    codexAppServerAssistantTextFromItem({
      id: "item_1",
      type: "agentMessage",
      text: "final pong",
    }),
    "final pong"
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
  const raw = canonicalizeCodexAppServerItem({
    id: "task_1",
    type: "collabToolCall",
    receiverThreadId: "child_1",
    newThreadId: "child_2",
    prompt: "Inspect the repo",
  });
  assert.equal(raw.type, "collab_tool_call");
  assert.deepEqual(raw.receiver_thread_ids, ["child_1"]);
  assert.equal(raw.receiver_thread_id, "child_1");
  assert.equal(raw.new_thread_id, "child_2");

  const event = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: {
      id: "task_1",
      type: "collabToolCall",
      receiverThreadId: "child_1",
      prompt: "Inspect the repo",
    },
  });
  assert.equal((event?.raw as { type?: string } | undefined)?.type, "collab_tool_call");
});

test("codex app server normalizes command and file items", () => {
  const command = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: {
      id: "cmd_1",
      type: "commandExecution",
      command: ["pwd"],
      status: "inProgress",
      aggregatedOutput: "/tmp\n",
    },
  });
  assert.equal(command?.kind, "tool_call");
  assert.equal(command?.toolKind, "terminal");
  assert.match(String(command?.title), /pwd/);

  const file = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event2",
    emitAsUpdate: true,
    item: {
      id: "file_1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/tmp/example.txt", kind: "update" }],
    },
  });
  assert.equal(file?.kind, "tool_call_update");
  assert.equal(file?.toolKind, "edit");
  assert.equal(file?.status, "completed");
  assert.deepEqual(file?.locations, [{ path: "/tmp/example.txt" }]);
});

test("codex app server classifies dynamic and MCP tool calls", () => {
  const grep = codexAppServerToolEventFromItem({
    conversationId: "conv",
    eventId: "event",
    item: {
      id: "dyn_1",
      type: "dynamicToolCall",
      tool: "grep",
      arguments: { pattern: "TODO", path: "src" },
      status: "completed",
    },
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
    },
  });
  assert.equal(mcp?.toolKind, "mcp");
  assert.equal((mcp?.raw as { type?: string } | undefined)?.type, "mcp_tool_call");
});


test("codex app server normalizes permission requests and turn failures", () => {
  const permission = codexAppServerPermissionRequestFromServerRequest({
    conversationId: "conv",
    eventId: "event",
    requestId: "42",
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "cmd_1",
      command: ["npm", "test"],
      cwd: "/tmp/project",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    },
  });
  assert.equal(permission?.kind, "permission_request");
  assert.equal(permission?.toolCallId, "cmd_1");
  assert.ok(permission?.options.some((option) => option.optionId === "acceptForSession"));

  const status = codexAppServerStatusFromTurn({
    turn: {
      status: "failed",
      error: { message: "upstream blew up", codexErrorInfo: { type: "Other" } },
    },
  });
  assert.deepEqual(status, { status: "failed", detail: "upstream blew up" });
});

test("codex app server ignores Windows taskkill stdout noise", () => {
  const warnings: string[] = [];
  const transport = Object.create(CodexAppServerTransport.prototype) as {
    handleLine: (line: string) => void;
    onStderrLine?: (line: string) => void;
  };
  transport.onStderrLine = (line: string) => warnings.push(line);
  transport.handleLine(
    "SUCCESS: The process with PID 36972 (child process of PID 28724) has been terminated."
  );
  assert.deepEqual(warnings, []);
});
