import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat";
import type { AgentStoredEvent } from "../src/lib/agent-types";

test("projectAgentEventsToChatMessages preserves plugin metadata on MCP tool rows", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "user-1",
      conversationId: "conversation-1",
      createdAt: 1,
      kind: "user_message",
      messageId: "user-message-1",
      content: "Use Context7",
    },
    {
      seq: 2,
      eventId: "tool-1",
      conversationId: "conversation-1",
      createdAt: 2,
      kind: "tool_call",
      toolCallId: "tool-call-1",
      title: "MCP context7 - resolve-library-id",
      toolKind: "mcp",
      status: "completed",
      detail: "{\"serverId\":\"context7\",\"toolName\":\"resolve-library-id\"}",
      pluginId: "context7",
      pluginName: "Context7",
      pluginIconUrl: "https://context7.com/favicon.ico",
      raw: {
        name: "call_mcp_tool",
        arguments: {
          serverId: "context7",
          toolName: "resolve-library-id",
        },
      },
    },
  ];

  const messages = projectAgentEventsToChatMessages(events);
  const worked = messages.find((message) => message.type === "worked-session");
  assert.ok(worked);
  const tool = worked.workedEntries?.find((entry) => entry.kind === "tool");
  assert.equal(tool?.kind, "tool");
  assert.equal(tool?.pluginId, "context7");
  assert.equal(tool?.pluginName, "Context7");
  assert.equal(tool?.pluginIconUrl, "https://context7.com/favicon.ico");
});
