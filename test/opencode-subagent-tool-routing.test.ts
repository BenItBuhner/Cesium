import assert from "node:assert/strict";
import { test } from "node:test";

test("OpenCode SSE tool_call with openCodeSubagentSessionId stays off root worked-session", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const events = [
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 1,
      kind: "user_message" as const,
      messageId: "u1",
      content: "spawn subagents",
    },
    {
      seq: 2,
      eventId: "e2",
      conversationId: "c1",
      createdAt: 2,
      kind: "tool_call" as const,
      toolCallId: "opencode-sa:child-a:call-1",
      title: "Read package.json",
      toolKind: "read",
      status: "pending" as const,
      openCodeSubagentSessionId: "child-a",
      raw: {},
    },
    {
      seq: 3,
      eventId: "e3",
      conversationId: "c1",
      createdAt: 3,
      kind: "tool_call_update" as const,
      toolCallId: "opencode-sa:child-a:call-1",
      title: "Read package.json",
      toolKind: "read",
      status: "completed" as const,
      openCodeSubagentSessionId: "child-a",
      raw: {},
    },
  ];
  const messages = projectAgentEventsToChatMessages(events as never, {
    backendId: "opencode-server",
    workspaceRoot: "/tmp",
  });
  const worked = messages.filter((m) => m.type === "worked-session");
  assert.equal(
    worked.length,
    0,
    "subagent tools must not appear as root-level worked-session rows"
  );
  const sub = messages.filter((m) => m.type === "subagent");
  assert.equal(sub.length, 1);
  const tr = sub[0]?.subagentTranscript ?? [];
  const toolBlocks = tr.filter((m) => m.type === "worked-session");
  assert.equal(toolBlocks.length, 1);
  assert.ok(
    toolBlocks[0]?.workedEntries?.some(
      (en) => en.kind === "tool" && en.title.includes("package.json")
    )
  );
});

test("OpenCode spawn without embedded ses_* merges child SSE tools into the titled spawn card (FIFO)", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const mkSpawn = (seq: number, toolCallId: string, description: string) =>
    ({
      seq,
      eventId: `evt-${seq}`,
      conversationId: "conv-oc",
      createdAt: seq,
      kind: "tool_call" as const,
      toolCallId,
      title: description,
      toolKind: "task",
      status: "pending" as const,
      raw: {
        update: {
          title: "task",
          rawInput: JSON.stringify({
            subagent_type: "research",
            description,
          }),
        },
      },
    }) as const;

  const messages = projectAgentEventsToChatMessages(
    [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "conv-oc",
        createdAt: 1,
        kind: "user_message" as const,
        messageId: "um1",
        content: "run parallel research",
      },
      mkSpawn(2, "spawn-a", "Research topic A"),
      mkSpawn(3, "spawn-b", "Research topic B"),
      {
        seq: 4,
        eventId: "e4",
        conversationId: "conv-oc",
        createdAt: 4,
        kind: "tool_call" as const,
        toolCallId: "opencode-sa:ses_alpha:read1",
        title: "Read x",
        toolKind: "read",
        status: "pending" as const,
        openCodeSubagentSessionId: "ses_alpha",
        raw: {},
      },
      {
        seq: 5,
        eventId: "e5",
        conversationId: "conv-oc",
        createdAt: 5,
        kind: "tool_call" as const,
        toolCallId: "opencode-sa:ses_beta:read2",
        title: "Read y",
        toolKind: "read",
        status: "pending" as const,
        openCodeSubagentSessionId: "ses_beta",
        raw: {},
      },
    ] as never,
    { backendId: "opencode-server", workspaceRoot: "/tmp" }
  );
  const subs = messages.filter((m) => m.type === "subagent");
  assert.equal(subs.length, 2, "expected no duplicate generic Subagent cards");
  const byId = new Map(subs.map((s) => [s.subagentId, s]));
  const a = byId.get("ses_alpha");
  const b = byId.get("ses_beta");
  assert.ok(a?.subagentTitle?.includes("topic A"));
  assert.ok(b?.subagentTitle?.includes("topic B"));
  assert.ok(
    (a?.subagentTranscript ?? []).some(
      (row) => row.type === "worked-session" && row.workedEntries?.some((e) => e.kind === "tool")
    )
  );
});

test("OpenCode child SSE before spawn tool_call still yields one titled subagent card", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const messages = projectAgentEventsToChatMessages(
    [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "conv-oc2",
        createdAt: 1,
        kind: "user_message" as const,
        messageId: "um1",
        content: "go",
      },
      {
        seq: 2,
        eventId: "e2",
        conversationId: "conv-oc2",
        createdAt: 2,
        kind: "tool_call" as const,
        toolCallId: "opencode-sa:ses_early:read0",
        title: "Read early",
        toolKind: "read",
        status: "pending" as const,
        openCodeSubagentSessionId: "ses_early",
        raw: {},
      },
      {
        seq: 3,
        eventId: "e3",
        conversationId: "conv-oc2",
        createdAt: 3,
        kind: "tool_call" as const,
        toolCallId: "spawn-early",
        title: "Early research",
        toolKind: "task",
        status: "pending" as const,
        raw: {
          update: {
            title: "task",
            rawInput: JSON.stringify({
              subagent_type: "research",
              description: "Early research",
            }),
          },
        },
      },
    ] as never,
    { backendId: "opencode-server", workspaceRoot: "/tmp" }
  );
  const subs = messages.filter((m) => m.type === "subagent");
  assert.equal(subs.length, 1);
  assert.equal(subs[0]?.subagentId, "ses_early");
  assert.ok(String(subs[0]?.subagentTitle).includes("Early research"));
});
