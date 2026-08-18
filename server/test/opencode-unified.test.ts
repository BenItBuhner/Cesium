import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AGENT_BACKENDS, listAgentBackends } from "../src/lib/agents/providers.js";
import { createOpenCodeProvider } from "../src/lib/agents/opencode-provider.js";
import { normalizeConversationRecord } from "../src/lib/agents/conversation-normalize.js";
import {
  parseOpenCodeGeneration,
  resolveOpenCodeGeneration,
  withOpenCodeGenerationOption,
} from "../src/lib/agents/opencode-generation.js";
import { OpenCodeServerClient } from "../src/lib/agents/opencode-server-client.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
} from "../src/lib/agents/types.js";

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500).end(String(error));
    });
  });
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function sseWrite(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseConversation(
  id: string,
  extra?: Partial<AgentConversationRecord>
): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    workspaceId: "ws-opencode",
    title: "OpenCode unified",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "opencode-server",
      mode: "build",
      modelId: "dummy/free",
      modelName: "Dummy Free",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: AGENT_BACKENDS["opencode-server"].capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    ...extra,
  };
}

async function withCallbacks(workspaceRoot: string, conversation: AgentConversationRecord) {
  const appended: AgentEventInput[] = [];
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: conversation.workspaceId,
      root: workspaceRoot,
      name: "OpenCode",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (events) => {
      appended.push(...events);
      return events.map((event, index) => ({
        ...event,
        seq: appended.length + index,
        createdAt: Date.now(),
      })) as never;
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function"
          ? patch(conversation)
          : ({ ...conversation, ...patch } as AgentConversationRecord);
      callbacks.conversation = conversation;
      return conversation;
    },
  };
  return { callbacks, appended, getConversation: () => conversation };
}

test("OpenCode picker exposes one harness that packages both generations", () => {
  const ids = listAgentBackends().map((backend) => backend.id);
  assert.deepEqual(
    ids.filter((id) => id.startsWith("opencode")),
    ["opencode-server"]
  );
  assert.equal(AGENT_BACKENDS["opencode-server"].label, "OpenCode");
  const options = withOpenCodeGenerationOption([], "current");
  assert.deepEqual(
    options[0]?.options.map((option) => option.value),
    ["current", "v2-beta"]
  );
});

test("OpenCode generation resolver prefers conversation, then env, then v2 URL", () => {
  assert.equal(parseOpenCodeGeneration("v2"), "v2-beta");
  assert.equal(
    resolveOpenCodeGeneration({
      options: withOpenCodeGenerationOption([], "v2-beta"),
    }),
    "v2-beta"
  );
  assert.equal(resolveOpenCodeGeneration({ backendId: "opencode-v2-beta" }), "v2-beta");
  const previous = process.env.OPENCURSOR_OPENCODE_PROTOCOL;
  const previousUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
  try {
    process.env.OPENCURSOR_OPENCODE_PROTOCOL = "current";
    delete process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
    assert.equal(resolveOpenCodeGeneration(), "current");
    process.env.OPENCURSOR_OPENCODE_PROTOCOL = "auto";
    process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = "http://127.0.0.1:9";
    assert.equal(resolveOpenCodeGeneration(), "v2-beta");
  } finally {
    if (previous == null) delete process.env.OPENCURSOR_OPENCODE_PROTOCOL;
    else process.env.OPENCURSOR_OPENCODE_PROTOCOL = previous;
    if (previousUrl == null) delete process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
    else process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = previousUrl;
  }
});

test("legacy OpenCode v2 Beta conversations remap onto OpenCode with generation=v2-beta", () => {
  const remapped = normalizeConversationRecord(
    baseConversation("legacy-v2", {
      config: {
        backendId: "opencode-v2-beta",
        mode: "build",
        modelId: "opencode/big-pickle",
        modelName: "Big Pickle",
      },
      providerSessionId: "ses_keep",
    })
  );
  assert.equal(remapped.config.backendId, "opencode-server");
  assert.equal(remapped.providerSessionId, "ses_keep");
  assert.equal(remapped.config.modelId, "opencode/big-pickle");
  assert.equal(
    remapped.configOptions.find((option) => option.id === "generation")?.currentValue,
    "v2-beta"
  );
});

test("current OpenCode client exposes session status, children, todos, commands, and backgrounding", () => {
  const client = new OpenCodeServerClient({
    baseUrl: "http://127.0.0.1:4096",
    directory: "/workspace",
  });
  assert.match(client.url("/session/status"), /\/session\/status\?directory=/);
  assert.match(client.url("/session/ses_1/children"), /\/session\/ses_1\/children\?directory=/);
  assert.match(client.url("/session/ses_1/todo"), /\/session\/ses_1\/todo\?directory=/);
  assert.match(client.url("/command"), /\/command\?directory=/);
  assert.match(client.url("/agent"), /\/agent\?directory=/);
  assert.match(
    client.url("/experimental/session/ses_1/background"),
    /\/experimental\/session\/ses_1\/background\?directory=/
  );
  assert.match(client.url("/pty"), /\/pty\?directory=/);
  assert.equal(client.url("/global/health"), "http://127.0.0.1:4096/global/health");
});

test("createOpenCodeProvider drives a current-dialect dummy server through a full turn", async () => {
  process.env.OPENCODE_SERVER_FINISH_QUIET_MS = "20";
  const eventStreams = new Set<ServerResponse>();
  const promptBodies: Array<Record<string, unknown>> = [];
  const { server, url } = await listen(async (request, response) => {
    const parsed = new URL(request.url ?? "/", url);
    if (request.method === "GET" && parsed.pathname === "/global/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "1.99.0-dummy" }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/permission") {
      response.setHeader("content-type", "application/json");
      response.end("[]");
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "ses_root", title: "OpenCode unified" }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/session/ses_root") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "ses_root" }));
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/session/ses_root/prompt_async") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      promptBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(204).end();
      setTimeout(() => {
        for (const stream of eventStreams) {
          sseWrite(stream, {
            type: "message.updated",
            properties: {
              sessionID: "ses_root",
              info: { id: "msg_assistant", role: "assistant" },
            },
          });
          sseWrite(stream, {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_root",
              part: {
                id: "prt_1",
                messageID: "msg_assistant",
                sessionID: "ses_root",
                type: "text",
                text: "hello from current",
              },
            },
          });
          sseWrite(stream, {
            type: "session.idle",
            properties: { sessionID: "ses_root" },
          });
        }
      }, 15);
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/session/ses_root/abort") {
      response.setHeader("content-type", "application/json");
      response.end("true");
      return;
    }
    if (
      request.method === "GET" &&
      (parsed.pathname === "/event" || parsed.pathname === "/global/event")
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sseWrite(response, { type: "server.connected", properties: {} });
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    response.writeHead(404).end();
  });
  const previousUrl = process.env.OPENCURSOR_OPENCODE_SERVER_URL;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-current-"));
  process.env.OPENCURSOR_OPENCODE_SERVER_URL = url;
  const conversation = baseConversation("conv-current", {
    configOptions: withOpenCodeGenerationOption([], "current"),
  });
  const { callbacks, appended } = await withCallbacks(workspaceRoot, conversation);
  try {
    const provider = createOpenCodeProvider({
      backend: AGENT_BACKENDS["opencode-server"],
      configOptions: withOpenCodeGenerationOption([], "current"),
    });
    const handle = await provider.startSession(callbacks);
    await handle.prompt({ text: "Say hello", userMessageId: "user-1" });
    assert.equal(promptBodies.length, 1);
    assert.ok(
      appended.some(
        (event) =>
          event.kind === "assistant_message_chunk" && event.text.includes("hello from current")
      )
    );
    assert.ok(appended.some((event) => event.kind === "assistant_message_end"));
    assert.equal(callbacks.conversation.providerSessionId, "ses_root");
    assert.equal(
      callbacks.conversation.configOptions.find((option) => option.id === "generation")?.currentValue,
      "current"
    );
    await handle.dispose();
  } finally {
    if (previousUrl == null) delete process.env.OPENCURSOR_OPENCODE_SERVER_URL;
    else process.env.OPENCURSOR_OPENCODE_SERVER_URL = previousUrl;
    for (const stream of eventStreams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("createOpenCodeProvider drives a v2-beta dummy through tools, background PTY, and forms", async () => {
  const eventStreams = new Set<ServerResponse>();
  const promptBodies: Array<Record<string, unknown>> = [];
  let formReply: Record<string, unknown> | null = null;
  const sendEvent = (type: string, data: Record<string, unknown>, extra?: Record<string, unknown>) => {
    const payload = {
      id: `evt_${type}_${Date.now()}`,
      created: Date.now(),
      type,
      data,
      ...extra,
    };
    for (const stream of eventStreams) sseWrite(stream, payload);
  };
  const { server, url } = await listen(async (request, response) => {
    const parsed = new URL(request.url ?? "/", url);
    if (request.method === "GET" && parsed.pathname === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "2.0.0-beta-dummy", pid: 1 }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/agent") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "build", name: "Build", mode: "primary" }] }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/model") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "kimi-k3", providerID: "opencode", name: "Kimi K3", enabled: true }],
        })
      );
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "ses_root", agent: "build" } }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/session/ses_root") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "ses_root", agent: "build" } }));
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/session/active") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { ses_root: { type: "idle" } } }));
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session/ses_root/rename") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sseWrite(response, { id: "evt_connected", type: "server.connected", data: {} });
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    if (
      request.method === "GET" &&
      (parsed.pathname === "/api/session/ses_root/log" ||
        parsed.pathname === "/api/experimental/session/ses_root/log")
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      sseWrite(response, { type: "log.synced", aggregateID: "ses_root" });
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session/ses_root/prompt") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      promptBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "msg_user", type: "user" } }));
      setTimeout(() => {
        sendEvent("session.tool.input.started", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          callID: "call_read",
          name: "read",
        });
        sendEvent("session.tool.called", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          callID: "call_read",
          input: { path: "README.md" },
        });
        sendEvent("session.tool.success", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          callID: "call_read",
          content: [{ type: "text", text: "# dummy\n" }],
        });
        sendEvent("session.next.shell.started", {
          timestamp: Date.now(),
          sessionID: "ses_root",
          messageID: "msg_assistant",
          callID: "call_shell",
          command: "pwd",
        });
        sendEvent("session.next.shell.ended", {
          timestamp: Date.now(),
          sessionID: "ses_root",
          callID: "call_shell",
          output: "/workspace\n",
        });
        sendEvent("pty.created", {
          info: { id: "pty_bg", title: "background", command: "sleep 30", cwd: "/workspace" },
        });
        sendEvent("session.text.delta", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          ordinal: 0,
          delta: "v2 ready",
        });
        sendEvent("session.execution.succeeded", { sessionID: "ses_root" });
      }, 15);
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session/ses_root/wait") {
      setTimeout(() => response.writeHead(204).end(), 40);
      return;
    }
    if (request.method === "GET" && parsed.pathname === "/api/session/ses_root/message") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "msg_assistant",
              type: "assistant",
              content: [{ type: "text", text: "v2 ready" }],
            },
          ],
        })
      );
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session/ses_root/interrupt") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && parsed.pathname === "/api/session/ses_root/form/frm_1/reply") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      formReply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const previousUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-v2-"));
  process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = url;
  const conversation = baseConversation("conv-v2", {
    configOptions: withOpenCodeGenerationOption([], "v2-beta"),
  });
  const { callbacks, appended } = await withCallbacks(workspaceRoot, conversation);
  try {
    const provider = createOpenCodeProvider({
      backend: AGENT_BACKENDS["opencode-server"],
      configOptions: withOpenCodeGenerationOption([], "v2-beta"),
    });
    const handle = await provider.startSession(callbacks);
    await handle.prompt({ text: "Inspect the workspace", userMessageId: "user-1" });
    assert.equal(promptBodies[0]?.delivery, "steer");
    assert.ok(
      appended.some(
        (event) =>
          event.kind === "tool_call_update" &&
          event.toolKind === "read" &&
          event.status === "completed"
      )
    );
    assert.ok(
      appended.some(
        (event) =>
          event.kind === "tool_call_update" &&
          event.toolCallId?.includes("opencode-v2-shell") &&
          event.status === "completed"
      )
    );
    assert.ok(
      appended.some(
        (event) => event.kind === "tool_call" && event.toolCallId?.includes("opencode-v2-pty")
      )
    );
    assert.ok(
      appended.some(
        (event) => event.kind === "assistant_message_chunk" && event.text === "v2 ready"
      )
    );
    sendEvent(
      "form.created",
      {
        form: {
          id: "frm_1",
          sessionID: "ses_root",
          title: "Continue?",
          fields: [{ key: "confirm", type: "boolean", title: "Go?" }],
        },
      },
      { location: { directory: workspaceRoot } }
    );
    for (
      let attempt = 0;
      attempt < 50 && callbacks.conversation.pendingQuestion?.questionId !== "frm_1";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(callbacks.conversation.pendingQuestion?.questionId, "frm_1");
    await handle.answerQuestion?.({ questionId: "frm_1", answer: "Go?: Yes" });
    assert.deepEqual(formReply, { answer: { confirm: true } });
    await handle.dispose();
  } finally {
    if (previousUrl == null) delete process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
    else process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = previousUrl;
    for (const stream of eventStreams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
