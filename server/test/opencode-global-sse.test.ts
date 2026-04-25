import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openCodeToolPartToAcpSessionUpdate, translateOpenCodeGlobalPayload } from "../src/lib/agents/opencode-global-sse.js";

describe("opencode-global-sse", () => {
  it("maps running tool parts to tool_call_update", () => {
    const part = {
      type: "tool",
      tool: "read",
      callID: "c1",
      sessionID: "ses_child",
      messageID: "m1",
      state: {
        status: "running",
        input: { filePath: "/tmp/x.ts" },
      },
    };
    const u = openCodeToolPartToAcpSessionUpdate(part);
    assert.equal(u?.sessionUpdate, "tool_call_update");
    assert.equal(u?.toolCallId, "c1");
    assert.equal(u?.status, "in_progress");
  });

  it("tags message.part.updated with openCodeChildSessionId for routing", () => {
    const t = translateOpenCodeGlobalPayload({
      conversationId: "conv",
      rootSessionId: "ses_root",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "glob",
            callID: "c99",
            sessionID: "ses_child",
            state: { status: "pending", input: { path: "/w", pattern: "*.ts" } },
          },
        },
      },
    });
    assert.equal(t.kind, "session_update");
    if (t.kind === "session_update") {
      const meta = t.params._meta as Record<string, unknown> | undefined;
      assert.equal(meta?.openCodeChildSessionId, "ses_child");
    }
  });

  it("maps path (not only filePath) to locations for write/read tools", () => {
    const part = {
      type: "tool",
      tool: "write",
      callID: "c-path",
      sessionID: "ses_x",
      messageID: "m0",
      state: { status: "pending", input: { path: "/workspace/foo.ts" } },
    };
    const u = openCodeToolPartToAcpSessionUpdate(part);
    assert.deepEqual(u?.locations, [{ path: "/workspace/foo.ts" }]);
  });

  it("normalizes OpenCode todo tool ids (todo_write → todo kind)", () => {
    const part = {
      type: "tool",
      tool: "todo_write",
      callID: "c-todo",
      sessionID: "ses_x",
      messageID: "m0",
      state: {
        status: "pending",
        input: { todos: [{ content: "A", status: "pending" }] },
      },
    };
    const u = openCodeToolPartToAcpSessionUpdate(part);
    assert.equal(u?.sessionUpdate, "tool_call");
    assert.equal(u?.kind, "todo");
  });

  it("completed tools keep structured output in rawOutput for diff extraction", () => {
    const part = {
      type: "tool",
      tool: "write",
      callID: "c-struct",
      sessionID: "ses_x",
      messageID: "m0",
      state: {
        status: "completed",
        input: { path: "/tmp/a.ts" },
        output: { oldFileContent: "", newFileContent: "export const x = 1;\n" },
      },
    };
    const u = openCodeToolPartToAcpSessionUpdate(part);
    assert.equal(u?.sessionUpdate, "tool_call_update");
    const ro = u?.rawOutput as Record<string, unknown>;
    assert.ok(ro);
    assert.equal(ro.newFileContent, "export const x = 1;\n");
    assert.equal(ro.oldFileContent, "");
  });

  it("translates message.part.delta into synthetic assistant chunks", () => {
    const t = translateOpenCodeGlobalPayload({
      conversationId: "conv",
      rootSessionId: "ses_root",
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_child",
          messageID: "msg_a",
          partID: "p1",
          field: "text",
          delta: "hi",
        },
      },
    });
    assert.equal(t.kind, "append");
    if (t.kind === "append") {
      assert.equal(t.events.length, 1);
      assert.match(String(t.events[0]?.messageId), /^opencode-subagent:ses_child:msg_a$/);
    }
  });
});
