import assert from "node:assert/strict";
import test from "node:test";
import { buildCesiumBaseSystemPrompt, buildCesiumSystemPrompt } from "@cesium/core/mcp";
import {
  buildCesiumContextEntries,
  buildCesiumContextTranscriptFromParts,
  estimateCesiumContextUsageFromParts,
  splitSystemPrompt,
} from "../src/lib/agents/cesium-context-usage.js";
import {
  buildConversationContextEntries,
  buildEventsOnlyContextTranscript,
  poolContextEntries,
} from "../src/lib/agents/context-timeline.js";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

const CONVERSATION_ID = "conv-timeline";

function base(seq: number) {
  return { seq, eventId: `evt-${seq}`, conversationId: CONVERSATION_ID, createdAt: 1_000 + seq };
}

function conversationFixture(): AgentStoredEvent[] {
  return [
    {
      ...base(1),
      kind: "system_reminder",
      reminderId: "r-mode-old",
      targetMessageId: "m1",
      reason: "mode",
      text: "<system-reminder>You are in plan mode.</system-reminder>",
    },
    {
      ...base(2),
      kind: "user_message",
      messageId: "m1",
      content: "Please read the config file.",
    },
    {
      ...base(3),
      kind: "assistant_message_chunk",
      messageId: "a1",
      text: "Sure, ",
    },
    {
      ...base(4),
      kind: "assistant_message_chunk",
      messageId: "a1",
      text: "reading it now.",
    },
    {
      ...base(5),
      kind: "tool_call",
      toolCallId: "tc-1",
      title: "Read config.json",
      toolKind: "read",
      status: "in_progress",
      detail: JSON.stringify({ path: "config.json" }),
      raw: { id: "tc-1", name: "read_file", arguments: { path: "config.json" } },
    },
    {
      ...base(6),
      kind: "tool_call_update",
      toolCallId: "tc-1",
      title: "Read config.json",
      toolKind: "read",
      status: "completed",
      detail: '{\n  "port": 9100\n}',
      raw: {
        request: { id: "tc-1", name: "read_file", arguments: { path: "config.json" } },
        result: '{\n  "port": 9100\n}',
      },
    },
    {
      ...base(7),
      kind: "tool_call",
      toolCallId: "tc-2",
      title: "MCP Linear · list_issues",
      toolKind: "mcp",
      status: "in_progress",
      detail: JSON.stringify({ serverId: "linear", toolName: "list_issues", arguments: {} }),
      raw: {
        id: "tc-2",
        name: "call_mcp_tool",
        arguments: { serverId: "linear", toolName: "list_issues", arguments: {} },
      },
    },
    {
      ...base(8),
      kind: "tool_call_update",
      toolCallId: "tc-2",
      status: "completed",
      detail: "OSP-1 Fix login\nOSP-2 Ship dashboard",
      raw: { request: { id: "tc-2", name: "call_mcp_tool" }, result: "OSP-1 Fix login\nOSP-2 Ship dashboard" },
    },
    {
      ...base(9),
      kind: "assistant_message_end",
      messageId: "a1",
      stopReason: "end_turn",
    },
    {
      ...base(10),
      kind: "status",
      status: "idle",
      detail: "Cesium turn complete.",
    },
    {
      ...base(11),
      kind: "compression_summary",
      messageId: "sum-1",
      summary: "User asked for config; assistant read it and listed Linear issues.",
      retainedTurnCount: 1,
      compressedTurnCount: 3,
      sourceRange: { fromSeq: 1, toSeq: 9 },
      generation: 1,
    },
    {
      ...base(12),
      kind: "system_reminder",
      reminderId: "r-mode-new",
      targetMessageId: "m2",
      reason: "mode",
      text: "<system-reminder>You are in agent mode.</system-reminder>",
    },
    {
      ...base(13),
      kind: "user_message",
      messageId: "m2",
      content: "Now change the port to 9200.",
      attachments: [{ mimeType: "image/png", data: "AAAA", name: "shot.png", kind: "image" }],
    },
    {
      ...base(14),
      kind: "system_reminder",
      reminderId: "r-inline",
      reason: "attachments",
      placement: "inline",
      text: "The user attached shot.png.",
    },
    {
      ...base(15),
      kind: "user_message",
      messageId: "m-hidden",
      content: "hidden bootstrap prompt",
      hidden: true,
    },
  ];
}

test("buildConversationContextEntries mirrors the model history block-for-block", () => {
  const entries = buildConversationContextEntries(conversationFixture());
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    [
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_call",
      "compaction_summary",
      "user_message",
      "system_reminder",
    ]
  );
  // Chronological: every block starts at or after the previous one.
  for (let index = 1; index < entries.length; index += 1) {
    assert.ok((entries[index]!.seqStart ?? 0) >= (entries[index - 1]!.seqStart ?? 0));
  }
  assert.ok(entries.every((entry) => entry.tokens > 0));
  assert.ok(entries.every((entry) => entry.id === `${entry.kind}:${entry.seqStart}`));
});

test("targeted reminders merge onto their user message and only the newest dynamic reminder survives", () => {
  const entries = buildConversationContextEntries(conversationFixture());
  const [firstUser] = entries.filter((entry) => entry.kind === "user_message");
  const secondUser = entries.filter((entry) => entry.kind === "user_message")[1]!;
  // The older "mode" reminder (seq 1) is superseded by the newer one (seq 12).
  assert.equal(firstUser!.reminders, undefined);
  assert.equal(firstUser!.text, "Please read the config file.");
  assert.deepEqual(secondUser.reminders, [
    { reason: "mode", text: "<system-reminder>You are in agent mode.</system-reminder>" },
  ]);
  assert.deepEqual(secondUser.attachments, [
    { name: "shot.png", mimeType: "image/png", kind: "image", size: undefined },
  ]);
  // Reminder text counts toward the block the model actually receives.
  assert.ok(
    secondUser.tokens > Math.ceil("Now change the port to 9200.".length / 4),
    "merged reminder should be included in the estimate"
  );
  assert.deepEqual(
    secondUser.events?.map((event) => event.seq),
    [13, 12]
  );
  const inline = entries.find((entry) => entry.kind === "system_reminder");
  assert.equal(inline?.text, "The user attached shot.png.");
  assert.equal(inline?.detail, "attachments");
});

test("streamed assistant chunks collapse into one block with a merged raw row", () => {
  const entries = buildConversationContextEntries(conversationFixture());
  const assistant = entries.find((entry) => entry.kind === "assistant_message");
  assert.ok(assistant);
  assert.equal(assistant.text, "Sure, reading it now.");
  assert.equal(assistant.seqStart, 3);
  assert.equal(assistant.seqEnd, 9);
  const [merged, end] = assistant.events ?? [];
  assert.equal(merged?.kind, "assistant_message_chunk");
  assert.equal((merged as { text?: string }).text, "Sure, reading it now.");
  assert.equal((merged as { firstSeq?: number }).firstSeq, 3);
  assert.equal(merged?.seq, 4);
  assert.equal(end?.kind, "assistant_message_end");
});

test("tool call and result form one block with verbatim arguments and output", () => {
  const entries = buildConversationContextEntries(conversationFixture());
  const read = entries.find((entry) => entry.toolCall?.toolCallId === "tc-1");
  assert.ok(read);
  assert.equal(read.categoryId, "conversation");
  assert.equal(read.label, "Read config.json");
  assert.equal(read.detail, "read_file · completed");
  assert.deepEqual(read.toolCall?.arguments, { path: "config.json" });
  assert.equal(read.toolCall?.result, '{\n  "port": 9100\n}');
  assert.equal(read.toolCall?.status, "completed");
  assert.equal(read.seqStart, 5);
  assert.equal(read.seqEnd, 6);
  assert.deepEqual(
    read.events?.map((event) => event.kind),
    ["tool_call", "tool_call_update"]
  );
  const expectedTokens =
    Math.ceil(JSON.stringify({ path: "config.json" }).length / 4) +
    Math.ceil('{\n  "port": 9100\n}'.length / 4);
  assert.equal(read.tokens, expectedTokens);
});

test("MCP tool traffic and mcp-servers metadata reads land in the MCP bucket", () => {
  const entries = buildConversationContextEntries([
    ...conversationFixture(),
    {
      ...base(20),
      kind: "tool_call",
      toolCallId: "tc-3",
      title: "Read mcp-servers/linear/tools/_catalog.json",
      toolKind: "read",
      status: "completed",
      detail: JSON.stringify({ path: "mcp-servers/linear/tools/_catalog.json" }),
      raw: {
        id: "tc-3",
        name: "read_file",
        arguments: { path: "mcp-servers/linear/tools/_catalog.json" },
      },
    },
  ]);
  const mcpCall = entries.find((entry) => entry.toolCall?.toolCallId === "tc-2");
  assert.equal(mcpCall?.categoryId, "mcp");
  assert.equal(mcpCall?.colorKey, "mcp");
  assert.equal(mcpCall?.toolCall?.name, "call_mcp_tool");
  assert.equal(mcpCall?.toolCall?.result, "OSP-1 Fix login\nOSP-2 Ship dashboard");
  const catalogRead = entries.find((entry) => entry.toolCall?.toolCallId === "tc-3");
  assert.equal(catalogRead?.categoryId, "mcp");
});

test("compaction summaries are their own summarized block and hidden/non-history events are skipped", () => {
  const entries = buildConversationContextEntries(conversationFixture());
  const compaction = entries.find((entry) => entry.kind === "compaction_summary");
  assert.ok(compaction);
  assert.equal(compaction.categoryId, "summarized_conversation");
  assert.equal(compaction.compaction?.compressedTurnCount, 3);
  assert.deepEqual(compaction.compaction?.sourceRange, { fromSeq: 1, toSeq: 9 });
  assert.equal(compaction.detail, "3 turns compressed");
  assert.equal(
    entries.some((entry) => entry.text === "hidden bootstrap prompt"),
    false
  );
  assert.equal(
    entries.some((entry) => entry.events?.some((event) => event.kind === "status")),
    false
  );
});

test("poolContextEntries reconciles the sequential blocks with the pooled rows", () => {
  const usage = estimateCesiumContextUsageFromParts({
    systemPromptFull: buildCesiumBaseSystemPrompt(),
    events: conversationFixture(),
    limitTokens: 1_000_000,
  });
  assert.ok(usage.timeline);
  assert.deepEqual(
    usage.timeline.slice(0, 3).map((segment) => segment.kind),
    ["system_prompt", "tool_definitions", "mcp_definitions"]
  );
  const pooled = poolContextEntries(usage.timeline);
  assert.deepEqual(pooled, usage.categories);
  for (const row of usage.categories) {
    const sum = usage.timeline
      .filter((segment) => segment.categoryId === row.id)
      .reduce((total, segment) => total + segment.tokens, 0);
    assert.equal(row.tokens, sum, `${row.id} should equal the sum of its segments`);
  }
  assert.equal(
    usage.usedTokens,
    usage.timeline.reduce((total, segment) => total + segment.tokens, 0)
  );
  assert.deepEqual(
    usage.categories.map((row) => row.id),
    ["system_prompt", "tool_definitions", "mcp", "summarized_conversation", "conversation"]
  );
});

test("splitSystemPrompt isolates the MCP section for both prompt builders", () => {
  for (const full of [buildCesiumBaseSystemPrompt(), buildCesiumSystemPrompt()]) {
    const { base: basePrompt, mcp } = splitSystemPrompt(full);
    assert.ok(mcp.startsWith("## Third-Party & MCP Server Tools"));
    assert.equal(basePrompt.includes("## Third-Party & MCP Server Tools"), false);
    assert.equal(/\n---\s*$/.test(basePrompt), false, "no dangling rule left behind");
    assert.ok(basePrompt.length + mcp.length < full.length + 4);
    assert.ok(basePrompt.length > 0);
  }
  // The profile prompt keeps the skills section that follows the MCP section.
  assert.ok(splitSystemPrompt(buildCesiumBaseSystemPrompt()).base.includes("## External Skills & Instructions"));
  assert.deepEqual(splitSystemPrompt("just a prompt"), { base: "just a prompt", mcp: "" });
});

test("buildCesiumContextEntries mirrors provider compaction once the window is crowded", () => {
  const events: AgentStoredEvent[] = [];
  let seq = 1;
  for (let turn = 0; turn < 170; turn += 1) {
    events.push({
      ...base(seq++),
      kind: "user_message",
      messageId: `m-${turn}`,
      content: `Turn ${turn}: ${"x".repeat(200)}`,
    });
    events.push({
      ...base(seq++),
      kind: "assistant_message_chunk",
      messageId: `a-${turn}`,
      text: `Reply ${turn}`,
    });
    events.push({ ...base(seq++), kind: "assistant_message_end", messageId: `a-${turn}` });
  }
  const roomy = buildCesiumContextEntries({
    systemPromptFull: buildCesiumBaseSystemPrompt(),
    events,
    limitTokens: 10_000_000,
  });
  assert.equal(roomy.compacted, false);
  assert.equal(roomy.entries.filter((entry) => entry.kind === "user_message").length, 170);

  const crowded = buildCesiumContextEntries({
    systemPromptFull: buildCesiumBaseSystemPrompt(),
    events,
    limitTokens: 1_000,
  });
  assert.equal(crowded.compacted, true);
  assert.equal(crowded.droppedTurns, 10);
  const users = crowded.entries.filter((entry) => entry.kind === "user_message");
  assert.equal(users.length, 160);
  assert.equal(users[0]!.text?.startsWith("Turn 10:"), true);

  const transcript = buildCesiumContextTranscriptFromParts({
    systemPromptFull: buildCesiumBaseSystemPrompt(),
    events,
    limitTokens: 1_000,
    conversation: { id: CONVERSATION_ID, config: { backendId: "cesium-agent", modelId: "techlit/kimi-k3" } },
    notes: ["profile note"],
  });
  assert.equal(transcript.backendId, "cesium-agent");
  assert.equal(transcript.modelId, "techlit/kimi-k3");
  assert.equal(transcript.notes[0], "profile note");
  assert.ok(transcript.notes.some((note) => note.includes("compaction is active")));
  assert.equal(transcript.usage.percentFull, 100);
  assert.equal(transcript.entries.length, transcript.usage.timeline?.length);
  const systemEntry = transcript.entries[0]!;
  assert.equal(systemEntry.kind, "system_prompt");
  assert.ok(systemEntry.text && systemEntry.text.length > 100);
  const toolsEntry = transcript.entries[1]!;
  assert.equal(toolsEntry.kind, "tool_definitions");
  assert.ok((toolsEntry.tools?.length ?? 0) > 5);
  assert.ok(toolsEntry.tools?.some((tool) => tool.name === "read_file"));
});

test("buildEventsOnlyContextTranscript keeps provider totals for external harnesses", () => {
  const transcript = buildEventsOnlyContextTranscript({
    conversation: { id: CONVERSATION_ID, config: { backendId: "codex-app-server", modelId: "gpt-5" } },
    events: conversationFixture(),
    usage: {
      supported: true,
      limitTokens: 400_000,
      usedTokens: 12_345,
      percentFull: 3,
      categories: [{ id: "conversation", label: "Conversation", tokens: 12_345, colorKey: "conversation" }],
    },
  });
  assert.equal(transcript.backendId, "codex-app-server");
  assert.equal(transcript.usage.usedTokens, 12_345);
  assert.equal(transcript.usage.limitTokens, 400_000);
  assert.equal(transcript.usage.categories[0]?.tokens, 12_345);
  assert.equal(transcript.usage.timeline?.length, 7);
  assert.equal(transcript.entries.some((entry) => entry.kind === "system_prompt"), false);
  assert.ok(transcript.notes[0]?.includes("external harness"));

  const unsupported = buildEventsOnlyContextTranscript({
    conversation: { id: CONVERSATION_ID, config: { backendId: "cursor-acp" } },
    events: conversationFixture(),
    usage: null,
  });
  assert.equal(unsupported.usage.supported, false);
  assert.equal(
    unsupported.usage.usedTokens,
    unsupported.usage.timeline?.reduce((sum, segment) => sum + segment.tokens, 0)
  );
});
