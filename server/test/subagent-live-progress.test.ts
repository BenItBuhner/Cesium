import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-subagent-live-progress-data-")
);

const {
  createSubagentProgressBroadcaster,
  createSubagentToolset,
  latestSubagentTranscriptActivity,
  pushRunningSubagentToolRow,
  runSubagentToolLoop,
  settleSubagentToolRow,
} = await import("../src/lib/agents/cesium/subagent-toolset.js");
import type { AgentStoredEvent } from "../src/lib/agents/types.js";
import type { CesiumAdapterResult } from "../src/lib/agents/cesium/cesium-types.js";

const ADAPTER = {
  apiKind: "openai-chat-completions",
  apiKey: "test",
  providerId: "openai",
  modelId: "openai/test-model",
} as const;

function echoToolset() {
  return createSubagentToolset({
    definitions: [
      { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
    ],
    execute: async () => "echoed",
  });
}

test("onToolCallStart fires before tool execution, onToolCall after", async () => {
  const order: string[] = [];
  const toolset = createSubagentToolset({
    definitions: [
      { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
    ],
    execute: async (name) => {
      order.push(`execute:${name}`);
      return "echoed";
    },
  });
  let call = 0;
  const result = await runSubagentToolLoop({
    adapter: ADAPTER,
    messages: [{ role: "user", content: "run" }],
    toolset,
    runAdapterImpl: async (): Promise<CesiumAdapterResult> => {
      call += 1;
      return call === 1
        ? { text: "", toolRequests: [{ id: "t1", name: "echo", arguments: { value: 1 } }] }
        : { text: "done", toolRequests: [] };
    },
    onToolCallStart: (event) => {
      order.push(`start:${event.name}:${event.toolCallId}`);
    },
    onToolCall: (event) => {
      order.push(`end:${event.name}:${event.ok}`);
    },
  });
  assert.equal(result.text, "done");
  assert.deepEqual(order, ["start:echo:t1", "execute:echo", "end:echo:true"]);
});

test("onToolCallStart is skipped for tools outside the toolset (settle still records the failure)", async () => {
  const order: string[] = [];
  let call = 0;
  await runSubagentToolLoop({
    adapter: ADAPTER,
    messages: [{ role: "user", content: "run" }],
    toolset: echoToolset(),
    runAdapterImpl: async (): Promise<CesiumAdapterResult> => {
      call += 1;
      return call === 1
        ? { text: "", toolRequests: [{ id: "tx", name: "not_a_tool", arguments: {} }] }
        : { text: "done", toolRequests: [] };
    },
    onToolCallStart: (event) => {
      order.push(`start:${event.name}`);
    },
    onToolCall: (event) => {
      order.push(`end:${event.name}:${event.ok}`);
    },
  });
  assert.deepEqual(order, ["end:not_a_tool:false"]);
});

test("running tool rows are pushed in-flight and settled in place with stable seq/eventId", () => {
  const transcript: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "user-event",
      conversationId: "conv",
      createdAt: 1,
      kind: "user_message",
      messageId: "um",
      content: "task",
    },
  ];
  pushRunningSubagentToolRow({
    transcript,
    conversationId: "conv",
    toolCallId: "t1",
    name: "grep",
    arguments: { pattern: "needle" },
  });
  assert.equal(transcript.length, 2);
  const running = transcript[1]!;
  assert.equal(running.kind, "tool_call");
  assert.equal(running.kind === "tool_call" && running.status, "in_progress");
  assert.match((running.kind === "tool_call" && running.detail) || "", /needle/);
  // Point-in-time snapshot like a progress emission takes.
  const snapshot = [...transcript];

  settleSubagentToolRow({
    transcript,
    conversationId: "conv",
    toolCallId: "t1",
    name: "grep",
    result: "3 matches",
    ok: true,
  });
  assert.equal(transcript.length, 2, "settle must replace the running row, not append");
  const settled = transcript[1]!;
  assert.equal(settled.kind === "tool_call" && settled.status, "completed");
  assert.equal(settled.kind === "tool_call" && settled.detail, "3 matches");
  assert.equal(settled.seq, running.seq);
  assert.equal(settled.eventId, running.eventId);
  // Earlier emission snapshots keep their in-flight view.
  assert.equal(snapshot[1]!.kind === "tool_call" && snapshot[1]!.status, "in_progress");

  // A tool that never started (e.g. rejected before execution) still lands a settled row.
  settleSubagentToolRow({
    transcript,
    conversationId: "conv",
    toolCallId: "t2",
    name: "bogus",
    result: "not available",
    ok: false,
  });
  assert.equal(transcript.length, 3);
  assert.equal(transcript[2]!.kind === "tool_call" && transcript[2]!.status, "failed");

  assert.equal(latestSubagentTranscriptActivity(transcript), "bogus");
});

test("latest transcript activity prefers the in-flight tool and falls back to assistant text", () => {
  const transcript: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "e1",
      conversationId: "conv",
      createdAt: 1,
      kind: "assistant_message_chunk",
      messageId: "am",
      text: "Summary of findings",
    },
  ];
  assert.equal(latestSubagentTranscriptActivity(transcript), "Summary of findings");
  pushRunningSubagentToolRow({
    transcript,
    conversationId: "conv",
    toolCallId: "t9",
    name: "terminal",
    arguments: {},
  });
  assert.equal(latestSubagentTranscriptActivity(transcript), "Running terminal");
  assert.equal(latestSubagentTranscriptActivity([]), null);
});

test("progress broadcaster emits immediately, then coalesces bursts into a trailing emission", async () => {
  let emits = 0;
  const broadcaster = createSubagentProgressBroadcaster({
    minIntervalMs: 40,
    emit: async () => {
      emits += 1;
    },
  });
  broadcaster.notify();
  assert.equal(emits, 1, "first notify emits immediately");
  broadcaster.notify();
  broadcaster.notify();
  assert.equal(emits, 1, "burst within the window is deferred");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(emits, 2, "trailing emission carries the last state");
  broadcaster.stop();
});

test("progress broadcaster stop() cancels pending emissions and blocks later notifies", async () => {
  let emits = 0;
  const broadcaster = createSubagentProgressBroadcaster({
    minIntervalMs: 40,
    emit: async () => {
      emits += 1;
    },
  });
  broadcaster.notify();
  broadcaster.notify(); // schedules a trailing emission
  broadcaster.stop(); // cancels it before it fires
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(emits, 1);
  broadcaster.notify();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(emits, 1, "stopped broadcaster never emits again");
});

test("tool loop + broadcaster emit growing running transcripts (live subagent progress)", async () => {
  const transcript: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "user-event",
      conversationId: "conv",
      createdAt: 1,
      kind: "user_message",
      messageId: "um",
      content: "task",
    },
  ];
  const emissions: Array<Array<{ kind: string; status?: string }>> = [];
  const broadcaster = createSubagentProgressBroadcaster({
    minIntervalMs: 0,
    emit: () => {
      emissions.push(
        transcript.map((row) => ({
          kind: row.kind,
          status: row.kind === "tool_call" ? row.status : undefined,
        }))
      );
      return Promise.resolve();
    },
  });
  let call = 0;
  await runSubagentToolLoop({
    adapter: ADAPTER,
    messages: [{ role: "user", content: "run" }],
    toolset: echoToolset(),
    runAdapterImpl: async (): Promise<CesiumAdapterResult> => {
      call += 1;
      if (call <= 2) {
        return {
          text: "",
          toolRequests: [{ id: `t${call}`, name: "echo", arguments: { step: call } }],
        };
      }
      return { text: "done", toolRequests: [] };
    },
    onToolCallStart: (event) => {
      pushRunningSubagentToolRow({
        transcript,
        conversationId: "conv",
        toolCallId: event.toolCallId,
        name: event.name,
        arguments: event.arguments,
      });
      broadcaster.notify();
    },
    onToolCall: (event) => {
      settleSubagentToolRow({
        transcript,
        conversationId: "conv",
        toolCallId: event.toolCallId,
        name: event.name,
        result: event.result,
        ok: event.ok,
      });
      broadcaster.notify();
    },
  });
  broadcaster.stop();

  assert.ok(emissions.length >= 2, `expected multiple live emissions, got ${emissions.length}`);
  assert.ok(
    emissions.some((rows) => rows.some((row) => row.status === "in_progress")),
    "at least one emission shows an in-flight tool"
  );
  const last = emissions[emissions.length - 1]!;
  assert.equal(last.filter((row) => row.kind === "tool_call").length, 2);
  assert.ok(
    last.every((row) => row.kind !== "tool_call" || row.status === "completed"),
    "final emission shows every tool settled"
  );
});
