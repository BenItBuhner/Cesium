#!/usr/bin/env node
// Test double for `codex app-server` (protocol v2, Codex CLI 0.153.x).
//
// Speaks line-delimited JSON-RPC over stdio and replays the real notification
// shapes captured from the CLI. Scenarios are selected by keywords in the user
// prompt so a single fake covers approvals, user-input questions, permission
// grants, MCP elicitations, plan mode, subagents, errors, and interrupts.
//
// Env:
//   FAKE_CODEX_LOG            - JSONL file receiving every inbound client message
//   FAKE_CODEX_RESUME_FAILS   - "1" => thread/resume errors like a missing rollout
//   FAKE_CODEX_MODEL          - configured default model (default kimi-k3)
//   FAKE_CODEX_PROVIDER       - configured model_provider (default techlit)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  process.stderr.write(`fake codex: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const CONFIG_MODEL = process.env.FAKE_CODEX_MODEL || "kimi-k3";
const CONFIG_PROVIDER = process.env.FAKE_CODEX_PROVIDER || "techlit";
const LOG_PATH = process.env.FAKE_CODEX_LOG;

let initialized = false;
let nextServerRequestId = 0;
let itemCounter = 0;
const pendingServerRequests = new Map();
const threads = new Map();
let activeTurn = null;

function log(entry) {
  if (LOG_PATH) {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, code, message) {
  send({ id, error: { code, message } });
}

function notify(method, params) {
  send({ method, params });
}

function newId(prefix) {
  itemCounter += 1;
  return `${prefix}_${String(itemCounter).padStart(4, "0")}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serverRequest(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, { method, resolve });
    send({ id, method, params });
  });
}

function threadRecord(id, cwd) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: CONFIG_PROVIDER,
    model: CONFIG_MODEL,
    reasoningEffort: null,
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    recencyAt: nowSeconds(),
    status: { type: "idle" },
    path: `/tmp/fake-codex/${id}.jsonl`,
    cwd,
    cliVersion: "0.153.4",
    source: "appServer",
    gitInfo: null,
    name: null,
    turns: [],
    extra: null,
    canAcceptDirectInput: true,
    agentNickname: null,
    agentRole: null,
  };
}

function threadStartResult(thread, model, approvalPolicy, sandbox) {
  return {
    thread,
    model: model || CONFIG_MODEL,
    modelProvider: CONFIG_PROVIDER,
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: approvalPolicy || "on-request",
    approvalsReviewer: "user",
    sandbox: sandboxPolicyFromMode(sandbox, thread.cwd),
    activePermissionProfile: { id: sandbox === "read-only" ? ":read-only" : ":workspace", extends: null },
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

function sandboxPolicyFromMode(mode, cwd) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function validateApprovalPolicy(policy) {
  if (policy == null) {
    return null;
  }
  if (typeof policy === "string") {
    if (!["untrusted", "on-request", "never"].includes(policy)) {
      return `Invalid request: unknown variant \`${policy}\`, expected one of \`untrusted\`, \`on-request\`, \`granular\`, \`never\``;
    }
    return null;
  }
  if (typeof policy === "object" && policy.granular) {
    return null;
  }
  return "Invalid request: invalid approval policy";
}

function validateSandboxPolicy(policy) {
  if (policy == null) {
    return null;
  }
  if (typeof policy !== "object" || !["dangerFullAccess", "readOnly", "externalSandbox", "workspaceWrite"].includes(policy.type)) {
    return "Invalid request: unknown sandbox policy type";
  }
  return null;
}

function agentMessageItem(id, text, extra = {}) {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null, ...extra };
}

async function streamAgentMessage(ctx, text, { deltas = true, extra = {} } = {}) {
  const id = newId("msg");
  notify("item/started", { item: agentMessageItem(id, "", extra), threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  if (deltas) {
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    notify("item/agentMessage/delta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: text.slice(0, midpoint) });
    await sleep(5);
    notify("item/agentMessage/delta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: text.slice(midpoint) });
  }
  notify("item/completed", { item: agentMessageItem(id, text, extra), threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
  return id;
}

async function emitReasoning(ctx, text, { deltas }) {
  const id = newId("rsn");
  notify("item/started", { item: { type: "reasoning", id, summary: [], content: [] }, threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  if (deltas) {
    notify("item/reasoning/textDelta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: text, contentIndex: 0 });
  }
  notify("item/completed", { item: { type: "reasoning", id, summary: [], content: [text] }, threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
}

function emitTokenUsage(ctx, inputTokens, outputTokens) {
  notify("thread/tokenUsage/updated", {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    tokenUsage: {
      total: { inputTokens: inputTokens * 2, cachedInputTokens: 512, outputTokens: outputTokens * 2, reasoningOutputTokens: 40, totalTokens: (inputTokens + outputTokens) * 2 },
      last: { inputTokens, cachedInputTokens: 512, outputTokens, reasoningOutputTokens: 20, totalTokens: inputTokens + outputTokens },
      modelContextWindow: 128000,
    },
  });
  notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", limitName: null, primary: null, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null } });
}

function completeTurn(ctx, status, { items = [], error = null } = {}) {
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: status === "failed" ? "systemError" : "idle" } });
  notify("turn/completed", {
    threadId: ctx.threadId,
    turn: { id: ctx.turnId, items, itemsView: "summary", status, error, startedAt: ctx.startedAt, completedAt: nowSeconds(), durationMs: Date.now() - ctx.startedAt * 1000 },
  });
  activeTurn = null;
}

function commandItem(id, command, status, extra = {}) {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: `/bin/bash -lc ${command}`,
    cwd: "/tmp/fake-workspace",
    processId: null,
    source: "agent",
    status,
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...extra,
  };
}

async function runApprovalScenario(ctx) {
  const itemId = newId("call");
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  notify("item/started", { item: commandItem(itemId, "pwd", "inProgress"), threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  const response = await serverRequest("item/commandExecution/requestApproval", {
    kind: "command",
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId,
    startedAtMs: Date.now(),
    environmentId: "local",
    command: "/bin/bash -lc pwd",
    cwd: "/tmp/fake-workspace",
    commandActions: [{ type: "unknown", command: "pwd" }],
    proposedExecpolicyAmendment: ["pwd"],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } }, "cancel"],
  });
  if (activeTurn !== ctx) {
    // The turn was interrupted while the approval was pending; the real server
    // already emitted serverRequest/resolved and turn/completed.
    return;
  }
  notify("serverRequest/resolved", { threadId: ctx.threadId, requestId: response.id });
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: "active", activeFlags: [] } });
  // The real server deserializes `CommandExecutionRequestApprovalResponse { decision }`.
  const decision = response.result && typeof response.result === "object" ? response.result.decision : undefined;
  if (decision === undefined || response.error) {
    process.stderr.write(
      `${new Date().toISOString()} ERROR codex_app_server::bespoke_event_handling: failed to deserialize CommandExecutionRequestApprovalResponse: invalid type: ${JSON.stringify(response.result)}, expected struct CommandExecutionRequestApprovalResponse\n`
    );
    notify("item/completed", { item: commandItem(itemId, "pwd", "failed"), threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
    await streamAgentMessage(ctx, "The `pwd` command was rejected because its approval request failed.");
    completeTurn(ctx, "completed");
    return;
  }
  const accepted = decision === "accept" || decision === "acceptForSession" || (typeof decision === "object" && decision.acceptWithExecpolicyAmendment);
  if (decision === "cancel") {
    notify("item/completed", { item: commandItem(itemId, "pwd", "declined"), threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
    completeTurn(ctx, "interrupted");
    return;
  }
  if (!accepted) {
    notify("item/completed", { item: commandItem(itemId, "pwd", "declined"), threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
    await streamAgentMessage(ctx, "Understood, I will not run that command.");
    completeTurn(ctx, "completed");
    return;
  }
  notify("item/commandExecution/outputDelta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId, delta: "/tmp/fake-workspace\n" });
  notify("item/completed", {
    item: commandItem(itemId, "pwd", "completed", { aggregatedOutput: "/tmp/fake-workspace\n", exitCode: 0, durationMs: 3, processId: "4242" }),
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    completedAtMs: Date.now(),
  });
  emitTokenUsage(ctx, 900, 60);
  await streamAgentMessage(ctx, `Approved with ${JSON.stringify(decision)}; the working directory is /tmp/fake-workspace.`);
  completeTurn(ctx, "completed");
}

async function runFileChangeScenario(ctx) {
  const itemId = newId("call");
  const changes = [
    { path: "/tmp/fake-workspace/notes.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old line\n+new line\n" },
    { path: "/tmp/fake-workspace/created.txt", kind: { type: "add" }, diff: "hello\n" },
  ];
  notify("item/started", { item: { type: "fileChange", id: itemId, changes, status: "inProgress" }, threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  const response = await serverRequest("item/fileChange/requestApproval", {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId,
    startedAtMs: Date.now(),
    reason: null,
    grantRoot: null,
  });
  notify("serverRequest/resolved", { threadId: ctx.threadId, requestId: response.id });
  const decision = response.result?.decision;
  const status = decision === "accept" || decision === "acceptForSession" ? "completed" : "declined";
  notify("item/completed", { item: { type: "fileChange", id: itemId, changes, status }, threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
  if (status === "completed") {
    notify("turn/diff/updated", { threadId: ctx.threadId, turnId: ctx.turnId, diff: "diff --git a/notes.txt b/notes.txt\n" });
  }
  await streamAgentMessage(ctx, status === "completed" ? "Applied the file changes." : "File changes were declined.");
  completeTurn(ctx, "completed");
}

async function runQuestionScenario(ctx, { blocking }) {
  const itemId = newId("call");
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: "active", activeFlags: ["waitingOnUserInput"] } });
  const response = await serverRequest("item/tool/requestUserInput", {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId,
    isBlocking: blocking,
    questions: [
      {
        id: "framework",
        header: "Framework",
        question: "Which framework should the new service use?",
        options: [
          { label: "Hono", description: "Small and fast" },
          { label: "Express", description: "Battle tested" },
        ],
        isOther: true,
        isSecret: false,
      },
      {
        id: "db",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "SQLite", description: "Embedded" },
        ],
        isOther: false,
        isSecret: false,
      },
    ],
  });
  notify("serverRequest/resolved", { threadId: ctx.threadId, requestId: response.id });
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: "active", activeFlags: [] } });
  const answers = response.result?.answers;
  const framework = answers?.framework?.answers?.join(", ") ?? "(none)";
  const db = answers?.db?.answers?.join(", ") ?? "(none)";
  await streamAgentMessage(ctx, `Using ${framework} with ${db}.`);
  completeTurn(ctx, "completed");
}

async function runPermissionsScenario(ctx) {
  const itemId = newId("call");
  const response = await serverRequest("item/permissions/requestApproval", {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    itemId,
    startedAtMs: Date.now(),
    environmentId: "local",
    cwd: "/tmp/fake-workspace",
    reason: "Need to write the shared cache directory",
    permissions: { fileSystem: { write: ["/tmp/fake-shared"] }, network: { enabled: true } },
  });
  notify("serverRequest/resolved", { threadId: ctx.threadId, requestId: response.id });
  const granted = response.result?.permissions ?? {};
  const scope = response.result?.scope ?? "turn";
  await streamAgentMessage(ctx, `Granted ${JSON.stringify(granted)} for ${scope}.`);
  completeTurn(ctx, "completed");
}

async function runElicitationScenario(ctx, { form }) {
  const params = form
    ? {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        serverName: "tickets",
        mode: "form",
        message: "Create the ticket?",
        requestedSchema: {
          type: "object",
          properties: {
            priority: { type: "string", title: "Priority", enum: ["low", "high"] },
            notify: { type: "boolean", title: "Notify owner" },
            title: { type: "string", title: "Title" },
          },
          required: ["priority"],
        },
      }
    : {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        serverName: "context7",
        mode: "form",
        message: "Allow the tool call query_docs?",
        requestedSchema: { type: "object", properties: {} },
        meta: { codex_approval_kind: "mcp_tool_call", persist: ["session"], tool_name: "query_docs", tool_params_display: [{ name: "query", value: "hono" }] },
      };
  const response = await serverRequest("mcpServer/elicitation/request", params);
  notify("serverRequest/resolved", { threadId: ctx.threadId, requestId: response.id });
  const result = response.result ?? {};
  await streamAgentMessage(ctx, `Elicitation ${result.action ?? "invalid"} ${JSON.stringify(result.content ?? null)} ${JSON.stringify(result._meta ?? null)}`);
  completeTurn(ctx, "completed");
}

async function runPlanScenario(ctx) {
  notify("turn/plan/updated", {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    explanation: "Investigate then patch",
    plan: [
      { step: "Inspect the router", status: "completed" },
      { step: "Patch the handler", status: "inProgress" },
      { step: "Run tests", status: "pending" },
    ],
  });
  const planId = newId("plan");
  const text = "# Proposed plan\n\n1. Inspect the router\n2. Patch the handler\n3. Run tests\n";
  notify("item/started", { item: { type: "plan", id: planId, text: "" }, threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  notify("item/plan/delta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: planId, delta: text.slice(0, 20) });
  notify("item/plan/delta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: planId, delta: text.slice(20) });
  notify("item/completed", { item: { type: "plan", id: planId, text }, threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
  await streamAgentMessage(ctx, "Here is the plan.");
  completeTurn(ctx, "completed");
}

async function runCollabScenario(ctx) {
  const id = newId("call");
  const base = {
    type: "collabAgentToolCall",
    id,
    tool: "spawnAgent",
    senderThreadId: ctx.threadId,
    receiverThreadIds: ["child_thread_1"],
    prompt: "Inspect the repo layout",
    model: CONFIG_MODEL,
    reasoningEffort: null,
  };
  notify("item/started", { item: { ...base, status: "inProgress", agentsStates: { child_thread_1: { status: "pendingInit", message: null } } }, threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  // The child thread streams over the same connection, tagged with its own threadId.
  const childThreadId = "child_thread_1";
  const childTurnId = "child_turn_1";
  notify("thread/started", { thread: { ...threadRecord(childThreadId, "/tmp/fake-workspace"), parentThreadId: ctx.threadId, agentNickname: "explorer", agentRole: "worker" } });
  notify("thread/status/changed", { threadId: childThreadId, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId: childThreadId, turn: { id: childTurnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: nowSeconds(), completedAt: null, durationMs: null } });
  notify("item/started", { item: { type: "reasoning", id: "child_rsn_1", summary: [], content: [] }, threadId: childThreadId, turnId: childTurnId, startedAtMs: Date.now() });
  notify("item/completed", { item: { type: "reasoning", id: "child_rsn_1", summary: [], content: ["I should list the packages."] }, threadId: childThreadId, turnId: childTurnId, completedAtMs: Date.now() });
  notify("item/started", { item: commandItem("child_cmd_1", "ls packages", "inProgress"), threadId: childThreadId, turnId: childTurnId, startedAtMs: Date.now() });
  notify("item/completed", { item: commandItem("child_cmd_1", "ls packages", "completed", { aggregatedOutput: "core\nclient\nsdk\n", exitCode: 0, durationMs: 2 }), threadId: childThreadId, turnId: childTurnId, completedAtMs: Date.now() });
  notify("item/started", { item: agentMessageItem("child_msg_1", ""), threadId: childThreadId, turnId: childTurnId, startedAtMs: Date.now() });
  notify("item/agentMessage/delta", { threadId: childThreadId, turnId: childTurnId, itemId: "child_msg_1", delta: "Found 3 " });
  notify("item/agentMessage/delta", { threadId: childThreadId, turnId: childTurnId, itemId: "child_msg_1", delta: "packages." });
  notify("item/completed", { item: agentMessageItem("child_msg_1", "Found 3 packages."), threadId: childThreadId, turnId: childTurnId, completedAtMs: Date.now() });
  notify("thread/status/changed", { threadId: childThreadId, status: { type: "idle" } });
  notify("turn/completed", { threadId: childThreadId, turn: { id: childTurnId, items: [], itemsView: "summary", status: "completed", error: null, startedAt: nowSeconds(), completedAt: nowSeconds(), durationMs: 50 } });
  notify("item/completed", { item: { ...base, status: "completed", agentsStates: { child_thread_1: { status: "completed", message: "Found 3 packages." }, child_thread_x: { status: "errored", message: "boom" } } }, threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
  const activityId = newId("act");
  notify("item/started", { item: { type: "subAgentActivity", id: activityId, kind: "started", agentThreadId: "child_thread_2", agentPath: "root/explorer" }, threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  notify("item/completed", { item: { type: "subAgentActivity", id: activityId, kind: "completed", agentThreadId: "child_thread_2", agentPath: "root/explorer" }, threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
  await streamAgentMessage(ctx, "Subagents finished.");
  completeTurn(ctx, "completed");
}

async function runErrorScenario(ctx, { retry }) {
  if (retry) {
    notify("error", {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      willRetry: true,
      error: { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null, misalignment: null },
    });
    await sleep(10);
    await streamAgentMessage(ctx, "Recovered after retry.");
    completeTurn(ctx, "completed");
    return;
  }
  const error = {
    message: "{\"error\":{\"message\":\"Model 'gpt-6-astra' not found in routing configuration\",\"type\":\"invalid_request_error\",\"code\":null}}",
    codexErrorInfo: "other",
    additionalDetails: null,
    misalignment: null,
  };
  notify("error", { threadId: ctx.threadId, turnId: ctx.turnId, willRetry: false, error });
  completeTurn(ctx, "failed", { error });
}

async function runSlowScenario(ctx) {
  const id = newId("msg");
  notify("item/started", { item: agentMessageItem(id, ""), threadId: ctx.threadId, turnId: ctx.turnId, startedAtMs: Date.now() });
  notify("item/agentMessage/delta", { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: "Working on it" });
  // Completes only through turn/interrupt.
  ctx.interruptible = { itemId: id };
}

async function runCurrentTimeScenario(ctx) {
  const response = await serverRequest("currentTime/read", { threadId: ctx.threadId });
  const at = response.result?.currentTimeAt;
  await streamAgentMessage(ctx, typeof at === "number" ? `The time is ${at}.` : "No time provided.");
  completeTurn(ctx, "completed");
}

async function runNoCompleteScenario(ctx) {
  await streamAgentMessage(ctx, "Done but forgot to complete.");
  notify("thread/status/changed", { threadId: ctx.threadId, status: { type: "idle" } });
  // Deliberately never sends turn/completed.
}

async function runDefaultScenario(ctx, promptText) {
  await emitReasoning(ctx, "The user wants a short reply.", { deltas: false });
  emitTokenUsage(ctx, 1200, 80);
  const reply = promptText.includes("pong") ? "Testing connection, ready to pong." : `Echo: ${promptText}`;
  await streamAgentMessage(ctx, reply, { deltas: !promptText.includes("nodelta") });
  completeTurn(ctx, "completed", { items: [agentMessageItem("summary", reply)] });
}

async function runAsyncQuestionScenario(ctx) {
  await streamAgentMessage(ctx, "Before I continue: should I also update the docs?", {
    deltas: false,
    extra: { delivery: "async", questions: [{ title: "Update the docs too?", options: ["Yes", "No"] }] },
  });
  completeTurn(ctx, "completed");
}

async function runTurn(thread, turnId, params) {
  const promptText = (params.input ?? [])
    .filter((entry) => entry && entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  const ctx = { threadId: thread.id, turnId, startedAt: nowSeconds(), interruptible: null };
  activeTurn = ctx;
  notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
  notify("turn/started", { threadId: thread.id, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: ctx.startedAt, completedAt: null, durationMs: null } });
  const userItemId = newId("user");
  const userItem = { type: "userMessage", id: userItemId, clientId: params.clientUserMessageId ?? null, content: (params.input ?? []).map((entry) => (entry.type === "text" ? { ...entry, text_elements: [] } : entry)) };
  notify("item/started", { item: userItem, threadId: thread.id, turnId, startedAtMs: Date.now() });
  notify("item/completed", { item: userItem, threadId: thread.id, turnId, completedAtMs: Date.now() });
  if (params.collaborationMode?.mode === "plan" && !promptText.includes("scenario:")) {
    await runPlanScenario(ctx);
    return;
  }
  const scenario = /scenario:([a-z-]+)/.exec(promptText)?.[1] ?? "default";
  switch (scenario) {
    case "approval":
      return runApprovalScenario(ctx);
    case "filechange":
      return runFileChangeScenario(ctx);
    case "question":
      return runQuestionScenario(ctx, { blocking: true });
    case "question-nonblocking":
      return runQuestionScenario(ctx, { blocking: false });
    case "permissions":
      return runPermissionsScenario(ctx);
    case "elicitation":
      return runElicitationScenario(ctx, { form: false });
    case "elicitation-form":
      return runElicitationScenario(ctx, { form: true });
    case "plan":
      return runPlanScenario(ctx);
    case "collab":
      return runCollabScenario(ctx);
    case "error":
      return runErrorScenario(ctx, { retry: false });
    case "retry":
      return runErrorScenario(ctx, { retry: true });
    case "slow":
      return runSlowScenario(ctx);
    case "currenttime":
      return runCurrentTimeScenario(ctx);
    case "nocomplete":
      return runNoCompleteScenario(ctx);
    case "asyncquestion":
      return runAsyncQuestionScenario(ctx);
    default:
      return runDefaultScenario(ctx, promptText);
  }
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    if (initialized) {
      respondError(id, -32600, "Already initialized");
      return;
    }
    initialized = true;
    respond(id, { userAgent: `${params.clientInfo?.name ?? "client"}/0.153.4 (fake)`, codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "linux" });
    notify("configWarning", { summary: "Codex could not find bubblewrap on PATH. Codex will use the bundled bubblewrap in the meantime.", details: null });
    process.stderr.write(`${new Date().toISOString()} ERROR codex_app_server: Codex could not find bubblewrap on PATH. Codex will use the bundled bubblewrap in the meantime.\n`);
    return;
  }
  if (!initialized) {
    respondError(id, -32002, "Not initialized");
    return;
  }
  switch (method) {
    case "account/read":
      respond(id, { account: null, requiresOpenaiAuth: false });
      return;
    case "config/read":
      respond(id, { config: { model: CONFIG_MODEL, model_provider: CONFIG_PROVIDER, model_reasoning_effort: null, mcp_servers: {} } });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            id: "gpt-6-astra",
            model: "gpt-6-astra",
            displayName: "GPT-6-Astra",
            description: "Our most capable model for complex, demanding work.",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "ultra", description: "" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: false,
            multiAgentVersion: "v2",
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
          },
        ],
        nextCursor: null,
      });
      return;
    case "thread/start": {
      const approvalError = validateApprovalPolicy(params.approvalPolicy);
      if (approvalError) {
        respondError(id, -32600, approvalError);
        return;
      }
      const threadId = `01a0${String(threads.size + 1).padStart(4, "0")}-fake-thread`;
      const thread = threadRecord(threadId, params.cwd ?? process.cwd());
      thread.config = params.config ?? null;
      threads.set(threadId, thread);
      respond(id, threadStartResult(thread, params.model, params.approvalPolicy, params.sandbox));
      notify("thread/started", { thread });
      if (params.model && params.model !== CONFIG_MODEL) {
        notify("warning", { threadId, message: `Model metadata for \`${params.model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.` });
      }
      return;
    }
    case "thread/resume": {
      if (process.env.FAKE_CODEX_RESUME_FAILS === "1") {
        respondError(id, -32600, `no rollout found for thread id ${params.threadId}`);
        return;
      }
      const thread = threads.get(params.threadId) ?? threadRecord(params.threadId, params.cwd ?? process.cwd());
      threads.set(thread.id, thread);
      respond(id, { ...threadStartResult(thread, params.model, params.approvalPolicy, params.sandbox), turnsBackwardsCursor: null, itemsBackwardsCursor: null, initialTurnsPage: null });
      return;
    }
    case "thread/unsubscribe":
      respond(id, { status: threads.has(params.threadId) ? "unsubscribed" : "notLoaded" });
      return;
    case "turn/start": {
      const thread = threads.get(params.threadId);
      if (!thread) {
        respondError(id, -32600, `thread not found: ${params.threadId}`);
        return;
      }
      const approvalError = validateApprovalPolicy(params.approvalPolicy) ?? validateSandboxPolicy(params.sandboxPolicy);
      if (approvalError) {
        respondError(id, -32600, approvalError);
        return;
      }
      if (activeTurn) {
        respondError(id, -32600, "a turn is already active");
        return;
      }
      const turnId = newId("turn");
      respond(id, { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } });
      setTimeout(() => {
        runTurn(thread, turnId, params).catch((error) => {
          process.stderr.write(`fake codex scenario failed: ${error?.stack ?? error}\n`);
        });
      }, 0);
      return;
    }
    case "turn/steer": {
      if (!activeTurn || activeTurn.turnId !== params.expectedTurnId) {
        respondError(id, -32600, "Invalid request: no matching active turn");
        return;
      }
      respond(id, { turnId: activeTurn.turnId });
      return;
    }
    case "turn/interrupt": {
      respond(id, {});
      const ctx = activeTurn;
      if (ctx && ctx.turnId === params.turnId) {
        setTimeout(() => {
          if (ctx.interruptible) {
            notify("item/completed", { item: agentMessageItem(ctx.interruptible.itemId, "Working on it"), threadId: ctx.threadId, turnId: ctx.turnId, completedAtMs: Date.now() });
          }
          // Interrupting clears outstanding server requests before the turn ends.
          for (const [requestId, pending] of pendingServerRequests) {
            pendingServerRequests.delete(requestId);
            notify("serverRequest/resolved", { threadId: ctx.threadId, requestId });
            pending.resolve({ id: requestId, result: undefined, error: { code: -32800, message: "interrupted" } });
          }
          completeTurn(ctx, "interrupted");
        }, 20);
      }
      return;
    }
    case "collaborationMode/list":
      respond(id, { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }, { name: "Default", mode: "default", model: null, reasoning_effort: null }] });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`fake codex: invalid json ${trimmed.slice(0, 80)}\n`);
    return;
  }
  log({ direction: "in", message });
  if (message.method && message.id !== undefined) {
    handleRequest(message);
    return;
  }
  if (message.method) {
    // Client notification (`initialized`).
    return;
  }
  if (message.id !== undefined && pendingServerRequests.has(message.id)) {
    const pending = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    pending.resolve({ id: message.id, result: message.result, error: message.error });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
