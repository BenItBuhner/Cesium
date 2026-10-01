import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-child-wakes-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "wakes");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
await fs.writeFile(path.join(WORKSPACE_ROOT, "notes.txt"), "alpha beta\ngamma\n");

for (const key of [
  "REDIS_URL",
  "DATABASE_URL",
  "OPENCURSOR_STORAGE_DRIVER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENCURSOR_TRANSCRIPTION_BASE_URL",
  "OPENCURSOR_TRANSCRIPTION_API_KEY",
  "OPENCURSOR_TITLE_MODEL",
  "CESIUM_MODELS",
]) {
  delete process.env[key];
}
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: Array<{ function?: { name: string; parameters?: unknown } }> };
type Responder = (res: ServerResponse) => void;

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/** Subagents by path, board agents by issue, parents by the [P:name] marker in their first message. */
function agentOf(body: ChatRequest): string {
  const users = body.messages.filter((message) => message.role === "user").map(messageText);
  const child = users.map((text) => /You are subagent (\/root\/\w+)/.exec(text)?.[1]).find(Boolean);
  if (child) return child;
  const board = users.map((text) => /You are assigned to orchestration issue "([^"]+)"/.exec(text)?.[1]).find(Boolean);
  if (board) return `board:${board}`;
  const parent = users.map((text) => /\[P:(\w+)\]/.exec(text)?.[1]).find(Boolean);
  return parent ?? "unknown";
}

const scripts = new Map<string, Responder[]>();
const requests: Array<{ agent: string; body: ChatRequest; at: number }> = [];
const hanging: ServerResponse[] = [];
function script(agent: string, ...responders: Responder[]) {
  scripts.set(agent, [...(scripts.get(agent) ?? []), ...responders]);
}
const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Wake Test" } }] }));
      return;
    }
    const agent = agentOf(body);
    requests.push({ agent, body, at: Date.now() });
    const responder = scripts.get(agent)?.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no scripted response left for ${agent}` } }));
      return;
    }
    responder(res);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
process.env.CESIUM_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
process.env.CESIUM_API_KEY = "sk-test-wakes";
process.env.CESIUM_PROVIDER_ID = "wakehost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "wakehost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { readConversationSnapshot, readConversationEvents, listWorkspaceConversationRecords, updateConversationRecord, appendConversationEvents },
  { patchCesiumAgentSettings },
  { DurableSubagents, childHasNews },
  { defaultHarnessSettings },
  { startChildUpdateWakeListener, composeChildUpdateNotice, assignmentStatusFor },
  { CHILD_UPDATE_COALESCE_PREFIX, CHILD_UPDATE_WAKE_MAX, markChildReported },
  { StoreWake },
  ledger,
  orchestration,
  workflowStore,
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/cesium-agent-settings.js"),
  import("../src/lib/agents/cesium/features/subagents/durable-children.js"),
  import("../src/lib/agents/cesium/features/limits.js"),
  import("../src/lib/agents/child-update-wakes.js"),
  import("../src/lib/agents/child-reports.js"),
  import("../src/lib/agents/store-wakes.js"),
  import("../src/lib/agents/work-ledger.js"),
  import("../src/lib/orchestration/store.js"),
  import("../src/lib/agents/workflow-store.js"),
]);

startChildUpdateWakeListener();
await patchCesiumAgentSettings({ harness: { features: { subagents: { version: 2, enabled: true } } } });

after(async () => {
  for (const res of hanging) res.destroy();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "wakes");

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): Responder {
  return (res) =>
    sse(res, [
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
}

function textTurn(text: string, delayMs = 0, onSent?: (at: number) => void): Responder {
  return (res) =>
    setTimeout(() => {
      sse(res, [
        { choices: [{ index: 0, delta: { content: text } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
      onSent?.(Date.now());
    }, delayMs);
}

function hang(): Responder {
  return (res) => {
    hanging.push(res);
  };
}

async function until<T>(read: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

function endedTurns(events: AgentStoredEvent[]): number {
  return events.filter((event) => event.kind === "assistant_message_end").length;
}

async function idleAfter(conversationId: string, turns: number) {
  return until(async () => {
    const snapshot = await readConversationSnapshot(workspace.id, conversationId);
    if (snapshot?.conversation.status === "failed") throw new Error(`turn failed: ${snapshot.conversation.lastError}`);
    return snapshot && snapshot.conversation.status === "idle" && endedTurns(snapshot.events) >= turns ? snapshot : null;
  }, `${conversationId} idle after ${turns} turns`);
}

function requestsOf(agent: string) {
  return requests.filter((entry) => entry.agent === agent);
}

function toolResult(body: ChatRequest, callId: string): string {
  return messageText(body.messages.find((message) => message.role === "tool" && message.tool_call_id === callId));
}

function assertPureAppend(list: ChatRequest[], label: string) {
  for (let index = 1; index < list.length; index += 1) {
    assert.deepEqual(list[index]!.tools, list[index - 1]!.tools, `${label}: request ${index + 1} keeps the tool list`);
    assert.deepEqual(
      list[index]!.messages.slice(0, list[index - 1]!.messages.length),
      list[index - 1]!.messages,
      `${label}: request ${index + 1} extends request ${index}`
    );
  }
}

async function quietFor(agent: string, ms: number): Promise<void> {
  const before = requestsOf(agent).length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(requestsOf(agent).length, before, `${agent} was not woken`);
}

function handle(conversationId: string) {
  return new DurableSubagents({
    workspace,
    conversationId,
    parentPath: "/root",
    limits: () => defaultHarnessSettings().limits,
    resolveDefaultModelId: () => MODEL_ID,
    resolveSpawnModel: async (requested, fallback) => requested ?? fallback,
    appendEvents: async () => {},
    parentTranscript: async () => "",
    isCancelled: () => false,
  });
}

async function newParent() {
  return agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
}

test("a store wake resolves on the next event, remembers one that came early, and honours its deadline and signal", async () => {
  let emit: () => void = () => {};
  const wake = new StoreWake((onEvent) => {
    emit = onEvent;
    return () => {
      emit = () => {};
    };
  });
  emit();
  assert.equal(await wake.next(Date.now() + 1000), "event", "an event before next() is not lost");
  const pending = wake.next(Date.now() + 5000);
  setTimeout(() => emit(), 10);
  const startedAt = Date.now();
  assert.equal(await pending, "event");
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(await wake.next(Date.now() + 30), "timeout");
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  assert.equal(await wake.next(Number.POSITIVE_INFINITY, abort.signal), "aborted");
  wake.close();
});

test("the update turn folds newer updates per agent and names the right transcript tool", () => {
  const first = composeChildUpdateNotice(null, [{ name: "/root/a", kind: "subagent", status: "completed", detail: "Done </agent> sneaky" }]);
  assert.match(first.text, /<child_agent_updates>/);
  assert.match(first.text, /read_subagent_transcript/);
  assert.doesNotMatch(first.text, /orchestration_read_agent_transcript/);
  assert.equal(first.displayContent, "Agent update · /root/a");
  const merged = composeChildUpdateNotice(first.text, [
    { name: "Issue: Ship", kind: "board", status: "failed", detail: "Error: boom" },
    { name: "/root/a", kind: "subagent", status: "completed", detail: "Done again" },
  ]);
  assert.equal(merged.text.match(/<agent name="\/root\/a"/g)?.length, 1, "one block per agent");
  assert.match(merged.text, /Done again/);
  assert.doesNotMatch(merged.text, /sneaky<\/agent>/);
  assert.match(merged.text, /orchestration_read_agent_transcript/);
  assert.equal(merged.displayContent, "Agent update · Issue: Ship, /root/a");
  assert.equal(assignmentStatusFor({ status: "idle", queuedPrompts: [], lastEventSeq: 4 }), "completed");
  assert.equal(assignmentStatusFor({ status: "idle", queuedPrompts: [], lastEventSeq: 0 }), null);
  assert.equal(assignmentStatusFor({ status: "awaiting_permission", queuedPrompts: [], lastEventSeq: 4 }), "waiting");
});

test("only a turn or a request for a human is news; other child events are reported quietly", async () => {
  const child = await newParent();
  await markChildReported(child.id, child.lastEventSeq);
  await appendConversationEvents(workspace.id, child.id, [
    { eventId: "status-1", conversationId: child.id, kind: "status", status: "running", detail: "Working" },
  ]);
  const afterStatus = (await readConversationSnapshot(workspace.id, child.id))!.conversation;
  assert.equal(await childHasNews(afterStatus), false, "a status line is not news");
  assert.equal(await childHasNews(afterStatus), false, "and it was marked reported");
  await appendConversationEvents(workspace.id, child.id, [
    {
      eventId: "permission-1",
      conversationId: child.id,
      kind: "permission_request",
      requestId: "r1",
      title: "Run the tests",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    },
  ]);
  const afterRequest = (await readConversationSnapshot(workspace.id, child.id))!.conversation;
  assert.equal(await childHasNews(afterRequest), true, "a second request for a human is news even without a turn end");
});

test("wait until=agents returns on the child's turn end, and what it reported never wakes the parent again", async () => {
  const parent = await newParent();
  let childDoneAt = 0;
  script(
    "w1",
    toolTurn("call_spawn", "spawn_agent", { task_name: "waited", message: "Count lines.", fork_turns: "none" }),
    toolTurn("call_wait", "wait", { until: "agents", seconds: 20 }),
    textTurn("Two lines.")
  );
  script("/root/waited", textTurn("notes.txt has 2 lines.", 300, (at) => (childDoneAt = at)));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "[P:w1] Delegate.");
  await idleAfter(parent.id, 1);
  const parentRequests = requestsOf("w1");
  const resumed = parentRequests.at(-1)!;
  const result = JSON.parse(toolResult(resumed.body, "call_wait")) as { agents: Array<{ path: string; status: string; summary: string }> };
  assert.deepEqual(result.agents.map((agent) => [agent.path, agent.status, agent.summary]), [["/root/waited", "completed", "notes.txt has 2 lines."]]);
  console.log(`[latency] wait until=agents: ${resumed.at - childDoneAt}ms from the child's reply to the parent's next request`);
  assertPureAppend(parentRequests.map((entry) => entry.body), "parent");
  await quietFor("w1", 800);
});

test("a child that finishes after the parent's turn ended wakes the parent with one update turn, as a pure append", async () => {
  const parent = await newParent();
  let childDoneAt = 0;
  script(
    "wake",
    toolTurn("call_spawn", "spawn_agent", { task_name: "later", message: "Find the first word.", fork_turns: "none" }),
    textTurn("Started a subagent; I'll hear back when it finishes."),
    textTurn("The subagent says the first word is alpha.")
  );
  script("/root/later", textTurn("The first word is alpha.", 600, (at) => (childDoneAt = at)));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "[P:wake] Delegate and stop.");
  await idleAfter(parent.id, 1);
  const turnEndedAt = Date.now();
  assert.equal(requestsOf("wake").length, 2, "the parent's own turn ended before the child finished");

  const snapshot = await idleAfter(parent.id, 2);
  const parentRequests = requestsOf("wake");
  assert.equal(parentRequests.length, 3);
  const update = parentRequests[2]!;
  assert.ok(childDoneAt > turnEndedAt, "the child finished after the parent's turn");
  const lastUser = update.body.messages.filter((message) => message.role === "user").at(-1);
  assert.match(messageText(lastUser), /<child_agent_updates>[\s\S]*<agent name="\/root\/later" kind="subagent" status="completed">\nThe first word is alpha\.\n<\/agent>/);
  const userEvent = snapshot.events.filter((event) => event.kind === "user_message").at(-1);
  console.log(
    `[latency] parent wake: update turn written ${userEvent!.createdAt - childDoneAt}ms and requested ${update.at - childDoneAt}ms after the child's reply`
  );
  assert.ok(userEvent!.createdAt - childDoneAt < 500, "the parent wakes on the child's turn end");
  assert.equal(userEvent?.kind === "user_message" ? userEvent.displayContent : null, "Agent update · /root/later");
  assertPureAppend(parentRequests.map((entry) => entry.body), "parent across the update turn");
  await quietFor("wake", 800);
});

test("stops the parent caused stay quiet, and a user Stop keeps the parent asleep", async () => {
  const quietParent = await newParent();
  const children = handle(quietParent.id);
  script("/root/stuck", hang());
  await children.spawnAgent({ task_name: "stuck", message: "Never answer.", fork_turns: "none" });
  await until(async () => requestsOf("/root/stuck").length > 0, "stuck child asked the model");
  await children.interruptAgent({ target: "stuck" });
  await quietFor("unknown", 800);
  const quietEvents = await readConversationEvents(workspace.id, quietParent.id);
  assert.equal(quietEvents.filter((event) => event.kind === "user_message").length, 0, "no update turn for a stop the parent made");
  children.dispose();

  const stopped = await newParent();
  script(
    "stop",
    toolTurn("call_spawn", "spawn_agent", { task_name: "slow", message: "Take a while.", fork_turns: "none" }),
    toolTurn("call_wait_time", "wait", { seconds: 30, reason: "Give the child time." })
  );
  script("/root/slow", textTurn("Finally done.", 900));
  await agentRuntimeManager.promptConversation(workspace, stopped.id, "[P:stop] Delegate.");
  await until(async () => requestsOf("stop").length >= 2, "parent started its timed wait");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelAt = Date.now();
  await agentRuntimeManager.cancelConversation(workspace, stopped.id);
  const cancelled = await until(async () => {
    const record = (await readConversationSnapshot(workspace.id, stopped.id))?.conversation;
    return record?.status === "cancelled" ? record : null;
  }, "parent cancelled");
  console.log(`[latency] cancel during a timed wait: ${Date.now() - cancelAt}ms`);
  assert.equal(cancelled.status, "cancelled");
  await until(async () => {
    const child = (await listWorkspaceConversationRecords(workspace.id)).find(
      (record) => record.origin?.kind === "subagent" && record.origin.path === "/root/slow"
    );
    return child?.status === "idle" ? child : null;
  }, "slow child finished");
  await quietFor("stop", 800);
});

test("update turns stop at the cap until the user writes, and Goal continuations do not reset the count", async () => {
  const parent = await newParent();
  script("cap", textTurn("Hello."));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "[P:cap] Hi.");
  await idleAfter(parent.id, 1);
  for (let index = 0; index < CHILD_UPDATE_WAKE_MAX; index += 1) {
    script("cap", textTurn(`Noted ${index + 1}.`));
    await agentRuntimeManager.deliverNotice(workspace, parent.id, {
      coalesceKey: `${CHILD_UPDATE_COALESCE_PREFIX}${parent.id}`,
      compose: () => ({ text: `Update ${index + 1}.`, displayContent: "Agent update · test" }),
    });
    await idleAfter(parent.id, index + 2);
  }
  assert.equal(agentRuntimeManager.childUpdateWakeState(parent.id).count, CHILD_UPDATE_WAKE_MAX);
  script("cap", textTurn("Continuing the Goal."));
  const goalTurn = (agentRuntimeManager as unknown as {
    promptConversationLocked: (...args: unknown[]) => Promise<unknown>;
  }).promptConversationLocked.bind(agentRuntimeManager);
  await goalTurn(workspace, parent.id, "Goal continuation.", undefined, { goalContinuation: true });
  await idleAfter(parent.id, CHILD_UPDATE_WAKE_MAX + 2);
  assert.equal(agentRuntimeManager.childUpdateWakeState(parent.id).count, CHILD_UPDATE_WAKE_MAX, "a Goal continuation keeps the count");

  const children = handle(parent.id);
  script("/root/capped", textTurn("Capped result."));
  await children.spawnAgent({ task_name: "capped", message: "Report.", fork_turns: "none" });
  const notice = await until(async () => {
    const events = await readConversationEvents(workspace.id, parent.id);
    return events.find((event) => event.kind === "system" && /woke this chat 8 times in a row/.test(event.text));
  }, "cap notice");
  assert.ok(notice);
  await quietFor("cap", 600);

  script("cap", textTurn("You're welcome."), textTurn("The capped child reported."));
  const turnsBefore = endedTurns(await readConversationEvents(workspace.id, parent.id));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "Thanks.");
  const after = await idleAfter(parent.id, turnsBefore + 2);
  const lastUser = after.events.filter((event) => event.kind === "user_message").at(-1);
  assert.match(lastUser?.kind === "user_message" ? lastUser.content : "", /<agent name="\/root\/capped" kind="subagent" status="completed">\nCapped result\./);
  assert.equal(agentRuntimeManager.childUpdateWakeState(parent.id).count, 1, "the user's message reset the count");
  children.dispose();
});

test("board agents keep their assignment status current, end a wait, and wake an idle head", async () => {
  const head = await newParent();
  await ledger.writeWorkLedger({ workspace, conversationId: head.id }, () => [
    ledger.newLedgerItem({ key: "todo-1", kind: "task", title: "Count words" }),
    ledger.newLedgerItem({ key: "todo-2", kind: "task", title: "Count lines" }),
  ]);
  script(
    "head",
    toolTurn("call_assign", "orchestration_assign_agent", { issueId: "todo-1", instructions: "Count the words in notes.txt." }),
    toolTurn("call_wait_board", "wait", { until: "agents", seconds: 20 }),
    toolTurn("call_assign2", "orchestration_assign_agent", { issueId: "todo-2", instructions: "Count the lines in notes.txt." }),
    textTurn("Assigned the line count; I'll hear back."),
    textTurn("Both counts are in.")
  );
  let wordsDoneAt = 0;
  let linesDoneAt = 0;
  script("board:Count words", textTurn("3 words.", 300, (at) => (wordsDoneAt = at)));
  script("board:Count lines", textTurn("2 lines.", 700, (at) => (linesDoneAt = at)));
  await agentRuntimeManager.promptConversation(workspace, head.id, "[P:head] Run the board.");
  await idleAfter(head.id, 1);

  const headRequests = requestsOf("head");
  const afterWait = headRequests.find((entry) => toolResult(entry.body, "call_wait_board"))!;
  const waitResult = JSON.parse(toolResult(afterWait.body, "call_wait_board")) as {
    conditionMet: boolean;
    assignment: { status: string; lastKnownConversationStatus: string };
  };
  assert.equal(waitResult.conditionMet, true, "the assigned agent's turn end met the wait");
  assert.equal(waitResult.assignment.status, "completed");
  assert.equal(waitResult.assignment.lastKnownConversationStatus, "idle");
  console.log(`[latency] wait until=agents on a board agent: ${afterWait.at - wordsDoneAt}ms`);

  const woken = await idleAfter(head.id, 2);
  const update = requestsOf("head").at(-1)!;
  const lastUser = woken.events.filter((event) => event.kind === "user_message").at(-1);
  console.log(
    `[latency] head wake by a board agent: update turn written ${lastUser!.createdAt - linesDoneAt}ms and requested ${update.at - linesDoneAt}ms after the agent's reply`
  );
  assert.ok(lastUser!.createdAt - linesDoneAt < 500);
  const content = lastUser?.kind === "user_message" ? lastUser.content : "";
  assert.match(content, /<agent name="Issue: Count lines" kind="board" status="completed">\n2 lines\./);
  assert.doesNotMatch(content, /Count words/, "the waited-on agent is not announced again");
  assert.match(content, /orchestration_read_agent_transcript/);
  const board = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, head.id);
  assert.deepEqual(board!.assignments.map((assignment) => assignment.status), ["completed", "completed"]);
  assertPureAppend(requestsOf("head").map((entry) => entry.body), "head");
  await quietFor("head", 600);
});

test("wait until=board and until=workflow return on the write that meets them", async () => {
  const parent = await newParent();
  await ledger.writeWorkLedger({ workspace, conversationId: parent.id }, () => [
    ledger.newLedgerItem({ key: "todo-1", kind: "task", title: "Review" }),
  ]);
  const run = await workflowStore.upsertWorkflowRun({
    ...workflowStore.createWorkflowRunRecord({ workspace, conversationId: parent.id, script: "return 1;", scriptPath: "inline.js" }),
    status: "running",
  });
  script(
    "watch",
    toolTurn("call_wait_board", "wait", { until: "board", seconds: 20 }),
    toolTurn("call_wait_flow", "wait", { until: "workflow", target: run.runId, seconds: 20 }),
    textTurn("Saw both.")
  );
  let boardWriteAt = 0;
  let flowWriteAt = 0;
  await agentRuntimeManager.promptConversation(workspace, parent.id, "[P:watch] Watch.");
  await until(async () => requestsOf("watch").length >= 1, "parent asked the model");
  setTimeout(() => {
    void (async () => {
      const board = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, parent.id);
      boardWriteAt = Date.now();
      await orchestration.upsertOrchestrationIssue(board!.board.id, { id: board!.issues[0]!.id, columnId: "in_progress" });
    })();
  }, 300);
  await until(async () => requestsOf("watch").length >= 2, "board wait returned");
  setTimeout(() => {
    void (async () => {
      flowWriteAt = Date.now();
      const current = (await workflowStore.readWorkflowRun({ workspaceId: workspace.id, runId: run.runId }))!;
      await workflowStore.updateWorkflowRunStatus(current, "completed", { returnValue: "flow done" });
    })();
  }, 300);
  await idleAfter(parent.id, 1);
  const [, afterBoard, afterFlow] = requestsOf("watch");
  assert.equal((JSON.parse(toolResult(afterBoard!.body, "call_wait_board")) as { conditionMet: boolean }).conditionMet, true);
  assert.match(toolResult(afterFlow!.body, "call_wait_flow"), /"status":"completed"[\s\S]*flow done/);
  console.log(`[latency] wait until=board: ${afterBoard!.at - boardWriteAt}ms; until=workflow: ${afterFlow!.at - flowWriteAt}ms`);
  assert.ok(afterBoard!.at - boardWriteAt < 1500, "a board wait no longer sleeps a 5s poll");
});

test("a revision 1 parent gets the same update turn and keeps its exact tool block", async () => {
  const parent = await newParent();
  await updateConversationRecord(workspace.id, parent.id, (current) => {
    const { toolRevision: _dropped, ...config } = current.config;
    return { ...current, config };
  });
  script(
    "legacy",
    toolTurn("call_spawn", "spawn_agent", { task_name: "old_style", message: "Say hi.", fork_turns: "none" }),
    textTurn("Spawned."),
    textTurn("It said hi.")
  );
  script("/root/old_style", textTurn("Hi.", 400));
  await agentRuntimeManager.promptConversation(workspace, parent.id, "[P:legacy] Spawn one.");
  await idleAfter(parent.id, 2);
  const legacyRequests = requestsOf("legacy").map((entry) => entry.body);
  assert.equal(legacyRequests.length, 3);
  const tools = (legacyRequests[0]!.tools ?? []).map((tool) => tool.function?.name);
  assert.ok(tools.includes("wait_agent") && tools.includes("orchestration_wait"), "revision 1 tools");
  assert.match(messageText(legacyRequests[2]!.messages.filter((message) => message.role === "user").at(-1)), /<agent name="\/root\/old_style"/);
  assertPureAppend(legacyRequests, "revision 1 parent");
});
