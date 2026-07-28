import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
} from "../src/lib/agents/types.js";
import { AGENT_CAPABILITIES } from "../src/lib/agents/agent-contract.js";

function writeFakeGrokCli(directory: string): string {
  const executable = path.join(directory, "grok");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("models")) {
  console.log("You are not authenticated.\\n\\nDefault model: grok-4.5\\n\\nAvailable models:\\n  * grok-4.5 (default)\\n  * grok-build");
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
let authenticated = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        authMethods: [
          { id: "xai.api_key", name: "xai.api_key" },
          { id: "grok.com", name: "Grok" }
        ],
        agentCapabilities: { loadSession: true },
        _meta: { defaultAuthMethodId: "xai.api_key", grokShell: true }
      }
    });
    return;
  }
  if (request.method === "authenticate") {
    if (request.params?.methodId !== "xai.api_key" || request.params?._meta?.headless !== true) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "wrong auth handshake" } });
      return;
    }
    authenticated = true;
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (!authenticated) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "authentication required" } });
    return;
  }
  if (request.method === "session/new" || request.method === "session/load") {
    const sessionId = request.params?.sessionId || "grok-session-1";
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId,
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-build", name: "Grok Build" }
          ]
        }
      }
    });
    return;
  }
  if (request.method === "session/set_mode" || request.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from Grok Build." }
        }
      }
    });
    setTimeout(() => {
      send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    }, 20);
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`
  );
  chmodSync(executable, 0o755);
  return executable;
}

function createCallbacks(backend: AgentConversationRecord["config"]["backendId"], root: string) {
  const appended: AgentEventInput[] = [];
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "grok-conversation",
    workspaceId: "grok-workspace",
    title: "Grok Build test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: backend,
      mode: "agent",
      modelId: "grok-4.5",
      modelName: "Grok 4.5",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: AGENT_CAPABILITIES["grok-build"],
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
      id: "grok-workspace",
      root,
      name: "Grok",
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
  return { callbacks, appended, conversation: () => conversation };
}

test("Grok Build auth selection prefers API key, then the CLI default", async () => {
  const { selectGrokBuildAuthMethod } = await import(
    "../src/lib/agents/acp/acp-session.js"
  );
  assert.equal(
    selectGrokBuildAuthMethod({
      authMethodIds: ["xai.api_key", "cached_token"],
      defaultAuthMethodId: "cached_token",
      hasApiKey: true,
    }),
    "xai.api_key"
  );
  assert.equal(
    selectGrokBuildAuthMethod({
      authMethodIds: ["xai.api_key", "cached_token"],
      defaultAuthMethodId: "cached_token",
      hasApiKey: false,
    }),
    "cached_token"
  );
  assert.equal(
    selectGrokBuildAuthMethod({
      authMethodIds: ["grok.com"],
      hasApiKey: false,
    }),
    null
  );
});

test("Grok Build model discovery parses the official CLI output without auth", async () => {
  const directory = path.join(os.tmpdir(), `grok-models-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const executable = writeFakeGrokCli(directory);
  const { createGrokBuildConfigOptions } = await import(
    "../src/lib/agents/provider-cache-store.js"
  );
  const options = await createGrokBuildConfigOptions({ command: executable });
  const mode = options.find((option) => option.category === "mode");
  const model = options.find((option) => option.category === "model");
  assert.equal(mode?.currentValue, "default");
  assert.deepEqual(mode?.options.map((option) => option.value), [
    "default",
    "plan",
    "ask",
  ]);
  assert.equal(model?.currentValue, "grok-4.5");
  assert.deepEqual(model?.options.map((option) => option.value), [
    "grok-4.5",
    "grok-build",
  ]);
});

test("Grok Build provider completes an authenticated ACP turn and resumes", async () => {
  const directory = path.join(os.tmpdir(), `grok-acp-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const executable = writeFakeGrokCli(directory);
  const previousBin = process.env.OPENCURSOR_GROK_BUILD_BIN;
  const previousArgs = process.env.OPENCURSOR_GROK_BUILD_ARGS;
  const previousApiKey = process.env.XAI_API_KEY;
  process.env.OPENCURSOR_GROK_BUILD_BIN = executable;
  delete process.env.OPENCURSOR_GROK_BUILD_ARGS;
  process.env.XAI_API_KEY = "xai-test";

  try {
    const cacheBust = `?grok-bin=${Date.now()}`;
    const { AGENT_BACKENDS, createAgentProvider, listAgentBackends } = await import(
      `../src/lib/agents/providers.js${cacheBust}`
    );
    assert.ok(listAgentBackends().some((backend) => backend.id === "grok-build"));
    assert.equal(AGENT_BACKENDS["grok-build"].available, true);
    assert.match(
      AGENT_BACKENDS["grok-build"].commandPreview ?? "",
      /--no-auto-update agent stdio/
    );

    const provider = await createAgentProvider("grok-build");
    const first = createCallbacks("grok-build", directory);
    const handle = await provider.startSession(first.callbacks);
    assert.equal(handle.sessionId, "grok-session-1");
    assert.equal(first.conversation().providerSessionId, "grok-session-1");
    assert.ok(handle.configOptions.some((option) => option.category === "model"));
    assert.ok(handle.configOptions.some((option) => option.category === "mode"));
    await handle.prompt({ text: "Say hello", userMessageId: "user-1" });
    assert.ok(
      first.appended.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          event.text === "Hello from Grok Build."
      )
    );
    assert.ok(
      first.appended.some(
        (event) =>
          event.kind === "assistant_message_end" &&
          event.stopReason === "end_turn"
      )
    );
    await handle.dispose();

    const resumed = createCallbacks("grok-build", directory);
    const resumedHandle = await provider.loadSession(
      resumed.callbacks,
      "grok-session-resumed"
    );
    assert.equal(resumedHandle.sessionId, "grok-session-resumed");
    assert.equal(
      resumed.conversation().providerSessionId,
      "grok-session-resumed"
    );
    await resumedHandle.dispose();
  } finally {
    if (previousBin === undefined) delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    else process.env.OPENCURSOR_GROK_BUILD_BIN = previousBin;
    if (previousArgs === undefined) delete process.env.OPENCURSOR_GROK_BUILD_ARGS;
    else process.env.OPENCURSOR_GROK_BUILD_ARGS = previousArgs;
    if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousApiKey;
  }
});
