import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAgentTodoJsonDetailString,
  stripAgentTodoJsonAssistantContent,
} from "../src/lib/agent-chat.ts";

test("stripAgentTodoJsonAssistantContent removes bare todo JSON arrays", () => {
  const raw = `[
  {"content":"One","priority":"high","status":"completed"},
  {"content":"Two","priority":"high","status":"in_progress"}
]`;
  assert.equal(stripAgentTodoJsonAssistantContent(raw).trim(), "");
});

test("stripAgentTodoJsonAssistantContent removes fenced todo JSON", () => {
  const raw = "Plan:\n\n```json\n[{\"content\":\"A\",\"status\":\"completed\"}]\n```\n";
  const out = stripAgentTodoJsonAssistantContent(raw).trim();
  assert.equal(out, "Plan:");
});

test("isAgentTodoJsonDetailString detects checklist payloads", () => {
  assert.equal(
    isAgentTodoJsonDetailString(
      '[{"content":"Synthesize plan","priority":"high","status":"completed"}]'
    ),
    true
  );
  assert.equal(isAgentTodoJsonDetailString('[{"foo":1}]'), false);
});
