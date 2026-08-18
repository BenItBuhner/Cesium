import assert from "node:assert/strict";
import { test } from "node:test";

const [
  { AGENT_BACKENDS, listAgentBackends },
  {
    normalizeOpenCodePolledPermission,
    normalizeOpenCodeServerEvent,
    normalizeOpenCodeServerMessage,
    openCodeServerLegacyPermissionResponse,
    openCodeServerPermissionResponse,
  },
  { openCodeServerPartTextDelta },
  { extractOpenCodeEventSessionId, openCodeEventBelongsToRootSession, translateOpenCodeGlobalPayload },
  { OpenCodeServerClient },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/opencode-server-normalize.js"),
  import("../src/lib/agents/opencode-server-provider.js"),
  import("../src/lib/agents/opencode-global-sse.js"),
  import("../src/lib/agents/opencode-server-client.js"),
]);

test("opencode server client scopes instance routes to the workspace directory", () => {
  const client = new OpenCodeServerClient({
    baseUrl: "http://127.0.0.1:9333/",
    directory: "/data/standalone-chats/chat-123",
  });
  assert.equal(
    client.url("/session"),
    "http://127.0.0.1:9333/session?directory=%2Fdata%2Fstandalone-chats%2Fchat-123"
  );
  assert.equal(
    client.url("/session/ses_1/prompt_async"),
    "http://127.0.0.1:9333/session/ses_1/prompt_async?directory=%2Fdata%2Fstandalone-chats%2Fchat-123"
  );
  assert.equal(
    client.url("/event"),
    "http://127.0.0.1:9333/event?directory=%2Fdata%2Fstandalone-chats%2Fchat-123"
  );
  // Global routes are instance-independent and must stay unscoped.
  assert.equal(client.url("/global/health"), "http://127.0.0.1:9333/global/health");
  assert.equal(client.url("/global/event"), "http://127.0.0.1:9333/global/event");
});

test("opencode server client leaves routes unscoped without a directory", () => {
  const client = new OpenCodeServerClient({ baseUrl: "http://127.0.0.1:9333" });
  assert.equal(client.url("/session"), "http://127.0.0.1:9333/session");
  const blank = new OpenCodeServerClient({ baseUrl: "http://127.0.0.1:9333", directory: "  " });
  assert.equal(blank.url("/session"), "http://127.0.0.1:9333/session");
});

test("opencode server backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const serverIndex = backends.findIndex((backend) => backend.id === "opencode-server");
  assert.ok(serverIndex >= 0);
  assert.equal(AGENT_BACKENDS["opencode-server"].label, "OpenCode");
  assert.equal(AGENT_BACKENDS["opencode-server"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["opencode-server"].capabilities.supportsPermissions, true);
});

test("opencode server normalizes message text and tool parts", () => {
  const events = normalizeOpenCodeServerMessage({
    conversationId: "conv",
    messageId: "msg",
    response: {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "internal thought" },
        {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "/tmp\n",
          },
        },
      ],
    },
  });
  assert.equal(events[0]?.kind, "assistant_message_chunk");
  assert.equal(events[1]?.kind, "reasoning");
  assert.equal(events[2]?.kind, "tool_call_update");
  assert.equal("toolKind" in events[2] ? events[2].toolKind : null, "terminal");
});

test("opencode server does not render user text message responses as assistant output", () => {
  const events = normalizeOpenCodeServerMessage({
    conversationId: "conv",
    messageId: "msg",
    response: {
      info: { role: "user" },
      parts: [{ type: "text", text: "Prior Cesium conversation context" }],
    },
  });
  assert.equal(events.length, 0);
});

test("opencode server ignores SSE text deltas and normalizes permission updates", () => {
  const delta = normalizeOpenCodeServerEvent({
    conversationId: "conv",
    rootSessionId: "ses_root",
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_root",
        messageID: "msg_1",
        field: "text",
        delta: "hi",
      },
    },
  });
  assert.equal(delta.length, 0);

  const permission = normalizeOpenCodeServerEvent({
    conversationId: "conv",
    rootSessionId: "ses_root",
    payload: {
      type: "permission.updated",
      properties: {
        sessionID: "ses_root",
        permission: { id: "perm_1", title: "Run command", description: "pwd" },
      },
    },
  });
  assert.equal(permission[0]?.kind, "permission_request");
  assert.equal("requestId" in permission[0] ? permission[0].requestId : null, "perm_1");
});

test("opencode server can tag child-session tool events for subagent rendering", () => {
  const events = normalizeOpenCodeServerEvent({
    conversationId: "conv",
    rootSessionId: "ses_root",
    allowChildSessionEvents: true,
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "ses_child",
          tool: "bash",
          callId: "call_child",
          state: {
            status: "running",
            input: { command: "pwd" },
          },
        },
      },
    },
  });
  assert.equal(events[0]?.kind, "tool_call_update");
  assert.equal(
    "openCodeSubagentSessionId" in events[0] ? events[0].openCodeSubagentSessionId : null,
    "ses_child"
  );
  assert.equal("toolCallId" in events[0] ? events[0].toolCallId : null, "call_child");
});


test("opencode server text-part updates append only the new tail", () => {
  assert.equal(openCodeServerPartTextDelta("", "hello"), "hello");
  assert.equal(openCodeServerPartTextDelta("hello", "hello world"), " world");
  assert.equal(openCodeServerPartTextDelta("hello world", "hello world"), "");
  assert.equal(openCodeServerPartTextDelta("old text", "replacement"), "replacement");
});

test("opencode ACP global SSE accepts root-session deltas", async () => {
  assert.equal(
    extractOpenCodeEventSessionId("message.updated", {
      info: { sessionID: "ses_root", role: "assistant", finish: "stop" },
    }),
    "ses_root"
  );
  assert.equal(
    await openCodeEventBelongsToRootSession({
      baseUrl: "http://127.0.0.1:1",
      directory: "/tmp",
      eventSessionId: "ses_root",
      rootSessionId: "ses_root",
    }),
    true
  );
  const translated = translateOpenCodeGlobalPayload({
    conversationId: "conv",
    rootSessionId: "ses_root",
    payload: {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_root",
        messageID: "msg_1",
        field: "text",
        delta: "hello",
      },
    },
  });
  assert.equal(translated.kind, "session_update");
  if (translated.kind === "session_update") {
    assert.equal((translated.params.update as { sessionUpdate?: string }).sessionUpdate, "agent_message_chunk");
  }
});

test("opencode server permission response maps to modern once/always/reject", () => {
  assert.deepEqual(openCodeServerPermissionResponse("allow"), { response: "once" });
  assert.deepEqual(openCodeServerPermissionResponse("allow_always"), { response: "always" });
  assert.deepEqual(openCodeServerPermissionResponse("deny"), { response: "reject" });
  assert.deepEqual(openCodeServerPermissionResponse(undefined, true), { response: "reject" });
});

test("opencode server legacy permission response keeps allow/deny shape", () => {
  assert.deepEqual(openCodeServerLegacyPermissionResponse("allow_always"), {
    response: "allow",
    remember: true,
  });
  assert.deepEqual(openCodeServerLegacyPermissionResponse("deny"), { response: "deny" });
});

test("polled permissions normalize with tool linkage and command detail", () => {
  const event = normalizeOpenCodePolledPermission({
    conversationId: "conv",
    entry: {
      id: "per_1",
      sessionID: "ses_root",
      permission: "bash",
      patterns: ["echo hi"],
      metadata: { command: "echo hi" },
      tool: { messageID: "msg_1", callID: "call_9" },
    },
  });
  assert.equal(event?.kind, "permission_request");
  if (event?.kind === "permission_request") {
    assert.equal(event.requestId, "per_1");
    assert.equal(event.title, "OpenCode permission: bash");
    assert.equal(event.detail, "echo hi");
    assert.equal(event.toolCallId, "call_9");
    assert.equal(event.options.length, 3);
  }
});
