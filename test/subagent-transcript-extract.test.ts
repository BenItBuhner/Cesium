import assert from "node:assert/strict";
import { test } from "node:test";

test("extractLiveSubagentTranscriptFromMessages prefers latest matching subagent card", async () => {
  const { extractLiveSubagentTranscriptFromMessages } = await import("../src/lib/agent-chat.ts");
  const projected = [
    { id: "u1", type: "user", content: "hi" },
    {
      id: "s1",
      type: "subagent",
      subagentId: "child-a",
      subagentTitle: "Task A",
      subagentStatus: "running",
      subagentTranscript: [{ id: "t1", type: "assistant", content: "old" }],
    },
    {
      id: "s2",
      type: "subagent",
      subagentId: "child-a",
      subagentTitle: "Task A",
      subagentStatus: "completed",
      subagentTranscript: [{ id: "t2", type: "assistant", content: "new" }],
    },
  ] as const;
  const r = extractLiveSubagentTranscriptFromMessages(projected as never, "child-a");
  assert.ok(r);
  assert.equal(r?.subagentRunning, false);
  assert.equal(r?.transcript.length, 2);
  assert.equal(r?.transcript[0]?.content, "old");
  assert.equal(r?.transcript[1]?.content, "new");
});
