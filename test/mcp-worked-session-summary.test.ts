import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import {
  formatMcpServerDisplayName,
  normalizeMcpServerId,
  summarizeMcpServerCounts,
  summarizeMcpWorkedTools,
} from "../src/lib/mcp-server-display.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("MCP server display names", () => {
  test("normalizeMcpServerId strips plugin prefixes and dedupes", () => {
    assert.equal(normalizeMcpServerId("context7"), "context7");
    assert.equal(
      normalizeMcpServerId("plugin-context7-plugin-context7"),
      "context7"
    );
    assert.equal(normalizeMcpServerId("mcp-linear"), "linear");
  });

  test("formatMcpServerDisplayName uses preset labels", () => {
    assert.equal(formatMcpServerDisplayName("context7"), "Context7");
    assert.equal(formatMcpServerDisplayName("plugin-linear"), "Linear");
    assert.equal(formatMcpServerDisplayName("my_custom_server"), "My Custom Server");
  });

  test("summarizeMcpWorkedTools handles counts and multiple servers", () => {
    assert.equal(
      summarizeMcpWorkedTools([
        { kind: "tool", title: "MCP context7 - resolve-library-id", mcpServerId: "context7" },
      ]),
      "called Context7"
    );
    assert.equal(
      summarizeMcpWorkedTools([
        { kind: "tool", title: "MCP context7 - a", mcpServerId: "context7" },
        { kind: "tool", title: "MCP context7 - b", mcpServerId: "context7" },
      ]),
      "called Context7 2 times"
    );
    assert.equal(
      summarizeMcpServerCounts(
        new Map([
          ["context7", 2],
          ["linear", 1],
        ])
      ),
      "called Context7 2 times and Linear"
    );
  });
});

describe("MCP worked-session projection", () => {
  test("Cesium call_mcp_tool events produce readable workedLabel", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Look up React docs",
      },
      {
        seq: 2,
        eventId: "tc1",
        conversationId: "c1",
        createdAt: 2,
        kind: "tool_call",
        toolCallId: "mcp-1",
        title: "MCP context7 - resolve-library-id",
        toolKind: "mcp",
        status: "completed",
        raw: {
          request: {
            name: "call_mcp_tool",
            arguments: { serverId: "context7", toolName: "resolve-library-id" },
          },
        },
      },
      {
        seq: 3,
        eventId: "tc1u",
        conversationId: "c1",
        createdAt: 3,
        kind: "tool_call_update",
        toolCallId: "mcp-1",
        title: "MCP context7 - resolve-library-id",
        toolKind: "mcp",
        status: "completed",
        detail: "ok",
        raw: {
          request: {
            name: "call_mcp_tool",
            arguments: { serverId: "context7", toolName: "resolve-library-id" },
          },
          result: "ok",
        },
      },
      {
        seq: 4,
        eventId: "r1",
        conversationId: "c1",
        createdAt: 4,
        kind: "tool_call",
        toolCallId: "read-1",
        title: "Read package.json",
        toolKind: "read",
        status: "completed",
        locations: [{ path: "package.json" }],
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const worked = messages.find((message) => message.type === "worked-session");
    assert.ok(worked, "expected worked-session");
    assert.match(worked.workedLabel ?? "", /called Context7/i);
    assert.doesNotMatch(worked.workedLabel ?? "", /called MCP tool/i);
    const mcpEntry = worked.workedEntries?.find(
      (entry) => entry.kind === "tool" && entry.toolKind === "mcp"
    );
    assert.ok(mcpEntry && mcpEntry.kind === "tool");
    assert.equal(mcpEntry.mcpServerId, "context7");
    assert.match(mcpEntry.title, /Context7/);
  });
});
