import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AGENT_BACKENDS, listAgentBackends } from "../src/lib/agents/providers.js";
import {
  OpenCodeV2Client,
  parseOpenCodeV2ModelRef,
} from "../src/lib/agents/opencode-v2-client.js";
import {
  OpenCodeV2EventNormalizer,
  openCodeV2ChildSessionId,
  openCodeV2PermissionReply,
  readOpenCodeV2FormRequest,
  readOpenCodeV2QuestionRequest,
} from "../src/lib/agents/opencode-v2-normalize.js";
import {
  startOpenCodeV2Events,
  startOpenCodeV2SessionLog,
} from "../src/lib/agents/opencode-v2-events.js";
import { buildOpenCodeV2ConfigOptions } from "../src/lib/agents/opencode-v2-provider.js";

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
  assert.equal("toolCallId" in permission[0]! ? permission[0].toolCallId : null, "call_shell");
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
