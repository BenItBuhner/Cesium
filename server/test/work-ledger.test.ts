import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-work-ledger-"));
const WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "ledger");
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

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
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[] };
type Responder = (res: ServerResponse) => void;

const scripted: Responder[] = [];
const agentRequests: ChatRequest[] = [];
const modelServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Ledger Test" } }] }));
      return;
    }
    agentRequests.push(body);
    const responder = scripted.shift();
    if (!responder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no scripted response left" } }));
      return;
    }
    responder(res);
  });
});
await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
process.env.CESIUM_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
process.env.CESIUM_API_KEY = "sk-test-ledger";
process.env.CESIUM_PROVIDER_ID = "ledgerhost";
process.env.CESIUM_DEFAULT_MODEL = "kimi-k3";
const MODEL_ID = "ledgerhost/kimi-k3";

const [
  { ensureWorkspaceRegistered },
  { agentRuntimeManager },
  { appendConversationEvents, readConversationSnapshot },
  goals,
  ledger,
  orchestration,
  { getStorage },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/goal-store.js"),
  import("../src/lib/agents/work-ledger.js"),
  import("../src/lib/orchestration/store.js"),
  import("../src/storage/runtime.js"),
]);

after(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const workspace = await ensureWorkspaceRegistered(WORKSPACE_ROOT, "ledger");

async function newConversation() {
  return agentRuntimeManager.createConversation(workspace, { backendId: "cesium-agent", modelId: MODEL_ID });
}

test("board columns and the shared status vocabulary map both ways", () => {
  assert.equal(ledger.statusForColumn("backlog"), "pending");
  assert.equal(ledger.statusForColumn("ready"), "pending");
  assert.equal(ledger.statusForColumn("review"), "in_progress");
  assert.equal(ledger.statusForColumn("blocked"), "blocked");
  assert.equal(ledger.statusForColumn("done"), "completed");
  assert.equal(ledger.columnForStatus("pending", "ready"), "ready", "a column that already means the status stays");
  assert.equal(ledger.columnForStatus("in_progress", "review"), "review");
  assert.equal(ledger.columnForStatus("in_progress", "backlog"), "in_progress");
  assert.equal(ledger.columnForStatus("completed"), "done");
});

test("an older conversation's todo list, Goal items and board issues import once into one ledger", async () => {
  const conversation = await newConversation();
  // State as a build before the ledger left it: a todo list in a plan event,
  // a Goal with its own milestones and todos, and a board with an unkeyed issue.
  await appendConversationEvents(workspace.id, conversation.id, [
    {
      eventId: randomUUID(),
      conversationId: conversation.id,
      kind: "plan",
      planId: "cesium-todos",
      entries: [
        { id: "todo-1", content: "Write the parser", status: "completed" },
        { id: "todo-2", content: "Document the CLI", status: "pending" },
      ],
    },
  ]);
  const legacyGoal = {
    ...goals.createGoalRecord({ workspace, conversationId: conversation.id, objective: "Ship the parser" }),
    status: "active" as const,
    milestones: [{ id: "milestone-1", title: "Parser works", status: "in_progress" as const, updatedAt: 1 }],
    todos: [
      { id: "todo-1", content: "Write the parser", status: "in_progress" as const, milestoneId: "milestone-1", updatedAt: 1 },
      { id: "todo-2", content: "Add parser tests", status: "pending" as const, evidence: "tests/parser.test.ts", updatedAt: 1 },
    ],
  };
  const storage = await getStorage();
  await storage.upsertGoal(legacyGoal);
  const board = await orchestration.createOrchestrationBoard({
    workspace,
    title: "Legacy board",
    headConversationId: conversation.id,
    allowedBackendIds: ["cesium-agent"],
  });
  await orchestration.saveOrchestrationBoardSnapshot({
    ...board,
    issues: [
      {
        schemaVersion: 1,
        id: "legacy-issue",
        boardId: board.board.id,
        title: "Fix the release script",
        description: "",
        columnId: "review",
        priority: "high",
        sortOrder: 1000,
        acceptanceCriteria: [],
        dependencyIssueIds: [],
        blockedReason: null,
        verification: { status: "unchecked" },
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
      },
    ],
  });

  const goal = await goals.readGoalForConversation({ workspace, conversationId: conversation.id });
  assert.ok(goal);
  assert.deepEqual(
    goal.milestones.map((item) => [item.id, item.title, item.status]),
    [["milestone-1", "Parser works", "in_progress"]]
  );
  assert.deepEqual(
    goal.todos.map((item) => [item.id, item.content, item.status, item.milestoneId ?? null, item.evidence ?? null]),
    [
      ["todo-1", "Write the parser", "completed", "milestone-1", null],
      ["todo-2", "Document the CLI", "pending", null, null],
      ["todo-3", "Add parser tests", "pending", null, "tests/parser.test.ts"],
      ["todo-4", "Fix the release script", "in_progress", null, null],
    ],
    "the todo list keeps its ids, the Goal merges by text (furthest status wins, its milestone link and evidence carry over) and moves clashing ids up, and the unkeyed board issue comes last"
  );

  const imported = await orchestration.readOrchestrationBoardSnapshot(board.board.id);
  assert.ok(imported);
  assert.deepEqual(imported.board.settings.workLedger, {
    version: 1,
    importedTodoPlan: true,
    importedGoalIds: [legacyGoal.goalId],
    planFiles: [],
  });
  assert.equal(imported.issues.find((issue) => issue.id === "legacy-issue")?.columnId, "review", "an imported issue keeps its column");
  const stored = await storage.getGoalByConversation(workspace.id, conversation.id);
  assert.deepEqual(stored?.todos, legacyGoal.todos, "the Goal record's own lists are left as they were");

  const eventCount = imported.events.length;
  await goals.readGoalForConversation({ workspace, conversationId: conversation.id });
  await ledger.readWorkLedger({ workspace, conversationId: conversation.id });
  const again = await orchestration.readOrchestrationBoardSnapshot(board.board.id);
  assert.equal(again?.issues.length, 5, "nothing is imported twice (four tasks and a milestone)");
  assert.equal(again?.events.length, eventCount);
});

test("reading a conversation with no work never creates a board", async () => {
  const conversation = await newConversation();
  assert.deepEqual(await ledger.readWorkLedger({ workspace, conversationId: conversation.id }), []);
  assert.equal(await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id), null);
});

test("todos, Goal todos and board issues are the same items", async () => {
  const conversation = await newConversation();
  const scope = { workspace, conversationId: conversation.id };
  await goals.ensureGoalForConversation({ ...scope, objective: "Ship" });
  await goals.updateGoalPlan({
    ...scope,
    milestones: [{ title: "Core done" }],
    todos: [{ content: "Build", milestoneId: "milestone-1" }, { content: "Test" }],
  });
  const board = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id);
  assert.ok(board, "the Goal's items live on the conversation's board");
  const build = board.issues.find((issue) => issue.ledger?.key === "todo-1");
  assert.equal(build?.title, "Build");
  assert.equal(build?.ledger?.parentKey, "milestone-1");

  await ledger.writeWorkLedger(scope, (items) => [
    ...items,
    ledger.newLedgerItem({ key: "todo-3", kind: "task", title: "Fix the release script" }),
  ]);
  const partial = await goals.updateGoalProgress({ ...scope, todos: [{ id: "todo-2", content: "Test", status: "in_progress" }] });
  assert.deepEqual(
    partial.todos.map((todo) => [todo.id, todo.status]),
    [
      ["todo-1", "pending"],
      ["todo-2", "in_progress"],
      ["todo-3", "pending"],
    ],
    "a Goal update that lists some todos updates those in place and deletes nothing from the shared ledger"
  );

  await orchestration.upsertOrchestrationIssue(board.board.id, { id: build!.id, columnId: "done" });
  const goal = await goals.readGoalForConversation(scope);
  assert.equal(goal?.todos.find((todo) => todo.id === "todo-1")?.status, "completed", "moving the issue completes the Goal todo");

  await orchestration.upsertOrchestrationAssignment(board.board.id, {
    schemaVersion: 1,
    id: "assignment-1",
    boardId: board.board.id,
    issueId: board.issues.find((issue) => issue.ledger?.key === "todo-2")!.id,
    conversationId: "child-conversation",
    role: "implementation",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    config: {},
    lastKnownConversationStatus: "running",
  });
  const saved = await ledger.writeWorkLedger(scope, (items) => [
    ...ledger.ledgerMilestones(items),
    ledger.newLedgerItem({ key: "todo-9", kind: "task", title: "Release" }),
  ]);
  assert.deepEqual(
    ledger.ledgerTasks(saved).map((item) => [item.key, item.title, item.assigned]),
    [
      ["todo-9", "Release", false],
      ["todo-2", "Test", true],
    ],
    "a replace deletes unassigned tasks it leaves out and keeps the assigned one after the list"
  );
  const after = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id);
  assert.ok(after?.events.some((event) => event.kind === "issue_deleted" && event.message.includes("Build")));
});

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
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
}

function textTurn(text: string): Responder {
  return (res) =>
    sse(res, [
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
}

async function waitForIdle(conversationId: string, turns: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const snapshot = await readConversationSnapshot(workspace.id, conversationId);
    const ended = snapshot?.events.filter((event: AgentStoredEvent) => event.kind === "assistant_message_end").length ?? 0;
    if (snapshot && snapshot.conversation.status === "idle" && ended >= turns) {
      return snapshot;
    }
    if (snapshot?.conversation.status === "failed") {
      throw new Error(`turn failed: ${snapshot.conversation.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the turn to finish.");
}

function messageText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

test("todo, Goal and board tools share the ledger and every request is a pure append", async () => {
  const conversation = await newConversation();
  scripted.push(
    toolTurn("call_todo", "todo", { action: "replace", items: [{ content: "Read the spec" }, { content: "Write code" }] }),
    textTurn("Listed two todos.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Plan the work.");
  await waitForIdle(conversation.id, 1);

  scripted.push(
    toolTurn("call_goal", "goal_set", {
      objective: "Ship the feature",
      todos: [{ id: "todo-1", content: "Read the spec", status: "completed" }, { content: "Write code" }, { content: "Ship it" }],
    }),
    textTurn("Goal set.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Make it a Goal.");
  await waitForIdle(conversation.id, 2);

  scripted.push(
    toolTurn("call_move", "orchestration_update_issue", { issueId: "todo-2", columnId: "in_progress" }),
    toolTurn("call_list", "todo", { action: "list" }),
    textTurn("Done.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Start the code task on the board.");
  const snapshot = await waitForIdle(conversation.id, 3);

  scripted.push(
    toolTurn("call_plan", "create_plan", {
      title: "Ship plan",
      content: "# Ship plan\n\n- [ ] Write code\n- [ ] Write release notes\n",
    }),
    toolTurn("call_patch", "todo", { action: "patch", items: [{ id: "todo-2", status: "completed" }] }),
    textTurn("Planned.")
  );
  await agentRuntimeManager.promptConversation(workspace, conversation.id, "Write a plan and finish the code.");
  await waitForIdle(conversation.id, 4);
  assert.equal(
    await fs.readFile(path.join(WORKSPACE_ROOT, ".cesium/plans/ship-plan.plan.md"), "utf8"),
    "# Ship plan\n\n- [x] Write code\n- [ ] Write release notes",
    "the plan file is an export: its box for todo-2 follows the todo patch"
  );
  const finalTasks = ledger.ledgerTasks(await ledger.readWorkLedger({ workspace, conversationId: conversation.id }));
  assert.deepEqual(
    finalTasks.map((item) => [item.key, item.title]),
    [
      ["todo-1", "Read the spec"],
      ["todo-2", "Write code"],
      ["todo-3", "Ship it"],
      ["todo-4", "Write release notes"],
    ],
    "plan lines join the ledger: the matching task keeps its key, the new line gets the next one"
  );

  assert.equal(agentRequests.length >= 10, true);
  const requests = agentRequests.slice(-10);
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(requests[index]!.tools, requests[index - 1]!.tools, `request ${index + 1} keeps the tool list`);
    assert.deepEqual(
      requests[index]!.messages.slice(0, requests[index - 1]!.messages.length),
      requests[index - 1]!.messages,
      `request ${index + 1} extends request ${index}`
    );
  }
  const listResult = requests.at(-1)!.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_list");
  assert.equal(
    messageText(listResult),
    "- [completed] todo-1: Read the spec\n- [in_progress] todo-2: Write code\n- [pending] todo-3: Ship it",
    "the board move and the Goal's todos show up in the todo list"
  );
  const plans = snapshot.events.filter((event) => event.kind === "plan");
  assert.deepEqual(
    plans.at(-1)?.kind === "plan" ? plans.at(-1)!.entries.map((entry) => `${entry.id}:${entry.status}`) : [],
    ["todo-1:completed", "todo-2:in_progress", "todo-3:pending"],
    "the chat's todo card follows board changes"
  );
});

test("plan checkboxes follow the ledger and leave other lines alone", async () => {
  const { syncPlanCheckboxes } = await import("../src/lib/agents/cesium-plan-files.js");
  const plan = "# Plan\n\n- [ ] Write code\n  * [x] Unknown step\n- [~] Ship it\nNotes stay.\n";
  const statuses = new Map([["write code", "completed"], ["ship it", "blocked"]] as const);
  assert.equal(
    syncPlanCheckboxes(plan, (text) => statuses.get(text.toLowerCase())),
    "# Plan\n\n- [x] Write code\n  * [x] Unknown step\n- [!] Ship it\nNotes stay.\n"
  );
});

test("an older conversation's plan file imports into the ledger once and then follows it", async () => {
  const conversation = await newConversation();
  const planPath = ".cesium/plans/legacy.plan.md";
  await fs.mkdir(path.join(WORKSPACE_ROOT, ".cesium", "plans"), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_ROOT, planPath), "# Legacy\n\n- [x] Sketch the API\n- [ ] Build the API\n");
  await appendConversationEvents(workspace.id, conversation.id, [
    { eventId: randomUUID(), conversationId: conversation.id, kind: "plan_file", path: planPath, title: "Legacy", previewMode: "preview" },
  ]);
  const scope = { workspace, conversationId: conversation.id };
  const items = await ledger.readWorkLedger(scope);
  assert.deepEqual(
    items.map((item) => [item.key, item.title, item.status]),
    [
      ["todo-1", "Sketch the API", "completed"],
      ["todo-2", "Build the API", "pending"],
    ]
  );
  const board = await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id);
  assert.deepEqual(board?.board.settings.workLedger?.planFiles, [planPath]);

  await ledger.writeWorkLedger(scope, (current) => current.map((item) => (item.key === "todo-2" ? { ...item, status: "in_progress" as const } : item)), { deleteMissing: false });
  assert.equal(
    await fs.readFile(path.join(WORKSPACE_ROOT, planPath), "utf8"),
    "# Legacy\n\n- [x] Sketch the API\n- [~] Build the API\n",
    "the plan's box follows the ledger"
  );
  const before = (await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id))!.issues.length;
  await ledger.readWorkLedger(scope);
  assert.equal((await orchestration.findOrchestrationBoardForHeadConversation(workspace.id, conversation.id))!.issues.length, before, "not imported twice");
});
