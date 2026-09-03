import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
} from "../src/lib/agents/types.js";
import { AGENT_CAPABILITIES } from "../src/lib/agents/agent-contract.js";

const TEST_ROOT = path.join(os.tmpdir(), `antigravity-acp-${process.pid}-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });
process.env.OPENCURSOR_DATA_DIR = path.join(TEST_ROOT, "data");

/**
 * Fake `agy_acp_server` replaying the contract recorded from the real 1.1.1
 * build: protocol echo, four auth methods, `-32000` before `authenticate`,
 * `session/new` with modes + model catalog, `available_commands_update`,
 * `session/resume`, `-32002` for a foreign session id, thought chunks, and the
 * prose-shaped execution error. Method calls are journaled to
 * `$GEMINI_HOME/calls.log` so tests can assert which ACP methods were used.
 */
function writeFakeAcpServer(directory: string): string {
  const executable = path.join(directory, "agy_acp_server.par");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  process.stderr.write("Built from changelist 975248206 in a mint client based on //depot/branches/agy_acp_server_release_branch/973763860.1/google3\\nBuild label: agy_acp_server_1.1.1\\nCurrently running under Python 3.14.5\\n");
  process.exit(0);
}
const home = process.env.GEMINI_HOME || path.join(process.env.HOME || "/tmp", ".gemini");
const stateDir = path.join(home, "antigravity-acp");
fs.mkdirSync(stateDir, { recursive: true });
const settingsPath = path.join(stateDir, "settings.json");
const journal = path.join(home, "calls.log");
const log = (method) => fs.appendFileSync(journal, method + "\\n");
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { return null; } };
let authenticated = Boolean(readSettings()?.auth?.type);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const modes = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Default permission prompt flow" },
    { id: "auto_edit", name: "Auto Edit", description: "Auto-approve file edit tools" },
    { id: "yolo", name: "YOLO", description: "Auto-approve all tools" }
  ]
};
let currentModel = "gemini-3.7-flash-high";
const modelOptions = [
  { value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", description: "Gemini 3.7 Flash model with high thinking level" },
  { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", description: "Gemini 3.1 Pro model with high thinking level" }
];
const configOptions = () => [
  { currentValue: currentModel, options: modelOptions, id: "model", name: "Model", category: "model", type: "select" },
  { currentValue: modes.currentModeId, options: modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })), id: "mode", name: "Session Mode", category: "mode", type: "select" }
];
const sessionBody = (extra) => ({
  ...extra,
  modes,
  configOptions: configOptions(),
  models: { availableModels: modelOptions.map((m) => ({ modelId: m.value, name: m.name, description: m.description })), currentModelId: currentModel }
});
const commandsUpdate = (sessionId) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: { availableCommands: [
    { name: "plan", description: "Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval)." },
    { name: "logout", description: "Log out and clear stored credentials." }
  ], sessionUpdate: "available_commands_update" } }
});
const authError = (id) => send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required", data: { message: "No authentication method selected. Either call the authenticate method (supports oauth-personal, gemini-api-key, agent-platform), or set auth.type in settings.json (" + settingsPath + ")." } } });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  log(request.method);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params?.protocolVersion ?? 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
        { id: "oauth-business", name: "Log in with Gemini Enterprise", description: "Log in with your Gemini Enterprise account" },
        { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
        { id: "agent-platform", name: "Gemini Enterprise Agent Platform", description: "Use Gemini Enterprise Agent Platform" }
      ],
      agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "agy_acp_server_1.1.1" }
    } });
    return;
  }
  if (request.method === "authenticate") {
    const methodId = request.params?.methodId;
    if (methodId === "gemini-api-key") {
      if (!process.env.GEMINI_API_KEY) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "The GEMINI_API_KEY environment variable must be set in the environment the ACP server is launched from for Gemini API Key authentication.", data: null } });
        return;
      }
      authenticated = true;
      fs.writeFileSync(settingsPath, JSON.stringify({ auth: { type: "gemini-api-key" } }, null, 2));
      send({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (methodId === "oauth-personal") {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        res.end("ok");
        if (url.searchParams.get("code")) {
          authenticated = true;
          fs.writeFileSync(settingsPath, JSON.stringify({ auth: { type: "oauth-personal" } }, null, 2));
          fs.writeFileSync(path.join(stateDir, "oauth_creds.json"), JSON.stringify({ access_token: "fake", code: url.searchParams.get("code") }));
          send({ jsonrpc: "2.0", id: request.id, result: {} });
          server.close();
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        process.stderr.write("I0903 03:15:53.630081 3885 credential_manager.py:553] Credentials missing or invalid. Launching browser login flow...\\n");
        process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fake.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A" + port + "%2F&scope=openid\\n");
      });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unsupported method in fake" } });
    return;
  }
  if (request.method === "logout") {
    authenticated = false;
    try { fs.unlinkSync(path.join(stateDir, "oauth_creds.json")); } catch {}
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "session/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessions: [] } });
    return;
  }
  if (!authenticated && (request.method === "session/new" || request.method === "session/resume" || request.method === "session/load")) {
    authError(request.id);
    return;
  }
  if (request.method === "session/new") {
    const sessionId = "19cf1bf6-01c5-4a8c-895f-3b7bef714edb";
    send({ jsonrpc: "2.0", id: request.id, result: sessionBody({ sessionId }) });
    commandsUpdate(sessionId);
    return;
  }
  if (request.method === "session/resume" || request.method === "session/load") {
    const sessionId = request.params?.sessionId;
    if (sessionId === "missing-session") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Session not found in the current GEMINI_HOME", data: { sessionId, geminiHome: home } } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: sessionBody({}) });
    commandsUpdate(sessionId);
    return;
  }
  if (request.method === "session/set_mode") {
    modes.currentModeId = request.params?.modeId ?? modes.currentModeId;
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "session/set_config_option") {
    if (request.params?.configId === "model") currentModel = request.params.value;
    if (request.params?.configId === "mode") modes.currentModeId = request.params.value;
    send({ jsonrpc: "2.0", id: request.id, result: { configOptions: configOptions() } });
    return;
  }
  if (request.method === "session/prompt") {
    const sessionId = request.params.sessionId;
    const text = (request.params.prompt || []).map((p) => p.text || "").join(" ");
    if (/fail/i.test(text)) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { content: { text: "Agent execution error: Agent execution terminated due to error. (\\"request failed (code 400): API key not valid. Please pass a valid API key.\\")", type: "text" }, sessionUpdate: "agent_message_chunk" } } });
      setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }), 20);
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { content: { text: "Considering the request.", type: "text" }, sessionUpdate: "agent_thought_chunk" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { content: { text: "PONG", type: "text" }, sessionUpdate: "agent_message_chunk" } } });
    setTimeout(() => send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } }), 20);
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
`
  );
  chmodSync(executable, 0o755);
  return executable;
}

function createCallbacks(root: string) {
  const appended: AgentEventInput[] = [];
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "antigravity-conversation",
    workspaceId: "antigravity-workspace",
    title: "Antigravity ACP test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "google-antigravity-acp",
      mode: "default",
      modelId: "gemini-3.7-flash-high",
      modelName: "Gemini 3.7 Flash (High)",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: AGENT_CAPABILITIES["google-antigravity-acp"],
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
      id: "antigravity-workspace",
      root,
      name: "Antigravity",
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

type EnvSnapshot = Record<string, string | undefined>;
const MANAGED_ENV = [
  "OPENCURSOR_ANTIGRAVITY_ACP_BIN",
  "OPENCURSOR_ANTIGRAVITY_ACP_ARGS",
  "OPENCURSOR_ANTIGRAVITY_ACP_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_HOME",
  "XDG_DATA_HOME",
  "PATH",
];
function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
}
async function restoreEnv(snapshot: EnvSnapshot): Promise<void> {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const { resetHarnessRuntimeCachesForTest } = await import("../src/lib/agents/harness-runtime.js");
  resetHarnessRuntimeCachesForTest();
}

function tempDir(label: string): string {
  const dir = path.join(TEST_ROOT, `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("backend-specific helpers parse versions, sign-in URLs, and execution errors", async () => {
  const mod = await import("../src/lib/agents/google-antigravity-acp.js");
  assert.equal(
    mod.parseAntigravityAcpVersion(
      "Built from //depot/branches/agy_acp_server_release_branch/973763860.1/google3\nBuild label: agy_acp_server_1.1.1\nPython 3.14.5"
    ),
    "1.1.1"
  );
  assert.equal(mod.parseAntigravityAcpVersion("agy_acp_server_20260818_01_RC01"), "20260818_01_RC01");
  assert.equal(mod.parseAntigravityAcpVersion("nothing here"), null);
  assert.equal(
    mod.extractAntigravityAcpSignInUrl(
      "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A59665%2F"
    ),
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A59665%2F"
  );
  assert.equal(mod.extractAntigravityAcpSignInUrl("I0903 main.py:80] Starting AGY ACP Server..."), null);
  assert.equal(
    mod.extractAcpAgentExecutionError(
      'Agent execution error: Agent execution terminated due to error. ("request failed (code 400): API key not valid.")'
    ),
    'Agent execution terminated due to error. ("request failed (code 400): API key not valid.")'
  );
  assert.equal(mod.extractAcpAgentExecutionError("Here is your answer."), null);
  const seeds = mod.createGoogleAntigravityAcpConfigOptions();
  assert.deepEqual(
    seeds.find((option) => option.category === "mode")?.options.map((option) => option.value),
    ["default", "auto_edit", "yolo"]
  );
  assert.equal(seeds.find((option) => option.category === "model")?.currentValue, "gemini-3.7-flash-high");
});

test("settings.json merge-writes auth.type and gcp fields; credential state follows it", async () => {
  const env = snapshotEnv();
  try {
    const home = tempDir("home-settings");
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_HOME = home;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const mod = await import("../src/lib/agents/google-antigravity-acp.js");
    assert.equal(mod.resolveAntigravityAcpGeminiHome(), path.resolve(home));
    let state = await mod.detectAntigravityAcpCredentialState();
    assert.equal(state.configuredAuthType, null);
    assert.equal(state.signedIn, false);

    mkdirSync(mod.antigravityAcpStateDir(), { recursive: true });
    writeFileSync(
      mod.antigravityAcpSettingsPath(),
      JSON.stringify({ auth: { type: "oauth-personal" }, telemetry: { enabled: false } }, null, 2)
    );
    await mod.writeAntigravityAcpSettings({ gcpProject: "proj-1", gcpLocation: "us-central1" });
    const written = JSON.parse(readFileSync(mod.antigravityAcpSettingsPath(), "utf8"));
    assert.deepEqual(written, {
      auth: { type: "oauth-personal" },
      telemetry: { enabled: false },
      gcp: { project: "proj-1", location: "us-central1" },
    });
    state = await mod.detectAntigravityAcpCredentialState();
    assert.equal(state.configuredAuthType, "oauth-personal");
    // OAuth configured but no credential file yet -> unverified, not signed in.
    assert.equal(state.signedIn, null);
    assert.equal(state.gcpConfigured, true);
    writeFileSync(path.join(mod.antigravityAcpStateDir(), "oauth_creds.json"), "{}");
    state = await mod.detectAntigravityAcpCredentialState();
    assert.equal(state.signedIn, true);

    await mod.writeAntigravityAcpSettings({ authType: "gemini-api-key" });
    state = await mod.detectAntigravityAcpCredentialState();
    assert.equal(state.configuredAuthType, "gemini-api-key");
    assert.equal(state.signedIn, false, "api-key method without a key is not signed in");
    process.env.GEMINI_API_KEY = "test-key";
    state = await mod.detectAntigravityAcpCredentialState();
    assert.equal(state.signedIn, true);
    const spawnEnv = await mod.buildAntigravityAcpSpawnEnv({ ...process.env });
    assert.equal(spawnEnv.GEMINI_HOME, path.resolve(home));
    assert.equal(spawnEnv.GEMINI_API_KEY, "test-key");
  } finally {
    await restoreEnv(env);
  }
});

test("descriptor resolves the ACP server via env override, Zed registry dirs, and parses its version", async () => {
  const env = snapshotEnv();
  try {
    const rt = await import("../src/lib/agents/harness-runtime.js");
    const binDir = tempDir("bin");
    const executable = writeFakeAcpServer(binDir);
    // The fake is a `#!/usr/bin/env node` script, so PATH must stay intact;
    // the temp dir is simply not on it.
    delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN;
    delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_ARGS;
    process.env.XDG_DATA_HOME = tempDir("xdg-empty");
    rt.resetHarnessRuntimeCachesForTest();
    assert.equal(rt.detectHarnessCli("google-antigravity-acp"), null);

    process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN = executable;
    rt.resetHarnessRuntimeCachesForTest();
    const detection = rt.detectHarnessCli("google-antigravity-acp");
    assert.equal(detection?.executablePath, executable);
    assert.equal(detection?.source, "env");
    const spec = rt.resolveHarnessRuntimeSpec("google-antigravity-acp");
    assert.ok(spec);
    assert.deepEqual(spec.args, process.platform === "linux" ? ["--uid="] : []);
    assert.equal(await rt.probeHarnessCliVersion("google-antigravity-acp"), "1.1.1");

    // Zed's registry layout: <XDG_DATA_HOME>/zed/external_agents/registry/antigravity-acp/<version>/
    delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN;
    const xdg = tempDir("xdg");
    process.env.XDG_DATA_HOME = xdg;
    const zedDir = path.join(xdg, "zed", "external_agents", "registry", "antigravity-acp", "v_1.1.1_abc");
    mkdirSync(zedDir, { recursive: true });
    writeFakeAcpServer(zedDir);
    rt.resetHarnessRuntimeCachesForTest();
    const zedDetection = rt.detectHarnessCli("google-antigravity-acp");
    assert.equal(zedDetection?.source, "well-known");
    assert.equal(zedDetection?.executablePath, path.join(zedDir, "agy_acp_server.par"));
    assert.deepEqual(rt.zedExternalAgentRegistryDirs("antigravity-acp")[0], path.join(xdg, "zed", "external_agents", "registry", "antigravity-acp"));
  } finally {
    await restoreEnv(env);
  }
});

test("harness auth spec exposes the ACP methods and rejects the relay without an active login", async () => {
  const auth = await import("../src/lib/harness-cli-auth.js");
  assert.equal(auth.isHarnessCliAuthBackendId("google-antigravity-acp"), true);
  const state = auth.getHarnessCliAuthState("google-antigravity-acp");
  assert.deepEqual(
    state.authMethods?.map((method) => method.id),
    ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]
  );
  assert.equal(state.authMethods?.[0]?.browserLogin, true);
  assert.equal(state.authMethods?.[2]?.apiKeyEnvVar, "GEMINI_API_KEY");
  await assert.rejects(
    auth.relayHarnessCliOAuthCallback("google-antigravity-acp", "http://127.0.0.1:1234/?code=x"),
    /No Google sign-in is waiting/
  );
  await assert.rejects(
    auth.relayHarnessCliOAuthCallback("codex-acp", "http://127.0.0.1:1234/?code=x"),
    /does not use a loopback OAuth callback/
  );
});

test("provider authenticates with GEMINI_API_KEY, streams thoughts + commands, resumes without replay", async () => {
  const env = snapshotEnv();
  try {
    const binDir = tempDir("bin-provider");
    const executable = writeFakeAcpServer(binDir);
    const home = tempDir("home-provider");
    const workspaceRoot = tempDir("ws-provider");
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN = executable;
    delete process.env.OPENCURSOR_ANTIGRAVITY_ACP_ARGS;
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_HOME = home;
    process.env.GEMINI_API_KEY = "AIza-test-key";
    const rt = await import("../src/lib/agents/harness-runtime.js");
    rt.resetHarnessRuntimeCachesForTest();

    const { AGENT_BACKENDS, createAgentProvider, listAgentBackends } = await import(
      `../src/lib/agents/providers.js?antigravity=${Date.now()}`
    );
    assert.ok(listAgentBackends().some((backend) => backend.id === "google-antigravity-acp"));
    const info = AGENT_BACKENDS["google-antigravity-acp"];
    assert.equal(info.available, true);
    assert.equal(info.label, "Google Antigravity");
    assert.equal(info.defaultModelId, "gemini-3.7-flash-high");
    assert.match(info.commandPreview ?? "", /agy_acp_server\.par/);

    const provider = await createAgentProvider("google-antigravity-acp");
    const first = createCallbacks(workspaceRoot);
    const handle = await provider.startSession(first.callbacks);
    try {
      assert.equal(handle.sessionId, "19cf1bf6-01c5-4a8c-895f-3b7bef714edb");
      assert.equal(first.conversation().providerSessionId, handle.sessionId);
      const modeOption = handle.configOptions.find((option) => option.category === "mode");
      assert.deepEqual(modeOption?.options.map((option) => option.value), ["default", "auto_edit", "yolo"]);
      assert.ok(handle.configOptions.some((option) => option.category === "model" && option.currentValue === "gemini-3.7-flash-high"));
      assert.ok(
        first.appended.some(
          (event) => event.kind === "system" && /authenticated with the Gemini API key/i.test(event.text)
        ),
        "bootstrap should report the headless API-key authentication"
      );
      // The server wrote auth.type itself (mirrors the real build) and Cesium's
      // detection agrees.
      const settings = JSON.parse(readFileSync(path.join(home, "antigravity-acp", "settings.json"), "utf8"));
      assert.equal(settings.auth.type, "gemini-api-key");

      // Wait for the async available_commands_update to land on the record.
      for (let i = 0; i < 50 && !first.conversation().availableCommands?.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(
        first.conversation().availableCommands?.map((command) => command.name),
        ["plan", "logout"]
      );

      await handle.prompt({ text: "Reply with PONG", userMessageId: "user-1" });
      assert.ok(
        first.appended.some((event) => event.kind === "reasoning" && event.text === "Considering the request."),
        "agent_thought_chunk should become a reasoning event"
      );
      assert.ok(first.appended.some((event) => event.kind === "assistant_message_chunk" && event.text === "PONG"));
      assert.ok(first.appended.some((event) => event.kind === "assistant_message_end" && event.stopReason === "end_turn"));
      assert.equal(first.conversation().status, "idle");

      await handle.prompt({ text: "please fail", userMessageId: "user-2" });
      assert.equal(first.conversation().status, "failed");
      assert.match(first.conversation().lastError ?? "", /API key not valid/);
      assert.ok(
        first.appended.some((event) => event.kind === "system" && event.level === "error" && /Agent execution error/.test(event.text))
      );
      assert.ok(
        !first.appended.some((event) => event.kind === "assistant_message_chunk" && /Agent execution error/.test(event.text)),
        "execution errors must not render as assistant prose"
      );
    } finally {
      await handle.dispose();
    }

    const resumed = createCallbacks(workspaceRoot);
    const resumedHandle = await provider.loadSession(resumed.callbacks, "19cf1bf6-01c5-4a8c-895f-3b7bef714edb");
    try {
      assert.equal(resumedHandle.sessionId, "19cf1bf6-01c5-4a8c-895f-3b7bef714edb");
      const journal = readFileSync(path.join(home, "calls.log"), "utf8").split("\n");
      assert.ok(journal.includes("session/resume"), "resume should be preferred for this backend");
      assert.ok(!journal.includes("session/load"), "no replaying session/load when resume exists");
    } finally {
      await resumedHandle.dispose();
    }

    const missing = createCallbacks(workspaceRoot);
    const { isAntigravityAcpSessionNotFoundError } = await import(
      "../src/lib/agents/google-antigravity-acp.js"
    );
    await assert.rejects(
      provider.loadSession(missing.callbacks, "missing-session"),
      (error: unknown) => isAntigravityAcpSessionNotFoundError(error)
    );
  } finally {
    await restoreEnv(env);
  }
});

test("provider surfaces the server's -32000 as a not-signed-in error when nothing is configured", async () => {
  const env = snapshotEnv();
  try {
    const binDir = tempDir("bin-noauth");
    const executable = writeFakeAcpServer(binDir);
    const home = tempDir("home-noauth");
    const workspaceRoot = tempDir("ws-noauth");
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN = executable;
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_HOME = home;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const rt = await import("../src/lib/agents/harness-runtime.js");
    rt.resetHarnessRuntimeCachesForTest();
    const { createAgentProvider } = await import(`../src/lib/agents/providers.js?antigravity-noauth=${Date.now()}`);
    const provider = await createAgentProvider("google-antigravity-acp");
    const ctx = createCallbacks(workspaceRoot);
    await assert.rejects(provider.startSession(ctx.callbacks), /not signed in/i);
    assert.ok(
      ctx.appended.some(
        (event) => event.kind === "system" && event.level === "error" && /Log in with Google/.test(event.text)
      )
    );
    assert.ok(
      ctx.appended.some((event) => event.kind === "system" && /not signed in yet/i.test(event.text)),
      "bootstrap should explain where to sign in"
    );
  } finally {
    await restoreEnv(env);
  }
});

test("ACP auth flow: API-key login succeeds headlessly and Google OAuth completes via the callback relay", async () => {
  const env = snapshotEnv();
  try {
    const binDir = tempDir("bin-auth");
    const executable = writeFakeAcpServer(binDir);
    const home = tempDir("home-auth");
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_BIN = executable;
    process.env.OPENCURSOR_ANTIGRAVITY_ACP_HOME = home;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const rt = await import("../src/lib/agents/harness-runtime.js");
    rt.resetHarnessRuntimeCachesForTest();
    const auth = await import("../src/lib/agents/google-antigravity-acp-auth.js");
    auth.resetAntigravityAcpLoginStateForTest();

    // No key anywhere -> immediate, actionable failure without spawning.
    let state = await auth.startAntigravityAcpLogin({ methodId: "gemini-api-key" });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /No Gemini API key found/);

    process.env.GEMINI_API_KEY = "AIza-test";
    state = await auth.startAntigravityAcpLogin({ methodId: "gemini-api-key" });
    assert.equal(state.status, "success", JSON.stringify(state));
    assert.equal(
      JSON.parse(readFileSync(path.join(home, "antigravity-acp", "settings.json"), "utf8")).auth.type,
      "gemini-api-key"
    );

    // Enterprise methods insist on GCP coordinates before spawning anything.
    state = await auth.startAntigravityAcpLogin({ methodId: "oauth-business" });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /GCP project and location/);

    // Google OAuth: the server prints the sign-in URL and waits on a loopback
    // port; the relay replays a pasted redirect against it.
    state = await auth.startAntigravityAcpLogin({ methodId: "oauth-personal" });
    assert.equal(state.status, "awaiting-confirmation", JSON.stringify(state));
    assert.match(state.verificationUrl ?? "", /^https:\/\/accounts\.google\.com\//);
    assert.ok(state.callbackPort && state.callbackPort > 0);
    assert.equal(auth.parseOAuthCallbackPort(state.verificationUrl!), state.callbackPort);

    await assert.rejects(
      auth.relayAntigravityAcpOAuthCallback("https://evil.example/?code=x"),
      /not a loopback redirect/
    );
    await assert.rejects(
      auth.relayAntigravityAcpOAuthCallback(`http://127.0.0.1:${state.callbackPort! + 1}/?code=x`),
      /waiting on port/
    );
    await assert.rejects(
      auth.relayAntigravityAcpOAuthCallback(`http://127.0.0.1:${state.callbackPort}/?state=abc`),
      /no OAuth code/
    );
    state = await auth.relayAntigravityAcpOAuthCallback(
      `http://127.0.0.1:${state.callbackPort}/?state=abc&code=4%2Fxyz&scope=openid`
    );
    assert.equal(state.status, "success", JSON.stringify(state));
    assert.equal(state.callbackRelayed, true);
    assert.ok(existsSync(path.join(home, "antigravity-acp", "oauth_creds.json")));
    const signIn = await auth.describeAntigravityAcpSignIn();
    assert.equal(signIn.signedIn, true);
    assert.equal(signIn.configuredAuthType, "oauth-personal");

    const harness = await import("../src/lib/harness-cli-auth.js");
    const cliState = await harness.refreshHarnessCliAuthState("google-antigravity-acp");
    assert.equal(cliState.signedIn, true);
    assert.equal(cliState.authMethodId, "oauth-personal");

    state = await auth.logoutAntigravityAcp();
    assert.equal(state.status, "idle", JSON.stringify(state));
    assert.equal(
      JSON.parse(readFileSync(path.join(home, "antigravity-acp", "settings.json"), "utf8")).auth,
      undefined
    );
    assert.equal(existsSync(path.join(home, "antigravity-acp", "oauth_creds.json")), false);
  } finally {
    const auth = await import("../src/lib/agents/google-antigravity-acp-auth.js");
    auth.resetAntigravityAcpLoginStateForTest();
    await restoreEnv(env);
  }
});

test("pluginMcpServersForAcp emits spec-shaped stdio and http entries", async () => {
  const { pluginMcpServersForAcp } = await import("../src/lib/agents/acp/acp-session.js");
  const out = pluginMcpServersForAcp({
    files: { type: "stdio", command: "/bin/mcp", args: ["--stdio"], env: { TOKEN: "abc" }, cwd: "/tmp" },
    remote: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer x" } },
    broken: { type: "stdio" },
  });
  assert.deepEqual(out, [
    { name: "files", command: "/bin/mcp", args: ["--stdio"], env: [{ name: "TOKEN", value: "abc" }] },
    { type: "http", name: "remote", url: "https://api.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
  ]);
});
