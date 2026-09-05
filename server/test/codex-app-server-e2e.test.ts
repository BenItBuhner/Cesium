import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-codex-e2e-"));
process.env.OPENCURSOR_DATA_DIR = path.join(TEST_ROOT, "data");
process.env.OPENCURSOR_CODEX_APP_SERVER_SETTLE_GRACE_MS = "300";
delete process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS;

const FAKE_SERVER = path.join(here, "fixtures", "fake-codex-app-server.mjs");

// Dynamic imports keep OPENCURSOR_DATA_DIR in effect before any module caches it.
const [
  { createCodexAppServerProvider },
  { AGENT_CAPABILITIES },
] = await Promise.all([
  import("../src/lib/agents/codex-app-server-provider.js"),
  import("../src/lib/agents/agent-contract.js"),
]);

type Types = typeof import("../src/lib/agents/types.js");
type AgentConversationRecord = Types["AgentConversationRecord"];
type AgentEventInput = Types["AgentEventInput"];
type AgentRuntimeCallbacks = Types["AgentRuntimeCallbacks"];
type AgentStoredEvent = Types["AgentStoredEvent"];

type Harness = {
  callbacks: AgentRuntimeCallbacks;
  events: AgentStoredEvent[];
  conversation: () => AgentConversationRecord;
  logPath: string;
  readServerLog: () => Promise<Array<{ direction: string; message: Record<string, unknown> }>>;
  provider: ReturnType<typeof createCodexAppServerProvider>;
  workspaceRoot: string;
};

let harnessCounter = 0;

async function createHarness(options: {
  mode?: string;
  modelId?: string;
  permission?: string;
  env?: Record<string, string>;
  configOptions?: AgentConversationRecord["configOptions"];
} = {}): Promise<Harness> {
  harnessCounter += 1;
  const workspaceRoot = path.join(TEST_ROOT, `workspace-${harnessCounter}`);
  await fs.mkdir(workspaceRoot, { recursive: true });
  const logPath = path.join(TEST_ROOT, `server-log-${harnessCounter}.jsonl`);
  const events: AgentStoredEvent[] = [];
  let seq = 0;
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `codex-conversation-${harnessCounter}`,
    workspaceId: "codex-workspace",
    title: "Codex e2e",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "codex-app-server",
      mode: options.mode ?? "agent",
      modelId: options.modelId ?? "__default__",
      modelName: "Codex App Server Default",
    },
    providerSessionId: null,
    configOptions: options.configOptions ?? [
      {
        id: "permission",
        name: "Execution Mode",
        category: "permission",
        currentValue: options.permission ?? "workspace-write",
        options: [
          { value: "read-only", name: "Read Only" },
          { value: "workspace-write", name: "Workspace Write" },
          { value: "on-request", name: "Ask Every Time" },
        ],
      },
    ],
    capabilities: AGENT_CAPABILITIES["codex-app-server"],
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "codex-workspace",
      root: workspaceRoot,
      name: "Codex",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (input: AgentEventInput[]) => {
      const stored = input.map((event) => {
        seq += 1;
        return { ...event, seq, createdAt: Date.now() } as AgentStoredEvent;
      });
      events.push(...stored);
      return stored;
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function"
          ? patch(conversation)
          : ({ ...conversation, ...patch } as AgentConversationRecord);
      callbacks.conversation = conversation;
      return conversation;
    },
  };
  const provider = createCodexAppServerProvider({
    backend: {
      id: "codex-app-server",
      label: "Codex",
      description: "fake",
      available: true,
      defaultMode: "agent",
      defaultModelId: "__default__",
      defaultModelName: "Codex App Server Default",
      capabilities: AGENT_CAPABILITIES["codex-app-server"],
    },
    runtime: {
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_CODEX_LOG: logPath, ...(options.env ?? {}) },
      commandPreview: `node ${FAKE_SERVER}`,
    },
    configOptions: conversation.configOptions,
  });
  return {
    callbacks,
    events,
    conversation: () => conversation,
    logPath,
    provider,
    workspaceRoot,
    readServerLog: async () => {
      const text = await fs.readFile(logPath, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { direction: string; message: Record<string, unknown> });
    },
  };
}

function eventsOfKind<K extends AgentStoredEvent["kind"]>(
  events: AgentStoredEvent[],
  kind: K
): Array<Extract<AgentStoredEvent, { kind: K }>> {
  return events.filter((event): event is Extract<AgentStoredEvent, { kind: K }> => event.kind === kind);
}

function assistantText(events: AgentStoredEvent[], messageIdPrefix = "codex-app-server-msg"): string {
  return eventsOfKind(events, "assistant_message_chunk")
    .filter((event) => event.messageId.startsWith(messageIdPrefix))
    .map((event) => event.text)
    .join("");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function findClientMessage(
  harness: Harness,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown> | undefined> {
  const log = await harness.readServerLog();
  return log.map((entry) => entry.message).find(predicate);
}

test("codex app server e2e: basic turn streams text, flushes delta-less reasoning, records token usage", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());

  assert.match(handle.sessionId, /fake-thread$/);
  assert.equal(harness.conversation().providerSessionId, handle.sessionId);
  assert.equal(harness.conversation().config.modelName, "Default (kimi-k3)");
  const modelOption = handle.configOptions.find((option) => option.id === "model");
  assert.ok(modelOption?.options.some((option) => option.value === "kimi-k3"), "thread model is exposed in the catalog");

  await handle.prompt({ text: "Reply with pong please", userMessageId: "user-1" });

  assert.equal(assistantText(harness.events), "Testing connection, ready to pong.");
  const reasoning = eventsOfKind(harness.events, "reasoning");
  assert.equal(reasoning.length, 1, "reasoning delivered only via item/completed is still surfaced");
  assert.equal(reasoning[0]?.text, "The user wants a short reply.");
  const ends = eventsOfKind(harness.events, "assistant_message_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.stopReason, "idle");
  const statuses = eventsOfKind(harness.events, "status").map((event) => event.status);
  assert.deepEqual(statuses, ["idle"]);
  assert.equal(harness.conversation().status, "idle");
  assert.equal(harness.conversation().lastError, null);

  const usage = harness.conversation().contextUsage;
  assert.ok(usage?.supported, "token usage snapshot is recorded");
  assert.equal(usage?.limitTokens, 128000);
  assert.equal(usage?.usedTokens, 1200 + 80 - 20);
  assert.equal(usage?.percentFull, 1);

  const turnStart = await findClientMessage(harness, (message) => message.method === "turn/start");
  const params = turnStart?.params as Record<string, unknown>;
  assert.equal(params.approvalPolicy, "on-request");
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [harness.workspaceRoot],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.equal(params.clientUserMessageId, "user-1");
  assert.equal(params.model, undefined, "__default__ leaves model selection to config.toml");
  assert.equal("mode" in params, false, "legacy mode param is not sent");
  assert.equal("mcpServers" in params, false, "plugin MCP servers ride on thread config, not turn/start");
  assert.equal(params.collaborationMode, undefined, "default collaboration mode is not re-sent");

  const threadStart = await findClientMessage(harness, (message) => message.method === "thread/start");
  const threadParams = threadStart?.params as Record<string, unknown>;
  assert.equal(threadParams.sandbox, "workspace-write");
  assert.equal(threadParams.approvalPolicy, "on-request");

  // Duplicate config warnings (notification + stderr) collapse into one system event.
  const warnings = eventsOfKind(harness.events, "system").filter((event) => /bubblewrap/i.test(event.text));
  assert.equal(warnings.length, 1);
});

test("codex app server e2e: command approval sends the {decision} envelope and exposes execpolicy amendments", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());

  const turn = handle.prompt({ text: "scenario:approval", userMessageId: "user-approval" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "approval prompt");
  const request = eventsOfKind(harness.events, "permission_request")[0];
  assert.ok(request);
  assert.equal(request.title, "Approve command");
  assert.match(request.detail ?? "", /pwd/);
  assert.equal(request.toolCallId, harness.conversation().pendingPermission?.toolCallId);
  const optionIds = request.options.map((option) => option.optionId);
  assert.ok(optionIds.includes("accept"));
  assert.ok(optionIds.includes("cancel"));
  const amendment = request.options.find((option) => option.optionId.startsWith("{"));
  assert.ok(amendment, "structured execpolicy decision is offered");
  assert.equal(amendment?.kind, "allow_always");
  assert.match(amendment?.name ?? "", /Always allow `pwd`/);
  assert.ok(optionIds.includes("decline"), "a decline option is always available");
  assert.ok(
    request.options.some((option) => option.optionId === "reject_always"),
    "Cesium remembered-rule options are appended"
  );

  await handle.answerPermission({ requestId: request.requestId, optionId: "accept" });
  await turn;

  const response = await findClientMessage(
    harness,
    (message) => message.method === undefined && message.id === 0
  );
  assert.deepEqual(response?.result, { decision: "accept" });
  const tool = eventsOfKind(harness.events, "tool_call")[0];
  assert.equal(tool?.toolKind, "terminal");
  assert.match(tool?.title ?? "", /pwd/);
  assert.doesNotMatch(tool?.title ?? "", /bin\/bash/);
  const finalTool = eventsOfKind(harness.events, "tool_call_update").at(-1);
  assert.equal(finalTool?.status, "completed");
  assert.match(finalTool?.detail ?? "", /\/tmp\/fake-workspace/);
  assert.match(assistantText(harness.events), /Approved with "accept"/);
  assert.equal(harness.conversation().status, "idle");
  assert.equal(harness.conversation().pendingPermission, null);
});

test("codex app server e2e: structured approval decisions round-trip and cancel interrupts", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());

  const turn = handle.prompt({ text: "scenario:approval", userMessageId: "user-approval-2" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "approval prompt");
  const request = eventsOfKind(harness.events, "permission_request")[0]!;
  const amendment = request.options.find((option) => option.optionId.startsWith("{"))!;
  await handle.answerPermission({ requestId: request.requestId, optionId: amendment.optionId });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, {
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] } },
  });
  assert.match(assistantText(harness.events), /acceptWithExecpolicyAmendment/);

  const harness2 = await createHarness();
  const handle2 = await harness2.provider.startSession(harness2.callbacks);
  t.after(() => handle2.dispose());
  const turn2 = handle2.prompt({ text: "scenario:approval", userMessageId: "user-approval-3" });
  await waitFor(() => harness2.conversation().status === "awaiting_permission", 5_000, "approval prompt");
  const request2 = eventsOfKind(harness2.events, "permission_request")[0]!;
  await handle2.answerPermission({ requestId: request2.requestId, cancelled: true });
  await turn2;
  const response2 = await findClientMessage(harness2, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response2?.result, { decision: "cancel" });
  assert.equal(harness2.conversation().status, "interrupted");
});

test("codex app server e2e: unknown option ids degrade to decline instead of an invalid decision", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:approval", userMessageId: "user-approval-4" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "approval prompt");
  const request = eventsOfKind(harness.events, "permission_request")[0]!;
  await handle.answerPermission({ requestId: request.requestId, optionId: "allow_once" });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, { decision: "decline" });
  assert.match(assistantText(harness.events), /will not run/);
});

test("codex app server e2e: file change approval renders multi-file edits with object kinds", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:filechange", userMessageId: "user-fc" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "file approval");
  const tool = eventsOfKind(harness.events, "tool_call")[0];
  assert.equal(tool?.toolKind, "edit");
  assert.equal(tool?.title, "Edit 2 files");
  assert.deepEqual(tool?.locations, [
    { path: "/tmp/fake-workspace/notes.txt" },
    { path: "/tmp/fake-workspace/created.txt" },
  ]);
  assert.ok(tool?.editPreview, "edit preview derived from the unified diff");
  assert.ok((tool?.editPreview?.addedLines ?? 0) >= 1);
  const request = eventsOfKind(harness.events, "permission_request")[0]!;
  assert.equal(request.title, "Approve file change");
  await handle.answerPermission({ requestId: request.requestId, optionId: "acceptForSession" });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, { decision: "acceptForSession" });
  assert.equal(eventsOfKind(harness.events, "tool_call_update").at(-1)?.status, "completed");
});

test("codex app server e2e: request_user_input becomes an answerable multi-step question", async (t) => {
  const harness = await createHarness({ mode: "plan" });
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());

  const turn = handle.prompt({ text: "scenario:question", userMessageId: "user-question" });
  await waitFor(() => harness.conversation().status === "awaiting_question", 5_000, "question prompt");
  const question = eventsOfKind(harness.events, "question").find((event) => event.status === "pending");
  assert.ok(question);
  assert.equal(question.questions?.length, 2);
  assert.equal(question.questions?.[0]?.id, "framework");
  assert.equal(question.questions?.[0]?.prompt, "Framework: Which framework should the new service use?");
  assert.deepEqual(
    question.questions?.[0]?.options.map((option) => option.label),
    ["Hono — Small and fast", "Express — Battle tested"]
  );
  assert.equal(harness.conversation().pendingQuestion?.questionId, question.questionId);

  const turnStart = await findClientMessage(harness, (message) => message.method === "turn/start");
  const params = turnStart?.params as Record<string, unknown>;
  assert.deepEqual(params.collaborationMode, {
    mode: "plan",
    settings: { model: "kimi-k3", reasoning_effort: null },
  });
  assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: true });

  await handle.answerQuestion({
    questionId: question.questionId,
    answer: [
      "Framework: Which framework should the new service use?: Hono — Small and fast",
      "Database: Which database?: SQLite — Embedded",
    ].join("\n"),
  });
  await turn;

  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, {
    answers: { framework: { answers: ["Hono"] }, db: { answers: ["SQLite"] } },
  });
  assert.match(assistantText(harness.events), /Using Hono with SQLite/);
  const answered = eventsOfKind(harness.events, "question").find((event) => event.status === "answered");
  assert.ok(answered);
  assert.equal(harness.conversation().pendingQuestion, null);
  assert.equal(harness.conversation().status, "idle");
});

test("codex app server e2e: free-text answers to user input are forwarded verbatim", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:question-nonblocking", userMessageId: "user-question-2" });
  await waitFor(() => harness.conversation().status === "awaiting_question", 5_000, "question prompt");
  const question = eventsOfKind(harness.events, "question").find((event) => event.status === "pending")!;
  await handle.answerQuestion({
    questionId: question.questionId,
    answer: "Framework: Which framework should the new service use?: Fastify please\nDatabase: Which database?: (no selection)",
  });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, {
    answers: { framework: { answers: ["Fastify please"] }, db: { answers: [] } },
  });
});

test("codex app server e2e: permission requests grant the requested subset with a scope", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:permissions", userMessageId: "user-perm" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "permissions prompt");
  const request = eventsOfKind(harness.events, "permission_request")[0]!;
  assert.equal(request.title, "Grant additional permissions");
  assert.match(request.detail ?? "", /Write \/tmp\/fake-shared/);
  assert.match(request.detail ?? "", /Network access/);
  assert.deepEqual(
    request.options.map((option) => option.optionId),
    ["grantTurn", "grantSession", "deny"]
  );
  await handle.answerPermission({ requestId: request.requestId, optionId: "grantSession" });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, {
    permissions: { fileSystem: { write: ["/tmp/fake-shared"] }, network: { enabled: true } },
    scope: "session",
  });
});

test("codex app server e2e: MCP tool approvals map to elicitation accept with persist metadata", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:elicitation", userMessageId: "user-elicit" });
  await waitFor(() => harness.conversation().status === "awaiting_permission", 5_000, "elicitation prompt");
  const request = eventsOfKind(harness.events, "permission_request")[0]!;
  assert.match(request.title ?? "", /Approve MCP tool query_docs \(context7\)/);
  assert.match(request.detail ?? "", /Allow the tool call query_docs\?/);
  assert.deepEqual(
    request.options.map((option) => option.optionId),
    ["accept", "acceptForSession", "decline", "cancel"]
  );
  await handle.answerPermission({ requestId: request.requestId, optionId: "acceptForSession" });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, { action: "accept", content: null, _meta: { persist: "session" } });
  assert.match(assistantText(harness.events), /Elicitation accept null \{"persist":"session"\}/);
});

test("codex app server e2e: MCP elicitation forms become typed questions", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:elicitation-form", userMessageId: "user-elicit-form" });
  await waitFor(() => harness.conversation().status === "awaiting_question", 5_000, "form prompt");
  const question = eventsOfKind(harness.events, "question").find((event) => event.status === "pending")!;
  assert.equal(question.prompt, "tickets: Create the ticket?");
  assert.deepEqual(
    question.questions?.map((step) => step.id),
    ["priority", "notify", "title"]
  );
  assert.deepEqual(question.questions?.[1]?.options.map((option) => option.label), ["Yes", "No"]);
  await handle.answerQuestion({
    questionId: question.questionId,
    answer: "Priority: high\nNotify owner: Yes\nTitle: Ship it",
  });
  await turn;
  const response = await findClientMessage(harness, (message) => message.method === undefined && message.id === 0);
  assert.deepEqual(response?.result, {
    action: "accept",
    content: { priority: "high", notify: true, title: "Ship it" },
  });
});

test("codex app server e2e: plan mode streams proposed plans and mirrors turn plans to plan files", async (t) => {
  const harness = await createHarness({ mode: "plan" });
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "Plan the refactor", userMessageId: "user-plan" });

  const planText = assistantText(harness.events, "codex-app-server-plan-");
  assert.match(planText, /^# Proposed plan/);
  assert.match(planText, /3\. Run tests/);
  const ends = eventsOfKind(harness.events, "assistant_message_end");
  assert.ok(ends.some((event) => event.messageId.startsWith("codex-app-server-plan-")));
  const planFiles = eventsOfKind(harness.events, "plan_file");
  assert.ok(planFiles.length >= 2, "turn/plan/updated and the proposed plan both produce plan files");
  for (const planFile of planFiles) {
    const content = await fs.readFile(path.join(harness.workspaceRoot, planFile.path), "utf8");
    assert.ok(content.length > 0);
  }
  const plans = eventsOfKind(harness.events, "plan");
  const turnPlan = plans.find((event) => event.planId.endsWith("-codex-app-server-plan"));
  assert.deepEqual(
    turnPlan?.entries.map((entry) => entry.status),
    ["completed", "in_progress", "pending"]
  );

  // Switching back to agent mode re-sends the default collaboration mode once.
  await handle.setConfigOption("mode", "agent");
  await handle.prompt({ text: "now build it", userMessageId: "user-build" });
  const turnStarts = (await harness.readServerLog())
    .map((entry) => entry.message)
    .filter((message) => message.method === "turn/start")
    .map((message) => message.params as Record<string, unknown>);
  assert.equal(turnStarts.length, 2);
  assert.deepEqual((turnStarts[1]?.collaborationMode as Record<string, unknown>)?.mode, "default");
  assert.deepEqual(turnStarts[1]?.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [harness.workspaceRoot],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("codex app server e2e: collab and sub-agent items keep frontend routing metadata", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "scenario:collab", userMessageId: "user-collab" });
  const tools = eventsOfKind(harness.events, "tool_call");
  const collab = tools.find((event) => event.title === "Spawn agent");
  assert.ok(collab);
  assert.equal(collab.toolKind, "task");
  const raw = collab.raw as Record<string, unknown>;
  assert.equal(raw.type, "collab_tool_call");
  assert.deepEqual(raw.receiver_thread_ids, ["child_thread_1"]);
  assert.equal(raw.receiver_thread_id, "child_thread_1");
  const collabUpdate = eventsOfKind(harness.events, "tool_call_update").find(
    (event) => event.toolCallId === collab.toolCallId
  );
  assert.equal(collabUpdate?.status, "completed");
  assert.match(collabUpdate?.detail ?? "", /Inspect the repo layout/);
  assert.deepEqual((collabUpdate?.raw as Record<string, unknown>).agents_states, {
    child_thread_1: { status: "completed", message: "Found 3 packages." },
  });
  const activity = tools.find((event) => event.title === "explorer started");
  assert.ok(activity);
  assert.equal(activity.status, "in_progress");
  const activityDone = eventsOfKind(harness.events, "tool_call_update").find(
    (event) => event.toolCallId === activity.toolCallId
  );
  assert.equal(activityDone?.status, "completed");
  assert.equal(activityDone?.title, "explorer completed");
});

test("codex app server e2e: provider errors unwrap upstream JSON and fail the turn once", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "scenario:error", userMessageId: "user-error" });
  const errors = eventsOfKind(harness.events, "system").filter((event) => event.level === "error");
  assert.equal(errors.length, 1, "error notification and turn/completed do not double-report");
  assert.equal(errors[0]?.text, "Model 'gpt-6-astra' not found in routing configuration");
  assert.equal(harness.conversation().status, "failed");
  assert.equal(harness.conversation().lastError, "Model 'gpt-6-astra' not found in routing configuration");
  const statuses = eventsOfKind(harness.events, "status").map((event) => event.status);
  assert.deepEqual(statuses, ["failed"]);
});

test("codex app server e2e: retryable errors only warn and the turn still completes", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "scenario:retry", userMessageId: "user-retry" });
  const warning = eventsOfKind(harness.events, "system").find((event) => /retrying/.test(event.text));
  assert.ok(warning);
  assert.equal(warning.level, "warning");
  assert.match(warning.text, /Response stream disconnected mid-turn: stream disconnected/);
  assert.equal(eventsOfKind(harness.events, "system").filter((event) => event.level === "error").length, 0);
  assert.equal(harness.conversation().status, "idle");
  assert.match(assistantText(harness.events), /Recovered after retry/);
});

test("codex app server e2e: cancel interrupts the turn and keeps the cancelled state", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const turn = handle.prompt({ text: "scenario:slow", userMessageId: "user-slow" });
  await waitFor(
    () => eventsOfKind(harness.events, "assistant_message_chunk").length > 0,
    5_000,
    "streaming to begin"
  );
  await handle.cancel();
  await turn;
  const interrupt = await findClientMessage(harness, (message) => message.method === "turn/interrupt");
  assert.ok(interrupt, "turn/interrupt was sent with the active turn id");
  assert.equal((interrupt?.params as Record<string, unknown>).turnId, "turn_0001");
  assert.equal(harness.conversation().status, "cancelled");
  const statuses = eventsOfKind(harness.events, "status").map((event) => event.status);
  assert.deepEqual(statuses, ["cancelled"], "interrupted completion does not override the cancel");
});

test("codex app server e2e: currentTime/read is answered with unix seconds", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "scenario:currenttime", userMessageId: "user-time" });
  const text = assistantText(harness.events);
  const match = /The time is (\d+)\./.exec(text);
  assert.ok(match, `expected a timestamp reply, got ${text}`);
  assert.ok(Math.abs(Number(match[1]) - Date.now() / 1000) < 60);
});

test("codex app server e2e: a missing turn/completed settles via the idle fallback", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  const started = Date.now();
  await handle.prompt({ text: "scenario:nocomplete", userMessageId: "user-nocomplete" });
  assert.ok(Date.now() - started < 4_000, "fallback settles quickly in tests");
  assert.equal(harness.conversation().status, "idle");
  assert.match(assistantText(harness.events), /forgot to complete/);
});

test("codex app server e2e: inline async questions dock after the turn and answer via a follow-up turn", async (t) => {
  const harness = await createHarness();
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "scenario:asyncquestion", userMessageId: "user-async" });
  const question = eventsOfKind(harness.events, "question").find((event) => event.status === "pending");
  assert.ok(question);
  assert.equal(question.prompt, "Update the docs too?");
  assert.deepEqual(question.options.map((option) => option.label), ["Yes", "No"]);
  assert.equal(harness.conversation().status, "awaiting_question");
  assert.equal(harness.conversation().pendingQuestion?.questionId, question.questionId);

  await handle.answerQuestion({ questionId: question.questionId, answer: "Update the docs too?: Yes" });
  await waitFor(() => harness.conversation().status === "idle", 5_000, "follow-up turn");
  const turnStarts = (await harness.readServerLog())
    .map((entry) => entry.message)
    .filter((message) => message.method === "turn/start");
  assert.equal(turnStarts.length, 2, "the answer is delivered as a new turn");
  const followUp = (turnStarts[1]?.params as { input: Array<{ text: string }> }).input[0]?.text;
  assert.equal(followUp, "Update the docs too?: Yes");
  assert.equal(harness.conversation().pendingQuestion, null);
});

test("codex app server e2e: resume uses excludeTurns and falls back to a fresh thread when the rollout is gone", async (t) => {
  const harness = await createHarness();
  const first = await harness.provider.startSession(harness.callbacks);
  await first.prompt({ text: "hello", userMessageId: "user-a" });
  const threadId = first.sessionId;
  await first.dispose();

  const resumed = await harness.provider.loadSession(harness.callbacks, threadId);
  t.after(() => resumed.dispose());
  assert.equal(resumed.sessionId, threadId);
  const resume = await findClientMessage(harness, (message) => message.method === "thread/resume");
  const params = resume?.params as Record<string, unknown>;
  assert.equal(params.threadId, threadId);
  assert.equal(params.excludeTurns, true);
  assert.equal(params.sandbox, "workspace-write");
  await resumed.dispose();

  const broken = await createHarness({ env: { FAKE_CODEX_RESUME_FAILS: "1" } });
  const fallback = await broken.provider.loadSession(broken.callbacks, "01a0dead-fake-thread");
  t.after(() => fallback.dispose());
  assert.notEqual(fallback.sessionId, "01a0dead-fake-thread");
  assert.match(fallback.sessionId, /fake-thread$/);
  const warning = eventsOfKind(broken.events, "system").find((event) => /no longer has thread/.test(event.text));
  assert.ok(warning, "user is told the old thread could not be resumed");
  assert.equal(broken.conversation().providerSessionId, fallback.sessionId);
});

test("codex app server e2e: ask-every-time maps to the untrusted approval policy and read-only sandbox", async (t) => {
  const harness = await createHarness({ permission: "on-request" });
  const handle = await harness.provider.startSession(harness.callbacks);
  t.after(() => handle.dispose());
  await handle.prompt({ text: "ping", userMessageId: "user-untrusted" });
  const turnStart = await findClientMessage(harness, (message) => message.method === "turn/start");
  const params = turnStart?.params as Record<string, unknown>;
  assert.equal(params.approvalPolicy, "untrusted");
  assert.equal((params.sandboxPolicy as Record<string, unknown>).type, "workspaceWrite");

  const readOnly = await createHarness({ permission: "read-only" });
  const readOnlyHandle = await readOnly.provider.startSession(readOnly.callbacks);
  t.after(() => readOnlyHandle.dispose());
  await readOnlyHandle.prompt({ text: "ping", userMessageId: "user-ro" });
  const roTurn = await findClientMessage(readOnly, (message) => message.method === "turn/start");
  assert.deepEqual((roTurn?.params as Record<string, unknown>).sandboxPolicy, { type: "readOnly", networkAccess: true });
  const roThread = await findClientMessage(readOnly, (message) => message.method === "thread/start");
  assert.equal((roThread?.params as Record<string, unknown>).sandbox, "read-only");
});
