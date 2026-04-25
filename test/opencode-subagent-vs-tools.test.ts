import assert from "node:assert/strict";
import { test } from "node:test";

test("OpenCode structural tools are never subagent cards (even with ses_* / task_id in file text)", async () => {
  const { classifyToolCallAsSubagentCard } = await import("../src/lib/agent-subagent-routing.ts");
  const event = {
    kind: "tool_call" as const,
    toolCallId: "tc-write-1",
    title: "write",
    toolKind: "edit",
    status: "pending" as const,
    raw: {
      update: {
        title: "write",
        kind: "edit",
        rawInput: JSON.stringify({
          path: "src/x.ts",
          content: "const sid = 'ses_childsession'\n// task_id: fake",
        }),
      },
    },
  };
  assert.equal(classifyToolCallAsSubagentCard("opencode-acp", event as never), false);
});

test("OpenCode todowrite / todo kind is never a subagent card", async () => {
  const { classifyToolCallAsSubagentCard } = await import("../src/lib/agent-subagent-routing.ts");
  const event = {
    kind: "tool_call" as const,
    toolCallId: "tc-todo-1",
    title: "todo_write",
    toolKind: "todo",
    status: "pending" as const,
    raw: {},
  };
  assert.equal(classifyToolCallAsSubagentCard("opencode-acp", event as never), false);
});
