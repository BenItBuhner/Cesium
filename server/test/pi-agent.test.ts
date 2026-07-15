import assert from "node:assert/strict";
import { test } from "node:test";

const [
  { AGENT_BACKENDS, listAgentBackends },
  { piAgentEventsFromSessionEvent, piAgentToolEventFromExecution },
  {
    getPiAgentAuthPath,
    getPiAgentDir,
    getPiAgentSessionsDirForCwd,
  },
  {
    createPiAgentFallbackConfigOptions,
    isPiAgentPlaceholderModelCatalog,
    hasPiAgentRichModelCatalog,
  },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/pi-agent-normalize.js"),
  import("../src/lib/pi-agent-settings.js"),
  import("../src/lib/pi-agent-model-catalog.js"),
]);

test("pi agent backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const index = backends.findIndex((backend) => backend.id === "pi-agent");
  assert.ok(index >= 0);
  assert.equal(AGENT_BACKENDS["pi-agent"].label, "Pi Agent");
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsToolCalls, true);
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsInlineReasoning, true);
});

test("pi agent settings use isolated auth storage paths", () => {
  assert.match(getPiAgentDir(), /pi-agent$/);
  assert.match(getPiAgentAuthPath(), /pi-agent[\\/]+auth\.json$/);
  assert.match(getPiAgentSessionsDirForCwd("C:\\workspace"), /sessions[\\/][a-f0-9]{16}$/);
});

test("pi agent placeholder model catalog is detected", () => {
  const fallback = createPiAgentFallbackConfigOptions();
  assert.equal(isPiAgentPlaceholderModelCatalog(fallback), true);
  assert.equal(hasPiAgentRichModelCatalog(fallback), false);

  const rich = fallback.map((option) =>
    option.id === "model"
      ? {
          ...option,
          options: [
            { value: "anthropic/claude-sonnet-4", name: "Anthropic/claude-sonnet-4" },
            { value: "openai-codex/gpt-5", name: "OpenAI Codex/gpt-5" },
          ],
        }
      : option
  );
  assert.equal(isPiAgentPlaceholderModelCatalog(rich), false);
  assert.equal(hasPiAgentRichModelCatalog(rich), true);
});

test("pi agent normalizes streaming and tool events", () => {
  const conversationId = "conv-1";
  const assistantMessageId = "assistant-1";

  const textEvents = piAgentEventsFromSessionEvent({
    conversationId,
    assistantMessageId,
    eventId: () => "evt-text",
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    },
  });
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0]?.kind, "assistant_message_chunk");
  assert.equal(textEvents[0]?.text, "hello");

  const reasoningEvents = piAgentEventsFromSessionEvent({
    conversationId,
    assistantMessageId,
    eventId: () => "evt-reasoning",
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    },
  });
  assert.equal(reasoningEvents[0]?.kind, "reasoning");

  const toolStart = piAgentToolEventFromExecution({
    conversationId,
    eventId: "evt-tool",
    toolCallId: "tool-1",
    toolName: "grep",
    args: { pattern: "foo" },
    status: "in_progress",
  });
  assert.equal(toolStart.kind, "tool_call");
  assert.equal(toolStart.toolKind, "grep");

  const toolEnd = piAgentToolEventFromExecution({
    conversationId,
    eventId: "evt-tool-end",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "npm test" },
    result: { content: [{ type: "text", text: "ok" }] },
    emitAsUpdate: true,
    status: "completed",
  });
  assert.equal(toolEnd.kind, "tool_call_update");
  assert.equal(toolEnd.toolKind, "terminal");

  const endEvents = piAgentEventsFromSessionEvent({
    conversationId,
    assistantMessageId,
    eventId: () => "evt-end",
    event: { type: "agent_end", willRetry: false, messages: [] },
  });
  assert.deepEqual(
    endEvents.map((event) => event.kind),
    ["assistant_message_end", "status"]
  );
  assert.equal(endEvents[1]?.status, "idle");
});
