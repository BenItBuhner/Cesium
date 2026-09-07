import assert from "node:assert/strict";
import test from "node:test";
import { buildCesiumSystemPrompt } from "@cesium/core/mcp";
import {
  estimateCesiumContextUsageFromParts,
  unsupportedContextUsageSnapshot,
} from "../src/lib/agents/cesium-context-usage.js";
import type { AgentStoredEvent } from "../src/lib/agents/types.js";

test("unsupportedContextUsageSnapshot returns supported false", () => {
  const snapshot = unsupportedContextUsageSnapshot();
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.categories.length, 0);
});

test("estimateCesiumContextUsageFromParts sums categories within limit", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "u1",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "user_message",
      messageId: "m1",
      content: "Hello from the test harness.",
    },
    {
      seq: 2,
      eventId: "a1",
      conversationId: "conv-1",
      createdAt: 2,
      kind: "assistant_message_chunk",
      messageId: "am1",
      text: "Reply text for usage estimation.",
    },
    {
      seq: 3,
      eventId: "a1e",
      conversationId: "conv-1",
      createdAt: 3,
      kind: "assistant_message_end",
      messageId: "am1",
      stopReason: "completed",
    },
  ];

  const usage = estimateCesiumContextUsageFromParts({
    systemPromptFull: buildCesiumSystemPrompt(),
    events,
    limitTokens: 200_000,
  });

  assert.equal(usage.supported, true);
  assert.equal(usage.approximate, true);
  assert.ok(usage.usedTokens > 0);
  assert.ok(usage.limitTokens === 200_000);
  assert.ok(usage.percentFull >= 0 && usage.percentFull <= 100);
  const categorySum = usage.categories.reduce((sum, row) => sum + row.tokens, 0);
  assert.equal(categorySum, usage.usedTokens);
  assert.ok(usage.categories.some((row) => row.id === "system_prompt"));
  assert.ok(usage.categories.some((row) => row.id === "tool_definitions"));
  assert.ok(usage.categories.some((row) => row.id === "conversation"));
});

test("estimateCesiumContextUsageFromParts includes summarized conversation bucket", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "cs1",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "compression_summary",
      messageId: "sum-1",
      summary: "Earlier work on authentication and login flows.",
      retainedTurnCount: 2,
      compressedTurnCount: 8,
    },
    {
      seq: 2,
      eventId: "u2",
      conversationId: "conv-1",
      createdAt: 2,
      kind: "user_message",
      messageId: "m2",
      content: "Continue",
    },
  ];

  const usage = estimateCesiumContextUsageFromParts({
    systemPromptFull: buildCesiumSystemPrompt(),
    events,
    limitTokens: 100_000,
  });

  assert.ok(
    usage.categories.some(
      (row) => row.id === "summarized_conversation" && row.tokens > 0
    )
  );
});

test("estimateCesiumContextUsageFromParts counts in-flight tool output before it completes", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "tool-running",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "tool_call_update",
      toolCallId: "term-1",
      title: "Ran npm test",
      toolKind: "terminal",
      status: "running",
      detail: "Streaming terminal output that is about to land in context.",
    },
  ];

  const usage = estimateCesiumContextUsageFromParts({
    systemPromptFull: buildCesiumSystemPrompt(),
    events,
    limitTokens: 100_000,
  });

  const conversation = usage.categories.find((row) => row.id === "conversation");
  assert.ok(conversation);
  assert.ok(conversation.tokens > 0);
});

test("estimateCesiumContextUsageFromParts attributes MCP tool traffic to the MCP bucket", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "tool-running",
      conversationId: "conv-1",
      createdAt: 1,
      kind: "tool_call_update",
      toolCallId: "browser-1",
      title: "Browser screenshot",
      toolKind: "mcp",
      status: "running",
      detail: "Capturing a browser screenshot for context usage.",
    },
  ];

  const usage = estimateCesiumContextUsageFromParts({
    systemPromptFull: buildCesiumSystemPrompt(),
    events,
    limitTokens: 100_000,
  });

  const mcp = usage.categories.find((row) => row.id === "mcp");
  assert.ok(mcp);
  // The prompt's MCP section plus the in-flight MCP tool payload.
  const mcpSegments = usage.timeline?.filter((segment) => segment.categoryId === "mcp") ?? [];
  assert.equal(mcpSegments.length, 2);
  assert.equal(mcpSegments.map((segment) => segment.kind).join(","), "mcp_definitions,tool_call");
  assert.equal(mcp.tokens, mcpSegments.reduce((sum, segment) => sum + segment.tokens, 0));
  assert.equal(usage.categories.some((row) => row.id === "conversation"), false);
});
