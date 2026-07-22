import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AGENT_BACKENDS, listAgentBackends } from "../src/lib/agents/providers.js";
import {
  OpenCodeV2Client,
  parseOpenCodeV2ModelRef,
} from "../src/lib/agents/opencode-v2-client.js";
import {
  OpenCodeV2EventNormalizer,
  openCodeV2ChildSessionId,
  openCodeV2EventSessionId,
  openCodeV2PermissionReply,
  readOpenCodeV2FormRequest,
  readOpenCodeV2QuestionRequest,
} from "../src/lib/agents/opencode-v2-normalize.js";
import {
  startOpenCodeV2Events,
  startOpenCodeV2SessionLog,
} from "../src/lib/agents/opencode-v2-events.js";
import { buildOpenCodeV2ConfigOptions } from "../src/lib/agents/opencode-v2-config.js";
import { createOpenCodeV2Provider } from "../src/lib/agents/opencode-v2-provider.js";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
} from "../src/lib/agents/types.js";

test("OpenCode v2 Beta is a separate registered harness", () => {
  const ids = listAgentBackends().map((backend) => backend.id);
  assert.ok(ids.includes("opencode-server"));
  assert.ok(ids.includes("opencode-v2-beta"));
  assert.equal(AGENT_BACKENDS["opencode-v2-beta"].label, "OpenCode v2 Beta");
  assert.equal(AGENT_BACKENDS["opencode-v2-beta"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_BACKENDS["opencode-v2-beta"].capabilities.supportsTodos, false);
});

test("OpenCode v2 model references preserve provider, model, and variant", () => {
  assert.deepEqual(parseOpenCodeV2ModelRef("anthropic/claude-opus#high"), {
    providerID: "anthropic",
    id: "claude-opus",
    variant: "high",
  });
  assert.equal(parseOpenCodeV2ModelRef("auto"), undefined);
  assert.equal(parseOpenCodeV2ModelRef("missing-provider"), undefined);
});

test("OpenCode v2 catalogs expose primary agents and model variants", () => {
  const options = buildOpenCodeV2ConfigOptions({
    agents: [
      { id: "build", name: "Build", mode: "primary", hidden: false },
      { id: "research", name: "Research", mode: "subagent", hidden: false },
    ],
    models: [
      {
        id: "model-a",
        providerID: "provider-a",
        name: "Model A",
        enabled: true,
        variants: [{ id: "high" }],
      },
    ],
    currentAgent: "build",
    currentModel: "provider-a/model-a#high",
  });
  assert.deepEqual(options[0]?.options.map((option) => option.value), ["build"]);
  assert.deepEqual(options[1]?.options.map((option) => option.value), [
    "provider-a/model-a",
    "provider-a/model-a#high",
  ]);
  assert.equal(options[1]?.currentValue, "provider-a/model-a#high");
  const partialRefresh = buildOpenCodeV2ConfigOptions({
    agents: [],
    models: [
      {
        id: "model-b",
        providerID: "provider-b",
        name: "Model B",
        enabled: true,
        variants: [],
      },
    ],
    previous: options,
  });
  assert.deepEqual(partialRefresh[0]?.options.map((option) => option.value), ["build"]);
  assert.deepEqual(partialRefresh[1]?.options.map((option) => option.value), [
    "provider-b/model-b",
  ]);
});

test("OpenCode v2 normalizes typed text, shell, subagent, and permission events", () => {
  const normalizer = new OpenCodeV2EventNormalizer();
  const common = {
    conversationId: "conv",
    rootSessionId: "ses_root",
    rootMessageId: "msg_root",
  };
  const delta = normalizer.normalize({
    ...common,
    payload: {
      type: "session.text.delta",
      data: {
        sessionID: "ses_root",
        assistantMessageID: "msg_upstream",
        ordinal: 0,
        delta: "hello",
      },
    },
  });
  const ended = normalizer.normalize({
    ...common,
    payload: {
      type: "session.text.ended",
      data: {
        sessionID: "ses_root",
        assistantMessageID: "msg_upstream",
        ordinal: 0,
        text: "hello world",
      },
    },
  });
  assert.equal(delta[0]?.kind, "assistant_message_chunk");
  assert.equal("text" in delta[0]! ? delta[0].text : null, "hello");
  assert.equal("text" in ended[0]! ? ended[0].text : null, " world");

  const started = normalizer.normalize({
    ...common,
    childSessionId: "ses_child",
    payload: {
      type: "session.tool.input.started",
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        callID: "call_shell",
        name: "shell",
      },
    },
  });
  normalizer.normalize({
    ...common,
    childSessionId: "ses_child",
    payload: {
      type: "session.tool.input.ended",
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        callID: "call_shell",
        text: JSON.stringify({ command: "pwd" }),
      },
    },
  });
  const success = normalizer.normalize({
    ...common,
    childSessionId: "ses_child",
    payload: {
      type: "session.tool.success",
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        callID: "call_shell",
        structured: {},
        content: [{ type: "text", text: "/workspace\n" }],
        executed: true,
      },
    },
  });
  assert.equal(started[0]?.kind, "tool_call");
  assert.equal("toolKind" in started[0]! ? started[0].toolKind : null, "terminal");
  assert.equal(success[0]?.kind, "tool_call_update");
  assert.equal(
    "openCodeSubagentSessionId" in success[0]!
      ? success[0].openCodeSubagentSessionId
      : null,
    "ses_child"
  );

  const spawn = {
    type: "session.tool.progress",
    data: {
      sessionID: "ses_root",
      assistantMessageID: "msg_root",
      callID: "call_subagent",
      structured: { sessionID: "ses_child", status: "running" },
      content: [],
    },
  };
  assert.equal(openCodeV2ChildSessionId(spawn), "ses_child");
  assert.equal(
    openCodeV2EventSessionId({
      type: "session.test",
      data: { session: { id: "ses_nested" } },
    }),
    "ses_nested"
  );
  assert.equal(
    openCodeV2EventSessionId({
      type: "session.test",
      durable: { aggregateID: "ses_durable", seq: 1, version: 1 },
      data: {},
    }),
    "ses_durable"
  );

  const permission = normalizer.normalize({
    ...common,
    payload: {
      type: "permission.v2.asked",
      data: {
        id: "per_1",
        sessionID: "ses_child",
        action: "shell",
        resources: ["npm test"],
        source: { type: "tool", messageID: "msg_child", callID: "call_shell" },
      },
    },
  });
  assert.equal(permission[0]?.kind, "permission_request");
  assert.equal(
    "toolCallId" in permission[0]! ? permission[0].toolCallId : null,
    "opencode-v2:ses_child:call_shell"
  );
  assert.equal(openCodeV2PermissionReply("allow_always"), "always");
  assert.equal(openCodeV2PermissionReply("deny"), "reject");
});

test("OpenCode v2 recognizes native question and form requests", () => {
  const question = readOpenCodeV2QuestionRequest({
    type: "question.v2.asked",
    data: {
      id: "que_1",
      sessionID: "ses_root",
      questions: [
        {
          question: "Choose a target",
          header: "Target",
          options: [{ label: "Web", description: "Browser" }],
          multiple: false,
        },
      ],
    },
  });
  assert.equal(question?.questions[0]?.options[0]?.label, "Web");

  const form = readOpenCodeV2FormRequest({
    type: "form.created",
    data: {
      form: {
        id: "frm_1",
        sessionID: "ses_root",
        title: "Deploy",
        fields: [
          { key: "confirm", type: "boolean", title: "Continue?" },
          { key: "region", type: "string", options: [{ value: "iad", label: "Virginia" }] },
        ],
      },
    },
  });
  assert.deepEqual(form?.fields.map((field) => field.key), ["confirm", "region"]);
});

test("OpenCode v2 SSE waits for connection and skips existing durable history", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`
      );
      return;
    }
    if (request.url?.startsWith("/api/experimental/session/ses_root/log")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "evt_old",
          type: "session.execution.started",
          durable: { aggregateID: "ses_root", seq: 0, version: 1 },
          data: { sessionID: "ses_root" },
        })}\n\n`
      );
      response.write(`data: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_root", seq: 0 })}\n\n`);
      response.write(
        `data: ${JSON.stringify({
          id: "evt_new",
          type: "session.execution.succeeded",
          durable: { aggregateID: "ses_root", seq: 1, version: 1 },
          data: { sessionID: "ses_root" },
        })}\n\n`
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const client = new OpenCodeV2Client({ baseUrl: `http://127.0.0.1:${address.port}` });
  const events = startOpenCodeV2Events({ client, onEvent: () => undefined });
  await events.ready;

  const received: string[] = [];
  let log: ReturnType<typeof startOpenCodeV2SessionLog>;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for durable event.")), 2_000);
    log = startOpenCodeV2SessionLog({
      client,
      sessionId: "ses_root",
      replayExisting: false,
      onEvent: (event) => {
        received.push(String(event.id));
        clearTimeout(timeout);
        resolve();
      },
    });
  });
  assert.deepEqual(received, ["evt_new"]);
  events.close();
  log!.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("OpenCode v2 provider completes a native typed tool and text turn", async () => {
  const eventStreams = new Set<import("node:http").ServerResponse>();
  let nextEventId = 0;
  const promptBodies: Record<string, unknown>[] = [];
  let formReply: {
    body: Record<string, unknown>;
    directory?: string;
  } | null = null;
  const sendEvent = (
    type: string,
    data: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    const frame = `data: ${JSON.stringify({
      id: `evt_provider_${nextEventId++}`,
      created: Date.now(),
      type,
      data,
      ...extra,
    })}\n\n`;
    for (const stream of eventStreams) stream.write(frame);
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "v2-test", pid: process.pid }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agent") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          location: { directory: "/workspace", project: { id: "project", directory: "/workspace" } },
          data: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
        })
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/model") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          location: { directory: "/workspace", project: { id: "project", directory: "/workspace" } },
          data: [
            {
              id: "model",
              providerID: "test",
              name: "Test Model",
              enabled: true,
              variants: [],
            },
          ],
        })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            id: "ses_root",
            agent: "build",
            model: { providerID: "test", id: "model" },
          },
        })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/ses_root/rename") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "evt_provider_connected",
          created: Date.now(),
          type: "server.connected",
          data: {},
        })}\n\n`
      );
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/experimental/session/ses_root/log"
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_root" })}\n\n`
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/ses_root/prompt") {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
      promptBodies.push(
        JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as Record<string, unknown>
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: { id: "msg_user", sessionID: "ses_root", type: "user" },
        })
      );
      if (promptBodies.length === 1) setTimeout(() => {
        const base = {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          callID: "call_shell",
        };
        sendEvent("session.tool.input.started", { ...base, name: "shell" });
        sendEvent("session.tool.input.ended", {
          ...base,
          text: JSON.stringify({ command: "pwd" }),
        });
        sendEvent("session.tool.called", {
          ...base,
          input: { command: "pwd" },
          executed: true,
        });
        sendEvent("session.tool.success", {
          ...base,
          structured: {},
          content: [{ type: "text", text: "/workspace\n" }],
          executed: true,
        });
        sendEvent("session.text.delta", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          ordinal: 0,
          delta: "done",
        });
        sendEvent("session.text.ended", {
          sessionID: "ses_root",
          assistantMessageID: "msg_assistant",
          ordinal: 0,
          text: "done",
        });
        sendEvent("session.execution.succeeded", { sessionID: "ses_root" });
      }, 10);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/ses_root/wait") {
      if (promptBodies.length === 1) {
        setTimeout(() => response.writeHead(500).end("transient wait failure"), 5);
      } else {
        setTimeout(() => response.writeHead(204).end(), 5);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session/ses_root/message") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "msg_projected",
              type: "assistant",
              content: [{ type: "text", text: "reconciled" }],
            },
          ],
          cursor: {},
        })
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/ses_root/interrupt") {
      response.writeHead(204).end();
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/session/global/form/frm_global/reply"
    ) {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
      formReply = {
        body: JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as Record<string, unknown>,
        directory: request.headers["x-opencode-directory"] as string | undefined,
      };
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previousUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-v2-provider-"));
  process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = `http://127.0.0.1:${address.port}`;
  const appended: AgentEventInput[] = [];
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "conv-v2",
    workspaceId: "workspace-v2",
    title: "V2 provider test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "opencode-v2-beta",
      mode: "build",
      modelId: "test/model",
      modelName: "Test Model",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: AGENT_BACKENDS["opencode-v2-beta"].capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "workspace-v2",
      root: workspaceRoot,
      name: "V2",
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
  try {
    const provider = createOpenCodeV2Provider({
      backend: AGENT_BACKENDS["opencode-v2-beta"],
      configOptions: [],
    });
    const handle = await provider.startSession(callbacks);
    await handle.prompt({ text: "Run pwd", userMessageId: "user-1" });
    assert.equal(promptBodies[0]?.id, "msg_cesium_user-1");
    assert.equal(promptBodies[0]?.delivery, "steer");
    assert.equal(conversation.providerSessionId, "ses_root");
    assert.equal(conversation.status, "idle");
    assert.ok(
      appended.some(
        (event) =>
          event.kind === "tool_call_update" &&
          event.toolKind === "terminal" &&
          event.status === "completed"
      )
    );
    assert.equal(
      appended
        .filter((event) => event.kind === "assistant_message_chunk")
        .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""))
        .join(""),
      "done"
    );
    assert.ok(appended.some((event) => event.kind === "assistant_message_end"));
    await handle.prompt({ text: "Reconcile me", userMessageId: "user-2" });
    assert.equal(promptBodies[1]?.id, "msg_cesium_user-2");
    assert.ok(
      appended.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          event.messageId === "opencode-v2-user-2" &&
          event.text === "reconciled"
      )
    );
    sendEvent(
      "form.created",
      {
        form: {
          id: "frm_global",
          sessionID: "global",
          title: "MCP confirmation",
          fields: [{ key: "confirm", type: "boolean", title: "Continue?" }],
        },
      },
      { location: { directory: workspaceRoot } }
    );
    for (let attempt = 0; attempt < 50 && conversation.pendingQuestion?.questionId !== "frm_global"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(conversation.pendingQuestion?.questionId, "frm_global");
    await handle.answerQuestion?.({
      questionId: "frm_global",
      answer: "Continue?: Yes",
    });
    assert.deepEqual(formReply?.body, { answer: { confirm: true } });
    assert.equal(formReply?.directory, encodeURIComponent(workspaceRoot));
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
