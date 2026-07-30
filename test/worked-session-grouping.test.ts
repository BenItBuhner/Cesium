import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import {
  formatMcpToolDisplayName,
  parseMcpCompositeToolName,
} from "../src/lib/mcp-server-display.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

type ToolEventOverrides = Partial<Extract<AgentStoredEvent, { kind: "tool_call" }>> &
  Partial<Extract<AgentStoredEvent, { kind: "tool_call_update" }>>;

let autoSeq = 0;

function userMessage(content: string, overrides?: Partial<AgentStoredEvent>): AgentStoredEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    eventId: `evt-${autoSeq}`,
    conversationId: "c1",
    createdAt: autoSeq,
    kind: "user_message",
    messageId: `m-${autoSeq}`,
    content,
    ...overrides,
  } as AgentStoredEvent;
}

function cesiumTerminalCall(
  toolCallId: string,
  command: string,
  overrides?: ToolEventOverrides
): AgentStoredEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    eventId: `evt-${autoSeq}`,
    conversationId: "c1",
    createdAt: autoSeq,
    kind: "tool_call",
    toolCallId,
    title: `Run ${command}`,
    toolKind: "terminal",
    status: "in_progress",
    raw: { id: toolCallId, name: "terminal", arguments: { command } },
    ...overrides,
  } as AgentStoredEvent;
}

function cesiumTerminalUpdate(
  toolCallId: string,
  command: string,
  overrides?: ToolEventOverrides
): AgentStoredEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    eventId: `evt-${autoSeq}`,
    conversationId: "c1",
    createdAt: autoSeq,
    kind: "tool_call_update",
    toolCallId,
    title: `Run ${command}`,
    toolKind: "terminal",
    status: "completed",
    detail: "Command exited 0.",
    raw: {
      request: { id: toolCallId, name: "terminal", arguments: { command } },
      result: "Command exited 0.",
    },
    ...overrides,
  } as AgentStoredEvent;
}

function assistantChunk(text: string, messageId = "a-1"): AgentStoredEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    eventId: `evt-${autoSeq}`,
    conversationId: "c1",
    createdAt: autoSeq,
    kind: "assistant_message_chunk",
    messageId,
    text,
  } as AgentStoredEvent;
}

function idleStatus(): AgentStoredEvent {
  autoSeq += 1;
  return {
    seq: autoSeq,
    eventId: `evt-${autoSeq}`,
    conversationId: "c1",
    createdAt: autoSeq,
    kind: "status",
    status: "idle",
  } as AgentStoredEvent;
}

function workedSessions(messages: ReturnType<typeof projectAgentEventsToChatMessages>) {
  return messages.filter(
    (message) => message.type === "worked-session" && !message.loading
  );
}

function toolEntries(messages: ReturnType<typeof projectAgentEventsToChatMessages>) {
  return workedSessions(messages).flatMap((message) =>
    (message.workedEntries ?? []).filter((entry) => entry.kind === "tool")
  );
}

describe("formal MCP tool display names", () => {
  test("humanizes snake/kebab tool names with acronym-aware Title Case", () => {
    assert.equal(formatMcpToolDisplayName("resolve-library-id"), "Resolve Library ID");
    assert.equal(formatMcpToolDisplayName("browser_snapshot", "browser"), "Snapshot");
    assert.equal(formatMcpToolDisplayName("browser_evaluate", "browser"), "Evaluate");
    assert.equal(formatMcpToolDisplayName("query-docs"), "Query Docs");
    assert.equal(formatMcpToolDisplayName("getPageHtml"), "Get Page HTML");
  });

  test("parses composite Claude-style MCP tool names", () => {
    assert.deepEqual(parseMcpCompositeToolName("mcp__github__create_issue"), {
      serverId: "github",
      toolName: "create_issue",
    });
    assert.equal(parseMcpCompositeToolName("read_file"), undefined);
  });

  test("browser MCP call renders as Browser · Evaluate, not a terminal command", () => {
    autoSeq = 0;
    const toolCallId = "mcp-browser-1";
    const args = {
      serverId: "browser",
      toolName: "browser_evaluate",
      arguments: { tabId: "tab-1", script: "document.title" },
    };
    const events: AgentStoredEvent[] = [
      userMessage("check the page"),
      cesiumTerminalCall(toolCallId, "", {
        title: "Browser · Evaluate",
        toolKind: "mcp",
        raw: { id: toolCallId, name: "call_mcp_tool", arguments: args },
      }),
      cesiumTerminalUpdate(toolCallId, "", {
        title: "Browser · Evaluate",
        toolKind: "mcp",
        detail: "ok",
        raw: {
          request: { id: toolCallId, name: "call_mcp_tool", arguments: args },
          result: "ok",
        },
      }),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const tools = toolEntries(messages);
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.ok(tool && tool.kind === "tool");
    assert.equal(tool.toolKind, "mcp");
    assert.equal(tool.mcpServerId, "browser");
    assert.equal(tool.title, "Browser · Evaluate");
    assert.doesNotMatch(tool.title, /^Ran\b/);
    const worked = workedSessions(messages);
    assert.equal(worked.length, 1);
    assert.match(worked[0]?.workedLabel ?? "", /called Browser/i);
    assert.doesNotMatch(worked[0]?.workedLabel ?? "", /ran/i);
  });

  test("composite mcp__ tool names resolve server and formal tool label", () => {
    autoSeq = 0;
    const events: AgentStoredEvent[] = [
      userMessage("make an issue"),
      {
        seq: (autoSeq += 1),
        eventId: `evt-${autoSeq}`,
        conversationId: "c1",
        createdAt: autoSeq,
        kind: "tool_call",
        toolCallId: "mcp-github-1",
        title: "mcp__github__create_issue",
        toolKind: "mcp",
        status: "completed",
        raw: { name: "mcp__github__create_issue", input: { title: "Bug" } },
      } as AgentStoredEvent,
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "claude-code",
    });
    const tools = toolEntries(messages);
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.ok(tool && tool.kind === "tool");
    assert.equal(tool.title, "GitHub · Create Issue");
  });
});

describe("worked-session duplicate suppression", () => {
  test("mid-turn user message does not duplicate an in-flight command", () => {
    autoSeq = 0;
    const events: AgentStoredEvent[] = [
      userMessage("run the build"),
      cesiumTerminalCall("term-1", "npm run build"),
      userMessage("also check lint after"),
      cesiumTerminalUpdate("term-1", "npm run build"),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const tools = toolEntries(messages);
    assert.equal(
      tools.length,
      1,
      `expected a single tool row, got: ${tools.map((tool) => tool.kind === "tool" ? tool.title : "").join(" | ")}`
    );
    const tool = tools[0];
    assert.ok(tool && tool.kind === "tool");
    assert.equal(tool.status, "completed");
    for (const worked of workedSessions(messages)) {
      assert.doesNotMatch(worked.workedLabel ?? "", /ran 2 commands/i);
    }
  });

  test("only the latest turn may show the live Working placeholder", () => {
    autoSeq = 0;
    const events: AgentStoredEvent[] = [
      userMessage("run the build"),
      cesiumTerminalCall("term-1", "npm run build"),
      userMessage("also check lint after"),
      cesiumTerminalUpdate("term-1", "npm run build"),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const loadingRows = messages.filter(
      (message) => message.type === "worked-session" && message.loading
    );
    assert.equal(loadingRows.length, 0);
  });
});

describe("worked-session grouping", () => {
  test("whitespace-only assistant chunks do not split a command burst", () => {
    autoSeq = 0;
    const events: AgentStoredEvent[] = [
      userMessage("fetch both pages"),
      cesiumTerminalCall("term-1", "curl https://a.example"),
      cesiumTerminalUpdate("term-1", "curl https://a.example"),
      assistantChunk("\n\n"),
      cesiumTerminalCall("term-2", "curl https://b.example"),
      cesiumTerminalUpdate("term-2", "curl https://b.example"),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const worked = workedSessions(messages);
    assert.equal(
      worked.length,
      1,
      `expected one dropdown, got labels: ${worked.map((w) => w.workedLabel).join(" | ")}`
    );
    assert.match(worked[0]?.workedLabel ?? "", /ran 2 commands/i);
  });

  test("a burst gated by several permission prompts stays one dropdown", () => {
    autoSeq = 0;
    const permission = (requestId: string, toolCallId: string): AgentStoredEvent =>
      ({
        seq: (autoSeq += 1),
        eventId: `evt-${autoSeq}`,
        conversationId: "c1",
        createdAt: autoSeq,
        kind: "permission_request",
        requestId,
        title: "Run command?",
        toolCallId,
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      }) as AgentStoredEvent;
    const events: AgentStoredEvent[] = [
      userMessage("run everything"),
      cesiumTerminalCall("term-1", "echo one"),
      permission("req-1", "term-1"),
      cesiumTerminalUpdate("term-1", "echo one"),
      cesiumTerminalCall("term-2", "echo two"),
      permission("req-2", "term-2"),
      cesiumTerminalUpdate("term-2", "echo two"),
      cesiumTerminalCall("term-3", "echo three"),
      permission("req-3", "term-3"),
      cesiumTerminalUpdate("term-3", "echo three"),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const worked = workedSessions(messages);
    assert.equal(
      worked.length,
      1,
      `expected one dropdown, got labels: ${worked.map((w) => w.workedLabel).join(" | ")}`
    );
    assert.match(worked[0]?.workedLabel ?? "", /ran 3 commands/i);
    const perms = messages.filter((message) => message.type === "permission-request");
    assert.equal(perms.length, 3);
  });

  test("visible assistant text still splits command groups", () => {
    autoSeq = 0;
    const events: AgentStoredEvent[] = [
      userMessage("fetch both pages"),
      cesiumTerminalCall("term-1", "curl https://a.example"),
      cesiumTerminalUpdate("term-1", "curl https://a.example"),
      assistantChunk("The first host is down, trying the mirror."),
      cesiumTerminalCall("term-2", "curl https://b.example"),
      cesiumTerminalUpdate("term-2", "curl https://b.example"),
      idleStatus(),
    ];
    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const worked = workedSessions(messages);
    assert.equal(worked.length, 2);
    const assistant = messages.find((message) => message.type === "assistant");
    assert.ok(assistant, "expected the assistant text bubble between dropdowns");
    for (const session of worked) {
      assert.match(session.workedLabel ?? "", /ran a command/i);
    }
  });
});
