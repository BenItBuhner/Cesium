import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type {
  AgentConversationSnapshot,
  AgentEventInput,
  AgentPlanEntry,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type { CesiumToolContext } from "../src/lib/agents/cesium/tools/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-todo-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
await fs.mkdir(TEST_DATA_DIR, { recursive: true });

// Dynamic imports after the OPENCURSOR_DATA_DIR override so persistence.ts
// never freezes DATA_DIR to the real data directory.
const [
  { todoTool },
  { applyTodoPatch, parseTodoItems, todoEntriesFromReplace },
  { ensureWorkspaceRegistered },
] = await Promise.all([
  import("../src/lib/agents/cesium/tools/plan-tools.js"),
  import("../src/lib/agents/cesium/cesium-todo.js"),
  import("../src/lib/workspace-registry.js"),
]);
const TODO_WORKSPACE_ROOT = path.join(TEST_DATA_DIR, "standalone-chats", "todo");
await fs.mkdir(TODO_WORKSPACE_ROOT, { recursive: true });
const TODO_WORKSPACE = await ensureWorkspaceRegistered(TODO_WORKSPACE_ROOT, "todo");

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

test("replace keeps the legacy id fallback, default status, and status aliases", () => {
  const entries = todoEntriesFromReplace(
    parseTodoItems([
      { content: "Write tests", status: "done" },
      { title: "Ship it", status: "in progress" },
      "Plain string item",
      { id: "custom", text: "Custom id", status: "stuck" },
      { content: "   " },
    ])
  );
  assert.deepEqual(entries, [
    { id: "todo-1", content: "Write tests", status: "completed" },
    { id: "Ship it", content: "Ship it", status: "in_progress" },
    { id: "todo-3", content: "Plain string item", status: "pending" },
    { id: "custom", content: "Custom id", status: "blocked" },
  ]);
});

test("patch merges into the existing list instead of replacing it", () => {
  const existing: AgentPlanEntry[] = [
    { id: "todo-1", content: "Read the code", status: "completed" },
    { id: "todo-2", content: "Write tests", status: "in_progress" },
    { id: "todo-3", content: "Run the suite", status: "pending" },
  ];
  const patched = applyTodoPatch(
    existing,
    parseTodoItems([
      { id: "todo-2", status: "completed" },
      { content: "run the suite", status: "in_progress" },
      { content: "Open the PR" },
    ])
  );
  assert.deepEqual(patched, [
    { id: "todo-1", content: "Read the code", status: "completed" },
    { id: "todo-2", content: "Write tests", status: "completed" },
    { id: "todo-3", content: "run the suite", status: "in_progress" },
    { id: "todo-4", content: "Open the PR", status: "pending" },
  ]);
  // The input list is not mutated.
  assert.equal(existing[1]!.status, "in_progress");
});

test("patch leaves the status alone when the item omits it", () => {
  const patched = applyTodoPatch(
    [{ id: "todo-1", content: "Investigate flake", status: "blocked" }],
    parseTodoItems([{ id: "todo-1", content: "Investigate the CI flake" }])
  );
  assert.deepEqual(patched, [
    { id: "todo-1", content: "Investigate the CI flake", status: "blocked" },
  ]);
});

test("patch matches replace-mode entries whose title doubled as the id", () => {
  const existing = todoEntriesFromReplace(
    parseTodoItems([{ title: "Fix login" }, { title: "Fix logout" }])
  );
  const patched = applyTodoPatch(existing, parseTodoItems([{ title: "Fix login", status: "done" }]));
  assert.deepEqual(patched, [
    { id: "Fix login", content: "Fix login", status: "completed" },
    { id: "Fix logout", content: "Fix logout", status: "pending" },
  ]);
});

type TodoToolHandle = {
  toolTodo: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

async function startTodoSession(): Promise<{
  handle: TodoToolHandle;
  planEvents: () => Array<Extract<AgentStoredEvent, { kind: "plan" }>>;
}> {
  const conversationId = `cesium-todo-${Math.random().toString(36).slice(2, 8)}`;
  const stored: AgentStoredEvent[] = [];
  const ctx = {
    workspace: TODO_WORKSPACE,
    conversationId,
    conversation: { id: conversationId, title: "Todo test" },
    readEvents: async () => [...stored],
    appendEvents: async (events: AgentEventInput[]) => {
      for (const event of events) {
        stored.push({
          ...event,
          seq: stored.length + 1,
          createdAt: stored.length + 1,
        } as AgentStoredEvent);
      }
    },
    readSnapshot: async () => ({ events: [...stored] }) as unknown as AgentConversationSnapshot,
    extraRoots: [],
    readOnlyRoot: path.join(TEST_DATA_DIR, ".tool-output"),
    turnSupportsImages: false,
    attachImage: () => undefined,
    refineTitle: () => undefined,
  } as unknown as CesiumToolContext;
  const handle: TodoToolHandle = { toolTodo: (args) => todoTool(ctx, args), dispose: async () => undefined };
  return {
    handle,
    planEvents: () =>
      stored.filter(
        (event): event is Extract<AgentStoredEvent, { kind: "plan" }> => event.kind === "plan"
      ),
  };
}

test("todo tool 'patch' updates one item without wiping the rest of the list", async () => {
  const { handle, planEvents } = await startTodoSession();
  try {
    await handle.toolTodo({
      action: "replace",
      items: [
        { content: "Read the code", status: "completed" },
        { content: "Write tests", status: "in_progress" },
        { content: "Run the suite" },
      ],
    });
    assert.equal(planEvents().length, 1);
    assert.equal(planEvents()[0]!.entries.length, 3);

    const result = await handle.toolTodo({
      action: "patch",
      items: [{ id: "todo-2", status: "completed" }],
    });
    assert.match(result, /Patched 1 todo item/);

    const latest = planEvents().at(-1)!;
    assert.equal(
      latest.entries.length,
      3,
      "patch must keep the entries it does not mention (the old code replaced the whole list)"
    );
    assert.deepEqual(
      latest.entries.map((entry) => `${entry.id}:${entry.status}`),
      ["todo-1:completed", "todo-2:completed", "todo-3:pending"]
    );

    const listed = await handle.toolTodo({ action: "list" });
    assert.equal(
      listed,
      "- [completed] todo-1: Read the code\n- [completed] todo-2: Write tests\n- [pending] todo-3: Run the suite"
    );
  } finally {
    await handle.dispose();
  }
});
