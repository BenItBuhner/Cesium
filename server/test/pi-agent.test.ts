import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const [
  { AGENT_BACKENDS, listAgentBackends },
  {
    PiAgentEventNormalizer,
    piAgentEventsFromSessionEvent,
    piAgentToolEventFromExecution,
    piToolEditPreview,
    piToolTitle,
  },
  {
    PiAgentUiBridge,
    PI_AGENT_CONFIRM_OPTIONS,
    parsePiAgentQuestionAnswer,
  },
  {
    PI_AGENT_ENV_KEYS,
    applyPiRuntimeApiKeys,
    getIsolatedPiAgentDir,
    getNativePiAgentDir,
    getPiAgentAuthPath,
    getPiAgentDir,
    getPiAgentSessionsDirForCwd,
    hasPiAgentStoredAuthConfig,
    resolvePiAgentDir,
    setPiAgentHome,
  },
  {
    buildPiAgentSeedConfigOptions,
    createPiAgentFallbackConfigOptions,
    isPiAgentPlaceholderModelCatalog,
    hasPiAgentRichModelCatalog,
    normalizePiAgentToolApprovalMode,
    selectPiAgentDefaultModel,
  },
  { isPiExtensionCommand, parsePiModelValue, piNativeSessionDirForCwd },
  { AuthStorage },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/pi-agent-normalize.js"),
  import("../src/lib/agents/pi-agent-ui-context.js"),
  import("../src/lib/pi-agent-settings.js"),
  import("../src/lib/pi-agent-model-catalog.js"),
  import("../src/lib/agents/pi-agent-provider.js"),
  import("@earendil-works/pi-coding-agent"),
]);

type AnyEvent = Record<string, unknown> & { type: string };

function counter(prefix = "evt"): () => string {
  let index = 0;
  return () => `${prefix}-${(index += 1)}`;
}

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "techlit",
    model: "kimi-k3",
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Save/clear every Pi-relevant env var so credential tests run in isolation. */
function withoutProviderEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const entry of PI_AGENT_ENV_KEYS) {
    saved.set(entry.env, process.env[entry.env]);
    delete process.env[entry.env];
  }
  for (const env of ["OPENCURSOR_PI_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    saved.set(env, process.env[env]);
  }
  return run().finally(() => {
    for (const [env, value] of saved) {
      if (value === undefined) {
        delete process.env[env];
      } else {
        process.env[env] = value;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Backend registration + agent home resolution
// ---------------------------------------------------------------------------

test("pi agent backend is registered in the harness menu", () => {
  const backends = listAgentBackends();
  const index = backends.findIndex((backend) => backend.id === "pi-agent");
  assert.ok(index >= 0);
  assert.equal(AGENT_BACKENDS["pi-agent"].label, "Pi Agent");
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsToolCalls, true);
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsInlineReasoning, true);
  assert.equal(AGENT_BACKENDS["pi-agent"].capabilities.supportsPermissions, true);
  assert.match(
    AGENT_BACKENDS["pi-agent"].description,
    /~\/\.pi\/agent|packages|extensions|skills/i
  );
});

test("pi agent defaults to native ~/.pi/agent home", () => {
  delete process.env.OPENCURSOR_PI_AGENT_DIR;
  const native = getNativePiAgentDir();
  assert.equal(native, path.join(os.homedir(), ".pi", "agent"));
  assert.equal(resolvePiAgentDir("native"), native);
  assert.equal(resolvePiAgentDir("isolated"), getIsolatedPiAgentDir());
  assert.match(getIsolatedPiAgentDir(), /pi-agent$/);
});

test("pi agent honours PI_CODING_AGENT_DIR like the Pi CLI", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "~/custom-pi-home";
  try {
    assert.equal(getNativePiAgentDir(), path.join(os.homedir(), "custom-pi-home"));
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});

test("pi agent respects OPENCURSOR_PI_AGENT_DIR override", () => {
  const override = path.join(os.tmpdir(), "cesium-pi-override");
  process.env.OPENCURSOR_PI_AGENT_DIR = override;
  try {
    assert.equal(resolvePiAgentDir("native"), path.resolve(override));
    assert.equal(resolvePiAgentDir("isolated"), path.resolve(override));
  } finally {
    delete process.env.OPENCURSOR_PI_AGENT_DIR;
  }
});

test("pi agent auth and session paths follow resolved agent home", async () => {
  delete process.env.OPENCURSOR_PI_AGENT_DIR;
  await setPiAgentHome("native");
  assert.equal(getPiAgentDir(), getNativePiAgentDir());
  assert.equal(getPiAgentAuthPath(), path.join(getNativePiAgentDir(), "auth.json"));
  assert.match(getPiAgentSessionsDirForCwd("/tmp/workspace"), /sessions[\\/][a-f0-9]{16}$/);

  await setPiAgentHome("isolated");
  assert.equal(getPiAgentDir(), getIsolatedPiAgentDir());
  assert.match(getPiAgentAuthPath(), /pi-agent[\\/]+auth\.json$/);

  // Restore native default for subsequent tests / local runs.
  await setPiAgentHome("native");
});

test("pi native session directory mirrors Pi's cwd encoding", () => {
  assert.equal(
    piNativeSessionDirForCwd("/tmp/pi-ws", "/home/me/.pi/agent"),
    path.join("/home/me/.pi/agent", "sessions", "--tmp-pi-ws--")
  );
  assert.deepEqual(parsePiModelValue("techlit/kimi-k3"), { provider: "techlit", modelId: "kimi-k3" });
  assert.deepEqual(parsePiModelValue("OpenAI/gpt-5"), { provider: "openai", modelId: "gpt-5" });
  assert.equal(parsePiModelValue("auto"), null);
  assert.equal(parsePiModelValue("nope"), null);

  const session = {
    extensionRunner: {
      getCommand: (name: string) => (name === "hello" ? { invocationName: "hello" } : undefined),
    },
  } as unknown as Parameters<typeof isPiExtensionCommand>[0];
  assert.equal(isPiExtensionCommand(session, "/hello there"), true);
  assert.equal(isPiExtensionCommand(session, "  /hello"), true);
  assert.equal(isPiExtensionCommand(session, "/shout loud"), false, "prompt templates echo a user turn");
  assert.equal(isPiExtensionCommand(session, "hello"), false);
  assert.equal(isPiExtensionCommand(session, "/"), false);
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test("pi agent env key table matches Pi's provider env conventions", () => {
  const google = PI_AGENT_ENV_KEYS.filter((entry) => entry.providerId === "google");
  assert.ok(google.some((entry) => entry.env === "GEMINI_API_KEY" && !entry.alias));
  assert.ok(google.some((entry) => entry.env === "GOOGLE_API_KEY" && entry.alias));
  assert.ok(PI_AGENT_ENV_KEYS.some((entry) => entry.env === "GROQ_API_KEY"));
  assert.ok(PI_AGENT_ENV_KEYS.some((entry) => entry.env === "XAI_API_KEY"));
});

test("pi agent applies Cesium env aliases as runtime keys", async () => {
  await withoutProviderEnv(async () => {
    process.env.GOOGLE_API_KEY = "AIza-test-alias";
    const authStorage = AuthStorage.inMemory();
    assert.equal(authStorage.hasAuth("google"), false);
    await applyPiRuntimeApiKeys(authStorage);
    assert.equal(authStorage.hasAuth("google"), true);
    assert.equal(await authStorage.getApiKey("google"), "AIza-test-alias");
  });
});

test("pi agent counts models.json custom providers as configured", async () => {
  await withoutProviderEnv(async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-pi-home-"));
    process.env.OPENCURSOR_PI_AGENT_DIR = agentDir;
    try {
      assert.equal(await hasPiAgentStoredAuthConfig(), false);
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            localproxy: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "literal-key",
              models: [{ id: "tiny-model", name: "Tiny" }],
            },
          },
        })
      );
      assert.equal(await hasPiAgentStoredAuthConfig(), true);

      const options = await buildPiAgentSeedConfigOptions();
      const modelOption = options.find((option) => option.id === "model");
      assert.ok(modelOption);
      assert.ok(modelOption.options.some((entry) => entry.value === "localproxy/tiny-model"));
      assert.equal(modelOption.currentValue, "localproxy/tiny-model");
      assert.ok(options.some((option) => option.id === "tool_approval"));
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

test("pi agent placeholder model catalog is detected", () => {
  const fallback = createPiAgentFallbackConfigOptions();
  assert.equal(isPiAgentPlaceholderModelCatalog(fallback), true);
  assert.equal(hasPiAgentRichModelCatalog(fallback), false);
  assert.ok(fallback.some((option) => option.id === "tool_approval" && option.category === "other"));

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

test("pi agent default model prefers Pi settings, then custom providers", () => {
  const catalog = [
    { value: "openai/gpt-5", name: "OpenAI/gpt-5", provider: "openai", custom: false },
    { value: "techlit/kimi-k3", name: "techlit/Kimi", provider: "techlit", custom: true },
    { value: "anthropic/claude", name: "Anthropic/claude", provider: "anthropic", custom: false },
  ];
  assert.equal(selectPiAgentDefaultModel(catalog), "techlit/kimi-k3");
  assert.equal(
    selectPiAgentDefaultModel(catalog, { provider: "anthropic", model: "claude" }),
    "anthropic/claude"
  );
  assert.equal(selectPiAgentDefaultModel(catalog, { provider: "openai" }), "openai/gpt-5");
  assert.equal(
    selectPiAgentDefaultModel(catalog, { provider: "missing", model: "x" }),
    "techlit/kimi-k3"
  );
  assert.equal(selectPiAgentDefaultModel([]), undefined);
  assert.equal(normalizePiAgentToolApprovalMode("mutations"), "mutations");
  assert.equal(normalizePiAgentToolApprovalMode("nonsense"), "pi");
});

// ---------------------------------------------------------------------------
// Event normalization (stateless helpers)
// ---------------------------------------------------------------------------

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
  assert.equal(textEvents[0]?.messageId, assistantMessageId);

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

test("pi tool titles and edit previews cover built-in and extension tools", () => {
  assert.equal(piToolTitle("read", { path: "src/app.ts" }), "Read app.ts");
  assert.equal(piToolTitle("ls", { path: "src" }), "List src");
  assert.equal(piToolTitle("find", { pattern: "*.ts" }), 'Find "*.ts"');
  assert.equal(piToolTitle("greet", { name: "x" }, "Greet"), "Greet");
  assert.equal(piToolTitle("greet", { name: "x" }), "greet");

  const editPreview = piToolEditPreview(
    "edit",
    { path: "notes.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
    {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
      details: {
        diff: "-hello\n+goodbye",
        patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n",
      },
    }
  );
  assert.ok(editPreview);
  assert.equal(editPreview.addedLines, 1);
  assert.equal(editPreview.removedLines, 1);
  assert.equal(editPreview.path, "notes.txt");

  const writePreview = piToolEditPreview("write", { path: "new.txt", content: "a\nb\n" }, { content: [] });
  assert.ok(writePreview);
  assert.equal(writePreview.addedLines, 2);
  assert.equal(writePreview.removedLines, 0);

  assert.equal(piToolEditPreview("bash", { command: "ls" }, { content: [] }), undefined);
});

// ---------------------------------------------------------------------------
// Event normalization (stateful run projection)
// ---------------------------------------------------------------------------

test("pi normalizer surfaces provider errors as failed runs", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.beginPrompt();
  assert.deepEqual(normalizer.handle({ type: "agent_start" }), {
    events: [],
    status: "running",
    lastError: null,
  });
  assert.equal(normalizer.isRunActive, true);
  // The echoed prompt must not be re-emitted as a user turn.
  assert.deepEqual(
    normalizer.handle({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    { events: [] }
  );
  normalizer.handle({ type: "message_start", message: assistantMessage() });
  const endMessage = normalizer.handle({
    type: "message_end",
    message: assistantMessage({ stopReason: "error", errorMessage: "401 Unauthorized: bad key" }),
  });
  // Nothing streamed, so no assistant bubble to close - the error waits for agent_end.
  assert.deepEqual(endMessage.events, []);
  const end = normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.deepEqual(
    end.events.map((event) => event.kind),
    ["system", "status"]
  );
  assert.equal(end.events[0]?.kind === "system" && end.events[0].level, "error");
  assert.equal(end.events[0]?.kind === "system" && end.events[0].text, "401 Unauthorized: bad key");
  assert.equal(end.status, "failed");
  assert.equal(end.lastError, "401 Unauthorized: bad key");
  assert.deepEqual(end.runOutcome, { status: "failed", error: "401 Unauthorized: bad key" });
  assert.equal(normalizer.isRunActive, false);
});

test("pi normalizer keeps a retrying run open and recovers on success", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "message_start", message: assistantMessage() });
  normalizer.handle({
    type: "message_end",
    message: assistantMessage({ stopReason: "error", errorMessage: "529 overloaded" }),
  });
  const retrying = normalizer.handle({ type: "agent_end", messages: [], willRetry: true });
  assert.deepEqual(retrying, { events: [], status: "running" });
  assert.equal(normalizer.isRunActive, true);

  const retryStart = normalizer.handle({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "529 overloaded",
  });
  assert.equal(retryStart.events[0]?.kind, "system");
  assert.match(retryStart.events[0]?.kind === "system" ? retryStart.events[0].text : "", /retrying in 2s \(attempt 1\/3\)/);
  assert.equal(retryStart.events[1]?.kind, "status");
  assert.match(retryStart.events[1]?.kind === "status" ? retryStart.events[1].detail ?? "" : "", /^Taking longer/);

  normalizer.handle({ type: "auto_retry_end", success: true, attempt: 1 });
  normalizer.handle({ type: "message_start", message: assistantMessage() });
  normalizer.handle({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "done" },
  });
  normalizer.handle({ type: "message_end", message: assistantMessage({ stopReason: "stop" }) });
  const end = normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(end.status, "idle");
  assert.equal(end.lastError, null);
});

test("pi normalizer reports exhausted retries with the final error", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "agent_end", messages: [], willRetry: true });
  normalizer.handle({ type: "auto_retry_end", success: false, attempt: 3, finalError: "still overloaded" });
  const end = normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(end.status, "failed");
  assert.equal(end.lastError, "still overloaded");
});

test("pi normalizer maps aborted runs and cancel requests to cancelled", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "message_start", message: assistantMessage() });
  normalizer.handle({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "partial" },
  });
  const closing = normalizer.markCancelRequested();
  assert.equal(closing.length, 1);
  assert.equal(closing[0]?.kind, "assistant_message_end");
  assert.equal(closing[0]?.kind === "assistant_message_end" && closing[0].stopReason, "cancelled");

  // Pi finishes the aborted message and ends the run.
  const aborted = normalizer.handle({ type: "message_end", message: assistantMessage({ stopReason: "aborted" }) });
  assert.deepEqual(aborted.events, []);
  const end = normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.deepEqual(end.events.map((event) => event.kind), ["status"]);
  assert.equal(end.status, "cancelled");
  assert.equal(end.lastError, null);
  assert.deepEqual(normalizer.lastRunOutcome, { status: "cancelled", error: null });
  assert.equal(normalizer.markCancelRequested().length, 0, "no-op when idle");
});

test("pi normalizer remembers tool arguments and labels across execution events", () => {
  const normalizer = new PiAgentEventNormalizer({
    conversationId: "conv",
    eventId: counter(),
    resolveToolLabel: (name) => (name === "greet" ? "Greet" : undefined),
  });
  normalizer.handle({ type: "agent_start" });
  const start = normalizer.handle({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "README.md" },
  });
  assert.equal(start.events[0]?.kind, "tool_call");
  assert.equal(start.events[0]?.kind === "tool_call" && start.events[0].title, "Read README.md");

  const update = normalizer.handle({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "README.md" },
    partialResult: { content: [{ type: "text", text: "partial" }] },
  });
  assert.equal(update.events[0]?.kind, "tool_call_update");
  assert.equal(update.events[0]?.kind === "tool_call_update" && update.events[0].detail, "partial");

  // Pi's tool_execution_end carries no args - title/locations come from memory.
  const end = normalizer.handle({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "# hi" }] },
    isError: false,
  });
  const endEvent = end.events[0];
  assert.equal(endEvent?.kind, "tool_call_update");
  if (endEvent?.kind === "tool_call_update") {
    assert.equal(endEvent.title, "Read README.md");
    assert.equal(endEvent.status, "completed");
    assert.deepEqual(endEvent.locations, [{ path: "README.md" }]);
  }

  const custom = normalizer.handle({
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "greet",
    args: { name: "Cesium" },
  });
  assert.equal(custom.events[0]?.kind === "tool_call" && custom.events[0].title, "Greet");
  const failed = normalizer.handle({
    type: "tool_execution_end",
    toolCallId: "call-2",
    toolName: "greet",
    result: { content: [{ type: "text", text: "Blocked by probe extension" }] },
    isError: true,
  });
  assert.equal(failed.events[0]?.kind === "tool_call_update" && failed.events[0].status, "failed");
  assert.equal(failed.events[0]?.kind === "tool_call_update" && failed.events[0].title, "Greet");

  const edit = normalizer.handle({
    type: "tool_execution_start",
    toolCallId: "call-3",
    toolName: "edit",
    args: { path: "notes.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
  });
  assert.equal(edit.events[0]?.kind === "tool_call" && edit.events[0].toolKind, "edit");
  const editEnd = normalizer.handle({
    type: "tool_execution_end",
    toolCallId: "call-3",
    toolName: "edit",
    result: {
      content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
      details: { patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n" },
    },
    isError: false,
  });
  assert.ok(editEnd.events[0]?.kind === "tool_call_update" && editEnd.events[0].editPreview);
});

test("pi normalizer segments assistant text per Pi message and surfaces injected turns", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.beginPrompt();
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "message_start", message: { role: "user", content: "owned prompt" } });

  normalizer.handle({ type: "message_start", message: assistantMessage() });
  const first = normalizer.handle({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "Step one." },
  });
  const firstId = first.events[0]?.kind === "assistant_message_chunk" ? first.events[0].messageId : "";
  const firstEnd = normalizer.handle({ type: "message_end", message: assistantMessage({ stopReason: "toolUse" }) });
  assert.equal(firstEnd.events[0]?.kind, "assistant_message_end");
  assert.equal(firstEnd.events[0]?.kind === "assistant_message_end" && firstEnd.events[0].messageId, firstId);

  // Extension-injected steering message: Cesium never persisted it.
  const injected = normalizer.handle({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "also check tests" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
  });
  assert.equal(injected.events[0]?.kind, "user_message");
  if (injected.events[0]?.kind === "user_message") {
    assert.equal(injected.events[0].content, "also check tests");
    assert.equal(injected.events[0].attachments?.length, 1);
  }

  normalizer.handle({ type: "message_start", message: assistantMessage() });
  const second = normalizer.handle({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "Step two." },
  });
  const secondId = second.events[0]?.kind === "assistant_message_chunk" ? second.events[0].messageId : "";
  assert.notEqual(firstId, secondId);
  normalizer.handle({ type: "message_end", message: assistantMessage({ stopReason: "stop" }) });

  // Custom messages from extensions (pi.sendMessage with display: true).
  const custom = normalizer.handle({
    type: "message_end",
    message: { role: "custom", customType: "probe-hello", content: "hello command ran", display: true },
  });
  assert.equal(custom.events[0]?.kind, "system");
  assert.equal(custom.events[0]?.kind === "system" && custom.events[0].text, "[probe-hello] hello command ran");
  const hidden = normalizer.handle({
    type: "message_end",
    message: { role: "custom", customType: "hidden", content: "secret", display: false },
  });
  assert.deepEqual(hidden.events, []);

  const end = normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.deepEqual(end.events.map((event) => event.kind), ["status"]);
  assert.equal(end.status, "idle");
});

test("pi normalizer prompt markers are owned by the caller, not by run boundaries", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.beginPrompt();
  assert.equal(normalizer.hasPendingOwnedPrompt, true);
  normalizer.abandonPrompt();
  assert.equal(normalizer.hasPendingOwnedPrompt, false);
  assert.equal(normalizer.hasPendingOwnedPrompt, false);
  normalizer.abandonPrompt();
  assert.equal(normalizer.hasPendingOwnedPrompt, false, "abandon never goes negative");

  // A run ending must not clear a marker the next prompt() already placed:
  // the provider drains the previous run first and clears leftovers itself.
  normalizer.beginPrompt();
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(normalizer.hasPendingOwnedPrompt, true);
  const owned = normalizer.handle({ type: "message_start", message: { role: "user", content: "mine" } });
  assert.deepEqual(owned.events, []);
  const injected = normalizer.handle({ type: "message_start", message: { role: "user", content: "later" } });
  assert.equal(injected.events[0]?.kind, "user_message");
});

test("pi normalizer projects compaction and session metadata events", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  const start = normalizer.handle({ type: "compaction_start", reason: "threshold" });
  assert.equal(start.status, "running");
  assert.match(start.events[0]?.kind === "status" ? start.events[0].detail ?? "" : "", /^Compressing context/);

  const end = normalizer.handle({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "We did things.", firstKeptEntryId: "abc", tokensBefore: 120_000 },
    aborted: false,
    willRetry: false,
  });
  assert.equal(end.events[0]?.kind, "compression_summary");
  if (end.events[0]?.kind === "compression_summary") {
    assert.equal(end.events[0].summary, "We did things.");
    assert.equal(end.events[0].estimatedTokensBefore, 120_000);
  }
  // Manual compaction outside a run returns the conversation to idle.
  assert.equal(end.events[1]?.kind, "status");
  assert.equal(end.status, "idle");

  const failed = normalizer.handle({
    type: "compaction_end",
    reason: "manual",
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: "summary model unavailable",
  });
  assert.equal(failed.events[0]?.kind === "system" && failed.events[0].level, "error");

  assert.deepEqual(normalizer.handle({ type: "session_info_changed", name: "Refactor auth" }), {
    events: [],
    sessionName: "Refactor auth",
  });
  assert.deepEqual(normalizer.handle({ type: "thinking_level_changed", level: "high" }), {
    events: [],
    thinkingLevel: "high",
  });
  assert.deepEqual(normalizer.handle({ type: "queue_update", steering: [], followUp: [] }), { events: [] });
  assert.deepEqual(normalizer.handle({ type: "turn_start" }), { events: [] });
});

test("pi normalizer endRun can force a cancelled outcome when Pi never emits agent_end", () => {
  const normalizer = new PiAgentEventNormalizer({ conversationId: "conv", eventId: counter() });
  normalizer.handle({ type: "agent_start" });
  normalizer.handle({ type: "agent_end", messages: [], willRetry: true });
  const forced = normalizer.endRun({ forceStatus: "cancelled" });
  assert.equal(forced.status, "cancelled");
  assert.equal(forced.events[0]?.kind === "status" && forced.events[0].status, "cancelled");
  assert.equal(normalizer.isRunActive, false);
});

// ---------------------------------------------------------------------------
// Extension UI bridge
// ---------------------------------------------------------------------------

type BridgeHarness = {
  bridge: InstanceType<typeof PiAgentUiBridge>;
  events: Array<Record<string, unknown>>;
  conversation: () => Record<string, unknown>;
};

function createBridgeHarness(): BridgeHarness {
  const events: Array<Record<string, unknown>> = [];
  let conversation: Record<string, unknown> = {
    id: "conv",
    status: "running",
    pendingPermission: null,
    pendingQuestion: null,
  };
  const bridge = new PiAgentUiBridge(
    {
      conversationId: "conv",
      appendEvents: async (batch) => {
        events.push(...(batch as Array<Record<string, unknown>>));
      },
      updateConversation: async (patch) => {
        conversation = patch(conversation as never) as unknown as Record<string, unknown>;
      },
    },
    { eventId: counter("ui") }
  );
  return { bridge, events, conversation: () => conversation };
}

test("pi ui bridge maps confirm() onto a Cesium permission card", async () => {
  const harness = createBridgeHarness();
  const pending = harness.bridge.confirm("Dangerous command", "Allow rm -rf?");
  await new Promise((resolve) => setImmediate(resolve));
  const request = harness.events.find((event) => event.kind === "permission_request");
  assert.ok(request);
  assert.equal(request.title, "Dangerous command");
  assert.equal(request.detail, "Allow rm -rf?");
  assert.deepEqual(request.options, PI_AGENT_CONFIRM_OPTIONS);
  assert.equal(harness.conversation().status, "awaiting_permission");
  assert.equal(
    (harness.conversation().pendingPermission as { requestId: string }).requestId,
    request.requestId
  );
  assert.equal(harness.bridge.hasPendingDialog, true);

  assert.equal(
    await harness.bridge.answerPermission({ requestId: request.requestId as string, optionId: "allow_once" }),
    true
  );
  assert.equal(await pending, true);
  assert.ok(harness.events.some((event) => event.kind === "permission_resolved" && event.outcome === "selected"));
  assert.equal(harness.conversation().status, "running");
  assert.equal(harness.conversation().pendingPermission, null);
  assert.equal(harness.bridge.hasPendingDialog, false);
  assert.equal(await harness.bridge.answerPermission({ requestId: "unknown", optionId: "allow_once" }), false);
});

test("pi ui bridge rejects and cancels confirm() dialogs", async () => {
  const harness = createBridgeHarness();
  const rejected = harness.bridge.confirm("Q", "m");
  await new Promise((resolve) => setImmediate(resolve));
  const request = harness.events.find((event) => event.kind === "permission_request");
  await harness.bridge.answerPermission({ requestId: request?.requestId as string, optionId: "reject_once" });
  assert.equal(await rejected, false);

  const cancelled = harness.bridge.confirm("Q2", "m2");
  await new Promise((resolve) => setImmediate(resolve));
  const second = harness.events.filter((event) => event.kind === "permission_request")[1];
  await harness.bridge.answerPermission({ requestId: second?.requestId as string, cancelled: true });
  assert.equal(await cancelled, false);

  const timed = harness.bridge.confirm("Q3", "m3", { timeout: 20 });
  assert.equal(await timed, false);

  const controller = new AbortController();
  const aborted = harness.bridge.confirm("Q4", "m4", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await aborted, false);
  controller.abort();
  assert.equal(await harness.bridge.confirm("Q5", "m5", { signal: controller.signal }), false);
});

test("pi ui bridge maps select()/input() onto ask-question cards", async () => {
  const harness = createBridgeHarness();
  const selection = harness.bridge.select("Pick a color", ["red", "green", "blue"]);
  await new Promise((resolve) => setImmediate(resolve));
  const question = harness.events.find((event) => event.kind === "question" && event.status === "pending");
  assert.ok(question);
  assert.equal(question.prompt, "Pick a color");
  assert.deepEqual(question.options, [
    { id: "option-1", label: "red" },
    { id: "option-2", label: "green" },
    { id: "option-3", label: "blue" },
  ]);
  assert.equal(harness.conversation().status, "awaiting_question");
  // The card submits "<title>: <choice>".
  await harness.bridge.answerQuestion({ questionId: question.questionId as string, answer: "Pick a color: Green" });
  assert.equal(await selection, "green");
  assert.equal(harness.conversation().status, "running");
  assert.equal(harness.conversation().pendingQuestion, null);
  assert.ok(harness.events.some((event) => event.kind === "question" && event.status === "answered" && event.answer === "green"));

  const typed = harness.bridge.input("Branch name", "feature/...");
  await new Promise((resolve) => setImmediate(resolve));
  const inputQuestion = harness.events.filter((event) => event.kind === "question" && event.status === "pending")[1];
  assert.equal(inputQuestion?.prompt, "Branch name (feature/...)");
  assert.deepEqual(inputQuestion?.options, []);
  await harness.bridge.answerQuestion({
    questionId: inputQuestion?.questionId as string,
    answer: "Branch name (feature/...): feature/pi-harness",
  });
  assert.equal(await typed, "feature/pi-harness");

  const edited = harness.bridge.editor("Commit message", "wip");
  await new Promise((resolve) => setImmediate(resolve));
  const editorQuestion = harness.events.filter((event) => event.kind === "question" && event.status === "pending")[2];
  assert.match(String(editorQuestion?.prompt), /Current text:\nwip/);
  await harness.bridge.cancelAll();
  assert.equal(await edited, undefined);
  assert.ok(harness.events.some((event) => event.kind === "question" && event.status === "cancelled"));
  // cancelAll never claims the run is back to running.
  assert.equal(harness.events[harness.events.length - 1]?.kind, "question");
});

test("pi ui bridge notify() becomes a system row", async () => {
  const harness = createBridgeHarness();
  await harness.bridge.notify("Extension loaded", "info");
  await harness.bridge.notify("Careful", "warning");
  await harness.bridge.notify("Broke", "error");
  await harness.bridge.notify("   ");
  assert.deepEqual(
    harness.events.map((event) => [event.kind, event.level, event.text]),
    [
      ["system", "info", "Extension loaded"],
      ["system", "warning", "Careful"],
      ["system", "error", "Broke"],
    ]
  );
});

test("pi question answers strip card prefixes and resolve option letters", () => {
  const options = [
    { id: "option-1", label: "Yes" },
    { id: "option-2", label: "No" },
  ];
  assert.deepEqual(parsePiAgentQuestionAnswer({ answer: "Allow?: Yes", prompt: "Allow?", options }), {
    text: "Yes",
    option: options[0],
  });
  assert.equal(parsePiAgentQuestionAnswer({ answer: "Allow?: b", prompt: "Allow?", options }).option?.label, "No");
  assert.equal(parsePiAgentQuestionAnswer({ answer: "no", prompt: "Allow?", options }).option?.label, "No");
  assert.equal(parsePiAgentQuestionAnswer({ answer: "Question 1: maybe later", prompt: "Allow?", options }).text, "maybe later");
  assert.equal(parsePiAgentQuestionAnswer({ answer: "Allow?: something else", prompt: "Allow?", options }).option, undefined);
  assert.equal(parsePiAgentQuestionAnswer({ answer: "Allow?: something else", prompt: "Allow?", options }).text, "something else");
});
