import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const TEST_ROOT = path.join(os.tmpdir(), `claude-code-sdk-session-${process.pid}-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });
process.env.OPENCURSOR_DATA_DIR = path.join(TEST_ROOT, "data");
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_ROOT;
process.env.OPENCURSOR_CLAUDE_CODE_SDK_BASE_URL = "https://proxy.example.test/v1";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_API_KEY = "test-key";
process.env.OPENCURSOR_CLAUDE_CODE_SDK_MODEL = "kimi-k3";

const { createClaudeCodeSdkProvider, buildClaudeUserMessage, toolProfileForConfig, claudeCodeSdkEnv } =
  await import("../src/lib/agents/claude-code-sdk-provider.js");
const { AGENT_CAPABILITIES } = await import("../src/lib/agents/agent-contract.js");
const { writeClaudeCodeSdkConversationState, resetClaudeCodeSdkConversationStateCache } =
  await import("../src/lib/agents/claude-code-sdk-session-state.js");
type AgentConversationRecord = import("../src/lib/agents/types.js").AgentConversationRecord;
type AgentEventInput = import("../src/lib/agents/types.js").AgentEventInput;
type AgentRuntimeCallbacks = import("../src/lib/agents/types.js").AgentRuntimeCallbacks;
type AgentBackendInfo = import("../src/lib/agents/types.js").AgentBackendInfo;
type AgentConfigOption = import("../src/lib/agents/types.js").AgentConfigOption;

// ---------------------------------------------------------------------------
// Fake CLI plumbing
// ---------------------------------------------------------------------------

class Outbox<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.queue.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ value: undefined as never, done: true });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve, reject) => {
          const queued = this.queue.shift();
          if (queued !== undefined) return resolve({ value: queued, done: false });
          if (this.failure) return reject(this.failure);
          if (this.closed) return resolve({ value: undefined as never, done: true });
          this.waiters.push({ resolve, reject });
        }),
      return: async () => {
        this.end();
        return { value: undefined as never, done: true };
      },
    };
  }
}

type FakeState = {
  interrupted: boolean;
  waitForInterrupt: () => Promise<void>;
};

type FakeTurnContext = {
  message: SDKUserMessage;
  options: Options;
  sessionId: string;
  turn: number;
  emit: (message: unknown) => void;
  state: FakeState;
};

type FakeScript = (ctx: FakeTurnContext) => Promise<void>;

function createFakeClaudeQuery(
  script: FakeScript,
  fakeOptions: { sessionId?: string; tools?: string[]; commands?: unknown[]; models?: unknown[] } = {}
) {
  const calls = {
    spawns: 0,
    interrupts: 0,
    closes: 0,
    setModel: [] as Array<string | undefined>,
    setPermissionMode: [] as string[],
    optionsHistory: [] as Options[],
    received: [] as SDKUserMessage[],
  };
  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    calls.spawns += 1;
    const options = params.options ?? {};
    calls.optionsHistory.push(options);
    const out = new Outbox<unknown>();
    const sessionId = fakeOptions.sessionId ?? `fake-session-${calls.spawns}`;
    let interruptWaiters: Array<() => void> = [];
    const state: FakeState = {
      interrupted: false,
      waitForInterrupt: () =>
        new Promise<void>((resolve) => {
          if (state.interrupted) resolve();
          else interruptWaiters.push(resolve);
        }),
    };
    (async () => {
      if (typeof params.prompt === "string") {
        throw new Error("fake CLI expects streaming input");
      }
      let turn = 0;
      for await (const message of params.prompt) {
        turn += 1;
        calls.received.push(message);
        out.push(initMessage(sessionId, fakeOptions.tools));
        await script({ message, options, sessionId, turn, emit: (value) => out.push(value), state });
      }
      out.end();
    })().catch((error) => out.fail(error));
    const query = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => {
        calls.interrupts += 1;
        state.interrupted = true;
        interruptWaiters.forEach((resolve) => resolve());
        interruptWaiters = [];
        return undefined;
      },
      close: () => {
        calls.closes += 1;
        out.end();
      },
      setModel: async (model?: string) => {
        calls.setModel.push(model);
      },
      setPermissionMode: async (mode: string) => {
        calls.setPermissionMode.push(mode);
      },
      supportedCommands: async () =>
        fakeOptions.commands ?? [
          { name: "compact", description: "Compact the conversation", argumentHint: "" },
          { name: "review", description: "Review code", argumentHint: "<pr>" },
        ],
      supportedModels: async () => fakeOptions.models ?? [],
      supportedAgents: async () => [],
      getContextUsage: async () => ({
        totalTokens: 4_321,
        maxTokens: 200_000,
        categories: [
          { name: "System tools", tokens: 3_000 },
          { name: "Messages", tokens: 1_321 },
          { name: "Free space", tokens: 195_679 },
        ],
      }),
    };
    return query as unknown as Query;
  };
  return { queryFn, calls };
}

let uuidCounter = 0;
const uuid = () => `uuid-${++uuidCounter}`;

function initMessage(sessionId: string, tools?: string[]) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: uuid(),
    cwd: "/tmp",
    tools: tools ?? [
      "Task",
      "AskUserQuestion",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "Write",
      "ExitPlanMode",
    ],
    mcp_servers: [],
    model: "kimi-k3",
    permissionMode: "default",
    slash_commands: ["compact", "clear", "__remote-workflow"],
    apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: "2.1.211",
    output_style: "default",
    skills: [],
    plugins: [],
    agents: ["Explore", "general-purpose"],
  };
}

function streamEvent(sessionId: string, event: Record<string, unknown>, parent: string | null = null) {
  return { type: "stream_event", session_id: sessionId, uuid: uuid(), parent_tool_use_id: parent, event };
}

function assistantMessage(
  sessionId: string,
  messageId: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
) {
  return {
    type: "assistant",
    session_id: sessionId,
    uuid: uuid(),
    parent_tool_use_id: null,
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: "kimi-k3",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 1_200, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    },
    ...extra,
  };
}

function toolResultMessage(
  sessionId: string,
  toolUseId: string,
  content: unknown,
  extra: { isError?: boolean; parent?: string | null; toolUseResult?: unknown } = {}
) {
  return {
    type: "user",
    session_id: sessionId,
    uuid: uuid(),
    parent_tool_use_id: extra.parent ?? null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(extra.isError ? { is_error: true } : {}) }],
    },
    ...(extra.toolUseResult !== undefined ? { tool_use_result: extra.toolUseResult } : {}),
  };
}

function resultMessage(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1_500,
    duration_api_ms: 1_200,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1_200, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    modelUsage: {
      "kimi-k3": {
        inputTokens: 1_200,
        outputTokens: 40,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0123,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      },
    },
    permission_denials: [],
    session_id: sessionId,
    uuid: uuid(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cesium plumbing
// ---------------------------------------------------------------------------

const BACKEND: AgentBackendInfo = {
  id: "claude-code-sdk",
  label: "Claude Code",
  description: "test",
  available: true,
  defaultMode: "agent",
  defaultModelId: "kimi-k3",
  defaultModelName: "Kimi K3",
  capabilities: AGENT_CAPABILITIES["claude-code-sdk"],
};

function configOptions(overrides: Record<string, string> = {}): AgentConfigOption[] {
  const option = (
    id: string,
    category: AgentConfigOption["category"],
    values: string[],
    current: string
  ): AgentConfigOption => ({
    id,
    name: id,
    category,
    currentValue: overrides[id] ?? current,
    options: values.map((value) => ({ value, name: value })),
  });
  return [
    option("mode", "mode", ["agent", "plan", "ask", "debug"], "agent"),
    option("model", "model", ["kimi-k3", "sonnet", "opus"], "kimi-k3"),
    option("permission_mode", "permission", ["default", "acceptEdits", "plan", "dontAsk", "auto"], "default"),
    option("effort", "thought_level", ["low", "medium", "high"], "medium"),
    option("thinking", "thought_level", ["adaptive", "disabled"], "adaptive"),
    option("tool_profile", "other", ["standard", "safe-readonly", "full", "plan"], "standard"),
    option("max_turns", "other", ["unlimited", "10"], "unlimited"),
    option("session_persistence", "other", ["enabled", "disabled"], "enabled"),
    option("setting_sources", "other", ["all", "project", "none"], "all"),
  ];
}

let conversationCounter = 0;

function createCallbacks(input: { root: string; mode?: string; providerSessionId?: string | null } ) {
  conversationCounter += 1;
  const appended: AgentEventInput[] = [];
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `claude-conversation-${conversationCounter}`,
    workspaceId: "claude-workspace",
    title: "Claude test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "claude-code-sdk",
      mode: input.mode ?? "agent",
      modelId: "kimi-k3",
      modelName: "Kimi K3",
    },
    providerSessionId: input.providerSessionId ?? null,
    configOptions: [],
    capabilities: AGENT_CAPABILITIES["claude-code-sdk"],
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "claude-workspace",
      root: input.root,
      name: "Claude",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (events) => {
      appended.push(...events);
      return events.map((event, index) => ({
        ...event,
        seq: appended.length - events.length + index + 1,
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

function workspaceRoot(name: string): string {
  const root = path.join(TEST_ROOT, name);
  mkdirSync(root, { recursive: true });
  return root;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventsOfKind<K extends AgentEventInput["kind"]>(
  events: AgentEventInput[],
  kind: K
): Array<Extract<AgentEventInput, { kind: K }>> {
  return events.filter((event): event is Extract<AgentEventInput, { kind: K }> => event.kind === kind);
}

const FAST_TIMINGS = { interruptGraceMs: 500, closeGraceMs: 300, toolProgressIntervalMs: 0, controlRequestTimeoutMs: 500 };

function providerWith(queryFn: ReturnType<typeof createFakeClaudeQuery>["queryFn"], options?: {
  configOverrides?: Record<string, string>;
  sessionFileExists?: (sessionId: string, cwd: string) => Promise<boolean>;
}) {
  return createClaudeCodeSdkProvider({
    backend: BACKEND,
    configOptions: configOptions(options?.configOverrides),
    deps: {
      query: queryFn,
      sessionFileExists: options?.sessionFileExists ?? (async () => true),
      contextProbe: false,
      timings: FAST_TIMINGS,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("streamed text is emitted once with per-message ids and the turn settles idle", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(streamEvent(sessionId, { type: "message_start", message: { id: "msg_1", role: "assistant" } }));
    emit(streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }));
    emit(streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }));
    emit(streamEvent(sessionId, { type: "message_stop" }));
    emit(assistantMessage(sessionId, "msg_1", [{ type: "text", text: "Hello world" }]));
    emit(resultMessage(sessionId, { result: "Hello world" }));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("stream") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "hi", userMessageId: "u1" });

  const chunks = eventsOfKind(appended, "assistant_message_chunk");
  assert.equal(chunks.map((chunk) => chunk.text).join(""), "Hello world");
  assert.equal(new Set(chunks.map((chunk) => chunk.messageId)).size, 1);
  assert.ok(chunks[0]!.messageId.endsWith("msg_1"));
  const ends = eventsOfKind(appended, "assistant_message_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.messageId, chunks[0]!.messageId);
  const statuses = eventsOfKind(appended, "status").map((event) => event.status);
  assert.equal(statuses[statuses.length - 1], "idle");
  assert.ok(
    eventsOfKind(appended, "status").some((event) => event.status === "idle" && /tokens/.test(event.detail ?? "")),
    "idle status carries usage detail"
  );
  assert.equal(conversation().status, "idle");
  assert.equal(conversation().providerSessionId, "fake-session-1");
  assert.equal(handle.sessionId, "fake-session-1");
  assert.deepEqual(
    conversation().availableCommands?.map((command) => command.name),
    ["compact", "review"]
  );
  assert.equal(fake.calls.received[0]!.message.content, "hi");
  await handle.dispose();
});

test("non-streamed assistant messages (proxy fallback) emit their text exactly once", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "chatcmpl-1", [{ type: "text", text: "Full answer." }]));
    emit(resultMessage(sessionId, { result: "Full answer." }));
  });
  const { callbacks, appended } = createCallbacks({ root: workspaceRoot("nonstream") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "hi", userMessageId: "u1" });
  const chunks = eventsOfKind(appended, "assistant_message_chunk");
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["Full answer."]);
  assert.equal(eventsOfKind(appended, "assistant_message_end").length, 1);
  await handle.dispose();
});

test("text after a tool call keeps streaming under a fresh message id", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(streamEvent(sessionId, { type: "message_start", message: { id: "msg_a" } }));
    emit(streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading." } }));
    emit(streamEvent(sessionId, { type: "message_stop" }));
    emit(
      assistantMessage(sessionId, "msg_a", [
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/x.ts" } },
      ])
    );
    emit(toolResultMessage(sessionId, "toolu_read", "1\tconst x = 1;"));
    emit(streamEvent(sessionId, { type: "message_start", message: { id: "msg_b" } }));
    emit(streamEvent(sessionId, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }));
    emit(streamEvent(sessionId, { type: "message_stop" }));
    emit(assistantMessage(sessionId, "msg_b", [{ type: "text", text: "Done." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended } = createCallbacks({ root: workspaceRoot("toolflow") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "read x", userMessageId: "u1" });
  const chunks = eventsOfKind(appended, "assistant_message_chunk");
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["Reading.", "Done."]);
  assert.notEqual(chunks[0]!.messageId, chunks[1]!.messageId);
  const ends = eventsOfKind(appended, "assistant_message_end").map((event) => event.messageId);
  assert.deepEqual(ends, [chunks[0]!.messageId, chunks[1]!.messageId]);
  const kinds = appended.map((event) => event.kind);
  const firstEnd = kinds.indexOf("assistant_message_end");
  const toolCall = kinds.indexOf("tool_call");
  assert.ok(firstEnd < toolCall, "first message ends before the tool card");
  const calls = eventsOfKind(appended, "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.toolKind, "read");
  assert.equal(calls[0]!.title, "Read x.ts");
  const updates = eventsOfKind(appended, "tool_call_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.status, "completed");
  await handle.dispose();
});

test("TaskCreate/TaskUpdate traffic mirrors into a single Cesium plan", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(
      assistantMessage(sessionId, "m1", [
        { type: "tool_use", id: "t1", name: "TaskCreate", input: { subject: "Write tests", description: "Cover the parser" } },
        { type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "Ship it", description: "Release" } },
      ])
    );
    emit(toolResultMessage(sessionId, "t1", "Task #1 created successfully: Write tests", { toolUseResult: { task: { id: "1", subject: "Write tests" } } }));
    emit(toolResultMessage(sessionId, "t2", "Task #2 created successfully: Ship it", { toolUseResult: { task: { id: "2", subject: "Ship it" } } }));
    emit(assistantMessage(sessionId, "m2", [{ type: "tool_use", id: "t3", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }]));
    emit(toolResultMessage(sessionId, "t3", "Updated task #1 status", { toolUseResult: { success: true, taskId: "1", updatedFields: ["status"] } }));
    emit(assistantMessage(sessionId, "m3", [{ type: "text", text: "Tasks updated." }]));
    emit(resultMessage(sessionId));
  });
  const root = workspaceRoot("tasks");
  const { callbacks, appended } = createCallbacks({ root });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "plan it", userMessageId: "u1" });
  const toolCalls = eventsOfKind(appended, "tool_call");
  assert.deepEqual(toolCalls.map((call) => call.toolKind), ["todo", "todo", "todo"]);
  assert.equal(toolCalls[0]!.title, "Add task · Write tests");
  assert.equal(toolCalls[2]!.title, "Complete task #1");
  const plans = eventsOfKind(appended, "plan");
  assert.ok(plans.length >= 2, "plan emitted on create and on update");
  const last = plans[plans.length - 1]!;
  assert.deepEqual(
    last.entries.map((entry) => `${entry.id}:${entry.status}:${entry.content}`),
    ["1:completed:Write tests", "2:pending:Ship it"]
  );
  assert.ok(eventsOfKind(appended, "plan_file").length >= 1, "plan file mirrored to .cesium/plans");
  await handle.dispose();
});

test("permission prompts round-trip through Cesium and remembered rules persist", async () => {
  let permissionResult: unknown = null;
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "npm test" } }]));
    permissionResult = await options.canUseTool!(
      "Bash",
      { command: "npm test" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_bash",
        requestId: "req-1",
        title: "Claude wants to run npm test",
        displayName: "Run command",
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }],
      }
    );
    emit(toolResultMessage(sessionId, "toolu_bash", "ok"));
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "Tests pass." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("perm") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "run tests", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_permission", "permission prompt");
  const request = eventsOfKind(appended, "permission_request")[0]!;
  assert.equal(request.title, "Claude wants to run npm test");
  assert.equal(conversation().pendingPermission?.permission, "terminal");
  assert.deepEqual(
    request.options.map((option) => option.optionId),
    ["allow_once", "allow_always", "reject_once", "reject_always"]
  );
  await handle.answerPermission({ requestId: request.requestId, optionId: "allow_always" });
  await promptPromise;
  assert.deepEqual(permissionResult, {
    behavior: "allow",
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }],
  });
  assert.equal(eventsOfKind(appended, "permission_resolved")[0]!.optionId, "allow_always");
  assert.equal(conversation().status, "idle");
  assert.equal(conversation().pendingPermission, null);
  await handle.dispose();

  // The remembered rule now auto-allows the same command without a prompt.
  let secondResult: unknown = null;
  const fake2 = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    secondResult = await options.canUseTool!("Bash", { command: "npm test" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_bash2",
      requestId: "req-2",
    });
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "ok" }]));
    emit(resultMessage(sessionId));
  });
  const second = createCallbacks({ root: workspaceRoot("perm") });
  const handle2 = await providerWith(fake2.queryFn).startSession(second.callbacks);
  await handle2.prompt({ text: "again", userMessageId: "u2" });
  assert.equal((secondResult as { behavior: string }).behavior, "allow");
  assert.equal(eventsOfKind(second.appended, "permission_request").length, 0);
  await handle2.dispose();
});

test("AskUserQuestion becomes a Cesium question card and answers flow back as updatedInput", async () => {
  let permissionResult: unknown = null;
  const questions = [
    {
      question: "Do you prefer tabs or spaces?",
      header: "Indent",
      multiSelect: false,
      options: [
        { label: "Tabs", description: "Tab characters" },
        { label: "Spaces", description: "Space characters" },
      ],
    },
    {
      question: "Which features do you want?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "Linting", description: "" },
        { label: "Formatting", description: "" },
      ],
    },
  ];
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions } }]));
    permissionResult = await options.canUseTool!("AskUserQuestion", { questions }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req-q",
    });
    emit(toolResultMessage(sessionId, "toolu_q", "Your questions have been answered", { toolUseResult: permissionResult }));
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "Great, tabs it is." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("question") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "ask me", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_question", "question prompt");
  const question = eventsOfKind(appended, "question")[0]!;
  assert.equal(question.status, "pending");
  assert.equal(question.questions?.length, 2);
  assert.equal(question.questions?.[1]?.allowMultiple, true);
  assert.deepEqual(question.options.map((option) => option.label), ["Tabs", "Spaces"]);
  assert.equal(conversation().pendingQuestion?.questionId, question.questionId);
  assert.equal(typeof handle.answerQuestion, "function");
  await handle.answerQuestion!({
    questionId: question.questionId,
    answer: "Do you prefer tabs or spaces?: Tabs\nWhich features do you want?: Linting, Formatting",
  });
  await promptPromise;
  const result = permissionResult as { behavior: string; updatedInput: Record<string, unknown> };
  assert.equal(result.behavior, "allow");
  assert.deepEqual(result.updatedInput.answers, {
    "Do you prefer tabs or spaces?": "Tabs",
    "Which features do you want?": "Linting, Formatting",
  });
  const answered = eventsOfKind(appended, "question").find((event) => event.status === "answered");
  assert.ok(answered, "answered question event persisted");
  assert.equal(conversation().pendingQuestion, null);
  assert.equal(conversation().status, "idle");
  // The question tool itself still renders as a tool card so the transcript shows the round trip.
  assert.equal(eventsOfKind(appended, "tool_call")[0]!.toolKind, "question");
  await handle.dispose();
});

test("multi-turn prompts reuse one CLI process and keep the session id", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, turn }) => {
    emit(assistantMessage(sessionId, `m${turn}`, [{ type: "text", text: `Turn ${turn}` }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("multiturn") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "one", userMessageId: "u1" });
  await handle.prompt({ text: "two", userMessageId: "u2" });
  assert.equal(fake.calls.spawns, 1, "the process is reused across turns");
  assert.equal(fake.calls.received.length, 2);
  assert.equal(fake.calls.received[1]!.session_id, "fake-session-1");
  assert.deepEqual(
    eventsOfKind(appended, "assistant_message_chunk").map((chunk) => chunk.text),
    ["Turn 1", "Turn 2"]
  );
  // The init banner is only recorded once per process, not once per turn.
  assert.equal(
    eventsOfKind(appended, "status").filter((event) => /Claude Code 2\.1\.211/.test(event.detail ?? "")).length,
    1
  );
  assert.equal(conversation().status, "idle");
  await handle.dispose();
});

test("cancel interrupts the CLI, denies pending permissions, and settles as cancelled", async () => {
  let permissionResult: unknown = null;
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options, state }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_rm", name: "Bash", input: { command: "rm -rf build" } }]));
    permissionResult = await options.canUseTool!("Bash", { command: "rm -rf build" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_rm",
      requestId: "req-rm",
    });
    await state.waitForInterrupt();
    emit(resultMessage(sessionId, { subtype: "success", result: "" }));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("cancel") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "clean", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_permission", "permission prompt");
  await handle.cancel();
  await promptPromise;
  assert.equal(fake.calls.interrupts, 1);
  assert.deepEqual(permissionResult, { behavior: "deny", message: "Cancelled by the user.", interrupt: true });
  assert.equal(conversation().status, "cancelled");
  assert.equal(conversation().pendingPermission, null);
  assert.equal(conversation().lastError, null);
  const statuses = eventsOfKind(appended, "status").map((event) => event.status);
  assert.equal(statuses[statuses.length - 1], "cancelled");
  assert.ok(!statuses.includes("idle"), "a cancelled turn never reports idle");
  await handle.dispose();
});

test("cancel force-closes a CLI that ignores interrupt", async () => {
  const fake = createFakeClaudeQuery(async () => {
    await new Promise(() => undefined); // never settles: simulates a hung turn
  });
  const { callbacks, conversation } = createCallbacks({ root: workspaceRoot("cancel-hang") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "hang", userMessageId: "u1" });
  await waitFor(() => fake.calls.received.length === 1, "prompt delivered");
  await handle.cancel();
  await promptPromise;
  assert.equal(fake.calls.interrupts, 1);
  assert.equal(fake.calls.closes, 1);
  assert.equal(conversation().status, "cancelled");
  await handle.dispose();
});

test("error results fail the turn and are never masked as idle", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "Working…" }]));
    emit(
      resultMessage(sessionId, {
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Reached maximum turns (10)"],
        terminal_reason: "max_turns",
      })
    );
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("maxturns") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await assert.rejects(handle.prompt({ text: "loop", userMessageId: "u1" }), /maximum number of turns/);
  assert.equal(conversation().status, "failed");
  assert.match(conversation().lastError ?? "", /maximum number of turns.*Reached maximum turns/);
  const statuses = eventsOfKind(appended, "status").map((event) => event.status);
  assert.equal(statuses[statuses.length - 1], "failed");
  assert.ok(!statuses.includes("idle"));
  await handle.dispose();
});

test("API errors surface as descriptive failures instead of assistant text", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(
      assistantMessage(sessionId, "m1", [{ type: "text", text: "API Error: 401 invalid x-api-key" }], {
        error: "authentication_failed",
      })
    );
    emit(resultMessage(sessionId, { is_error: true, result: "API Error: 401 invalid x-api-key" }));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("apierror") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await assert.rejects(handle.prompt({ text: "hi", userMessageId: "u1" }), /Authentication failed/);
  assert.equal(eventsOfKind(appended, "assistant_message_chunk").length, 0, "error text is not rendered as a reply");
  assert.equal(conversation().status, "failed");
  assert.match(conversation().lastError ?? "", /Authentication failed/);
  await handle.dispose();
});

test("a CLI that exits before the result fails the turn with a clear message", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "partial" }]));
    throw new Error("process exited with code 1");
  });
  const { callbacks, conversation } = createCallbacks({ root: workspaceRoot("crash") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await assert.rejects(handle.prompt({ text: "hi", userMessageId: "u1" }), /exited before the turn completed: process exited with code 1/);
  assert.equal(conversation().status, "failed");
  // A new prompt after the crash spawns a fresh process instead of failing forever.
  const fake2 = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "back" }]));
    emit(resultMessage(sessionId));
  });
  const recovered = createCallbacks({ root: workspaceRoot("crash") });
  const handle2 = await providerWith(fake2.queryFn).startSession(recovered.callbacks);
  await handle2.prompt({ text: "again", userMessageId: "u2" });
  assert.equal(recovered.conversation().status, "idle");
  await handle2.dispose();
  await handle.dispose();
});

test("Agent tool calls become subagent cards with nested transcripts", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(
      assistantMessage(sessionId, "m1", [
        { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Find config files", prompt: "List every config file.", subagent_type: "Explore" } },
      ])
    );
    emit({
      type: "system",
      subtype: "task_started",
      session_id: sessionId,
      uuid: uuid(),
      task_id: "task-1",
      tool_use_id: "toolu_agent",
      description: "Find config files",
      subagent_type: "Explore",
      task_type: "local_agent",
      prompt: "List every config file.",
    });
    emit({
      ...assistantMessage(sessionId, "sub_m1", [{ type: "tool_use", id: "toolu_sub_glob", name: "Glob", input: { pattern: "**/*.json" } }]),
      parent_tool_use_id: "toolu_agent",
    });
    emit(toolResultMessage(sessionId, "toolu_sub_glob", "package.json\ntsconfig.json", { parent: "toolu_agent" }));
    emit({
      ...assistantMessage(sessionId, "sub_m2", [{ type: "text", text: "Found package.json and tsconfig.json." }]),
      parent_tool_use_id: "toolu_agent",
    });
    emit({
      type: "system",
      subtype: "task_updated",
      session_id: sessionId,
      uuid: uuid(),
      task_id: "task-1",
      patch: { status: "completed", end_time: Date.now() },
    });
    emit({
      type: "system",
      subtype: "task_notification",
      session_id: sessionId,
      uuid: uuid(),
      task_id: "task-1",
      tool_use_id: "toolu_agent",
      status: "completed",
      output_file: "/tmp/task.out",
      summary: "Found package.json and tsconfig.json.",
    });
    emit(toolResultMessage(sessionId, "toolu_agent", [{ type: "text", text: "Found package.json and tsconfig.json." }]));
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "Two config files exist." }]));
    emit(resultMessage(sessionId, { num_turns: 2 }));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("subagent") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "find configs", userMessageId: "u1" });
  assert.equal(eventsOfKind(appended, "tool_call").length, 0, "the Agent tool does not also render a generic card");
  const subagents = eventsOfKind(appended, "subagent");
  assert.ok(subagents.length >= 2);
  assert.ok(subagents.every((event) => event.subagentId === "toolu_agent"));
  const final = subagents[subagents.length - 1]!;
  assert.equal(final.status, "completed");
  assert.equal(final.title, "Find config files");
  assert.equal(final.meta, "Explore");
  const kinds = final.transcript.map((event) => event.kind);
  assert.ok(kinds.includes("user_message"), "prompt seeds the transcript");
  assert.ok(kinds.includes("tool_call"), "nested tool calls land in the transcript");
  const nestedTool = final.transcript.find((event) => event.kind === "tool_call");
  assert.equal(nestedTool && nestedTool.kind === "tool_call" ? nestedTool.status : null, "completed");
  const nestedText = final.transcript
    .filter((event) => event.kind === "assistant_message_chunk")
    .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""));
  assert.deepEqual(nestedText, ["Found package.json and tsconfig.json."], "subagent text is not duplicated by the final report");
  assert.deepEqual(
    eventsOfKind(appended, "assistant_message_chunk").map((chunk) => chunk.text),
    ["Two config files exist."],
    "subagent text stays out of the main transcript"
  );
  assert.equal(conversation().status, "idle");
  await handle.dispose();
});

test("compaction, auto-denials, and informational system events map to Cesium events", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      uuid: uuid(),
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000 },
    });
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: "/etc/passwd", content: "x" } }]));
    emit({
      type: "system",
      subtype: "permission_denied",
      session_id: sessionId,
      uuid: uuid(),
      tool_name: "Write",
      tool_use_id: "toolu_write",
      decision_reason_type: "rule",
      decision_reason: "Write(/etc/**) is denied by settings",
      message: "Permission denied",
    });
    emit(toolResultMessage(sessionId, "toolu_write", "Permission denied", { isError: true }));
    emit({ type: "system", subtype: "informational", session_id: sessionId, uuid: uuid(), content: "Stop hook blocked continuation", level: "warning" });
    emit({ type: "system", subtype: "thinking_tokens", session_id: sessionId, uuid: uuid(), estimated_tokens: 10, estimated_tokens_delta: 10 });
    emit({ type: "system", subtype: "status", session_id: sessionId, uuid: uuid(), status: "compacting" });
    emit({ type: "system", subtype: "status", session_id: sessionId, uuid: uuid(), status: "requesting" });
    emit({ type: "rate_limit_event", session_id: sessionId, uuid: uuid(), rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9 } });
    emit({ type: "rate_limit_event", session_id: sessionId, uuid: uuid(), rate_limit_info: { status: "allowed" } });
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "I could not write that file." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended } = createCallbacks({ root: workspaceRoot("systemevents") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "write it", userMessageId: "u1" });
  const compression = eventsOfKind(appended, "compression_summary");
  assert.equal(compression.length, 1);
  assert.match(compression[0]!.summary, /Automatic context compaction/);
  assert.equal(compression[0]!.estimatedTokensBefore, 150_000);
  const systems = eventsOfKind(appended, "system");
  assert.ok(systems.some((event) => event.level === "warning" && /Write was auto-denied/.test(event.text)));
  assert.ok(systems.some((event) => event.level === "warning" && /Stop hook blocked/.test(event.text)));
  assert.ok(systems.some((event) => event.level === "warning" && /Approaching Claude usage limit/.test(event.text)));
  assert.equal(systems.filter((event) => /usage limit/.test(event.text)).length, 1, "allowed rate-limit pings are silent");
  assert.ok(!systems.some((event) => /thinking_tokens/.test(event.text)), "TUI chatter is not persisted");
  const updates = eventsOfKind(appended, "tool_call_update").filter((event) => event.toolCallId === "toolu_write");
  assert.ok(updates.every((event) => event.status === "failed"));
  const compacting = eventsOfKind(appended, "status").filter((event) => event.detail === "Compacting context…");
  assert.equal(compacting.length, 1);
  await handle.dispose();
});

test("plan mode: ExitPlanMode asks for approval, mirrors the plan, and flips the mode to agent", async () => {
  let approval: unknown = null;
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: {} }]));
    approval = await options.canUseTool!("ExitPlanMode", { plan: "# Add hello\n\n1. Create hello.py" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_exit",
      requestId: "req-exit",
    });
    emit(toolResultMessage(sessionId, "toolu_exit", "User approved the plan", { toolUseResult: { plan: "# Add hello\n\n1. Create hello.py", isAgent: false } }));
    emit({ type: "system", subtype: "status", session_id: sessionId, uuid: uuid(), status: null, permissionMode: "default" });
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "Implementing now." }]));
    emit(resultMessage(sessionId));
  });
  const root = workspaceRoot("planmode");
  const { callbacks, appended, conversation } = createCallbacks({ root, mode: "plan" });
  const handle = await providerWith(fake.queryFn, { configOverrides: { mode: "plan" } }).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "plan hello", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_permission", "plan approval");
  assert.equal(fake.calls.optionsHistory[0]!.permissionMode, "plan");
  const request = eventsOfKind(appended, "permission_request")[0]!;
  assert.match(request.title ?? "", /Approve it and start implementing/);
  assert.deepEqual(request.options.map((option) => option.optionId), ["allow_once", "reject_once"]);
  await handle.answerPermission({ requestId: request.requestId, optionId: "allow_once" });
  await promptPromise;
  assert.equal((approval as { behavior: string }).behavior, "allow");
  assert.equal(conversation().config.mode, "agent", "approving the plan leaves plan mode");
  assert.equal(handle.configOptions.find((option) => option.id === "mode")?.currentValue, "agent");
  const planFiles = eventsOfKind(appended, "plan_file");
  assert.equal(planFiles.length, 1);
  assert.match(planFiles[0]!.path, /\.cesium\/plans\//);
  const reminders = eventsOfKind(appended, "system_reminder");
  assert.equal(reminders[0]?.reason, "mode");
  assert.match(reminders[0]?.text ?? "", /Plan mode/);
  await handle.dispose();
});

test("config changes apply live where the SDK allows and restart the process otherwise", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, turn }) => {
    emit(assistantMessage(sessionId, `m${turn}`, [{ type: "text", text: `t${turn}` }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, conversation } = createCallbacks({ root: workspaceRoot("config") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "one", userMessageId: "u1" });
  await handle.setConfigOption("model", "sonnet");
  assert.deepEqual(fake.calls.setModel, ["sonnet"], "model changes are applied live first");
  assert.equal(conversation().config.modelId, "sonnet");
  await handle.prompt({ text: "two", userMessageId: "u2" });
  // This test env is a third-party proxy: the subagent alias remap lives in
  // the spawn env, so a model change also rebuilds the process.
  assert.equal(fake.calls.spawns, 2, "proxy-mode model changes restart so subagent aliases follow");
  assert.equal(fake.calls.optionsHistory[1]!.model, "sonnet");
  assert.equal(fake.calls.optionsHistory[1]!.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "sonnet");
  assert.equal(fake.calls.optionsHistory[1]!.resume, "fake-session-1", "the restarted process resumes the same session");
  await handle.setConfigOption("effort", "high");
  await handle.prompt({ text: "three", userMessageId: "u3" });
  assert.equal(fake.calls.spawns, 3, "effort is a spawn-time option");
  assert.equal(fake.calls.optionsHistory[2]!.effort, "high");
  await handle.setConfigOption("mode", "ask");
  assert.deepEqual(fake.calls.setPermissionMode, ["default"]);
  await handle.prompt({ text: "four", userMessageId: "u4" });
  assert.equal(fake.calls.spawns, 4, "mode changes rebuild the tool profile");
  assert.deepEqual(fake.calls.optionsHistory[3]!.tools, toolProfileForConfig(conversation(), handle.configOptions).tools);
  assert.ok(Array.isArray(fake.calls.optionsHistory[3]!.tools) && !(fake.calls.optionsHistory[3]!.tools as string[]).includes("Write"));
  await handle.dispose();
});

test("loadSession rejects missing transcripts and startSession recovers the remembered session", async () => {
  const root = workspaceRoot("resume");
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "resumed" }]));
    emit(resultMessage(sessionId));
  });
  const missing = createCallbacks({ root, providerSessionId: "gone-session" });
  await assert.rejects(
    providerWith(fake.queryFn, { sessionFileExists: async () => false }).loadSession(missing.callbacks, "gone-session"),
    /cannot be resumed/
  );

  // Simulate a cancelled conversation: the manager cleared providerSessionId,
  // but Cesium remembers the Claude session id and the transcript still exists.
  const recovered = createCallbacks({ root });
  resetClaudeCodeSdkConversationStateCache();
  await writeClaudeCodeSdkConversationState(recovered.callbacks.workspace.id, recovered.callbacks.conversation.id, {
    sessionId: "remembered-session",
    cwd: root,
  });
  const handle = await providerWith(fake.queryFn, {
    sessionFileExists: async (sessionId) => sessionId === "remembered-session",
  }).startSession(recovered.callbacks);
  assert.equal(handle.sessionId, "remembered-session");
  assert.equal(recovered.conversation().providerSessionId, "remembered-session");
  await handle.prompt({ text: "continue", userMessageId: "u1" });
  assert.equal(fake.calls.optionsHistory[0]!.resume, "remembered-session");
  assert.ok(
    eventsOfKind(recovered.appended, "system").some((event) => /Resumed the previous Claude Code session/.test(event.text))
  );
  await handle.dispose();

  // A fresh conversation with no memory starts a brand-new session.
  const fresh = createCallbacks({ root });
  const handle2 = await providerWith(fake.queryFn, { sessionFileExists: async () => false }).startSession(fresh.callbacks);
  assert.ok(handle2.sessionId.startsWith("claude-code-sdk-pending-"));
  await handle2.prompt({ text: "new", userMessageId: "u1" });
  assert.equal(fake.calls.optionsHistory[1]!.resume, undefined);
  await handle2.dispose();
});

test("image attachments are sent as Anthropic image blocks", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "A cat." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended } = createCallbacks({ root: workspaceRoot("images") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({
    text: "what is this?",
    userMessageId: "u1",
    attachments: [
      { mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=", name: "cat.png" },
      { mimeType: "image/bmp", data: "Qk0=", name: "old.bmp" },
      { mimeType: "application/pdf", data: "", name: "doc.pdf", kind: "file", savedPath: ".cesium/file-uploads/doc.pdf" },
    ],
  });
  const content = fake.calls.received[0]!.message.content;
  assert.ok(Array.isArray(content));
  const blocks = content as Array<Record<string, unknown>>;
  assert.equal(blocks[0]!.type, "image");
  assert.deepEqual(blocks[0]!.source, { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" });
  assert.equal(blocks[1]!.type, "text");
  assert.ok(String(blocks[1]!.text).includes("what is this?"));
  assert.ok(eventsOfKind(appended, "system").some((event) => /unsupported image type: old.bmp/.test(event.text)));
  assert.ok(!eventsOfKind(appended, "system").some((event) => /not enabled/.test(event.text)));
  await handle.dispose();
});

test("plan handoff injects the plan body and mode reminders are sent once per mode", async () => {
  const root = workspaceRoot("handoff");
  mkdirSync(path.join(root, ".cesium", "plans"), { recursive: true });
  writeFileSync(path.join(root, ".cesium", "plans", "hello.md"), "# Hello plan\n\n1. Do the thing\n");
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, turn }) => {
    emit(assistantMessage(sessionId, `m${turn}`, [{ type: "text", text: "ok" }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended } = createCallbacks({ root, mode: "debug" });
  const handle = await providerWith(fake.queryFn, { configOverrides: { mode: "debug" } }).startSession(callbacks);
  await handle.prompt({ text: "first", userMessageId: "u1" });
  await handle.prompt({ text: "second", userMessageId: "u2" });
  await handle.prompt({
    text: "build it",
    userMessageId: "u3",
    planHandoff: { planPath: ".cesium/plans/hello.md", planTitle: "Hello plan" },
  });
  const reminders = eventsOfKind(appended, "system_reminder");
  assert.deepEqual(reminders.map((event) => event.reason), ["mode", "plan_handoff"]);
  assert.match(reminders[0]!.text, /Debug mode/);
  assert.match(reminders[1]!.text, /Do the thing/);
  // Mode guidance rides in the system prompt so Claude's derived titles/slugs
  // come from the user's words; only the plan handoff is appended to the turn.
  const systemPrompt = fake.calls.optionsHistory[0]!.systemPrompt as { append: string };
  assert.match(systemPrompt.append, /Debug mode/);
  assert.equal(fake.calls.received[0]!.message.content, "first");
  assert.equal(fake.calls.received[1]!.message.content, "second", "no repeated reminder for the same mode");
  assert.match(fake.calls.received[2]!.message.content as string, /^build it\n\n<system-reminder>[\s\S]*Hello plan[\s\S]*Do the thing[\s\S]*<\/system-reminder>$/);
  await handle.dispose();
});

test("query options carry the proxy env, alias remaps, and Cesium system prompt", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "ok" }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks } = createCallbacks({ root: workspaceRoot("options") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "hi", userMessageId: "u1" });
  const options = fake.calls.optionsHistory[0]!;
  assert.equal(options.env?.ANTHROPIC_BASE_URL, "https://proxy.example.test", "trailing /v1 is stripped");
  assert.equal(options.env?.ANTHROPIC_API_KEY, "test-key");
  assert.equal(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "kimi-k3", "subagent aliases route to the proxied model");
  assert.equal(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, "kimi-k3");
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  // The SDK rejects fallbackModel === model, and aliases are already remapped via env.
  assert.equal(options.fallbackModel, undefined);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.forwardSubagentText, true);
  assert.equal(options.persistSession, true);
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.equal(typeof options.canUseTool, "function");
  const systemPrompt = options.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(systemPrompt.preset, "claude_code");
  assert.match(systemPrompt.append, /Cesium/);
  assert.ok(Array.isArray(options.tools) && (options.tools as string[]).includes("AskUserQuestion"));
  assert.ok((options.tools as string[]).includes("Grep"));
  await handle.dispose();
  // Helper-level checks that don't need a session.
  const built = buildClaudeUserMessage({ text: "", attachments: [{ mimeType: "image/jpeg", data: "abc" }] });
  assert.equal(built.imageCount, 1);
  const env = claudeCodeSdkEnv("kimi-k3");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("MCP form elicitations become question cards and answers are typed back into the schema", async () => {
  let elicitationResult: unknown = null;
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "tool_use", id: "toolu_mcp", name: "mcp__github__create_issue", input: { title: "Bug" } }]));
    elicitationResult = await options.onElicitation!(
      {
        serverName: "github",
        message: "Confirm issue details",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            repository: { type: "string", title: "Repository" },
            priority: { type: "string", enum: ["low", "high"], title: "Priority" },
            notify: { type: "boolean", title: "Notify the team?" },
            count: { type: "integer", title: "How many labels?" },
          },
          required: ["repository"],
        },
      },
      { signal: new AbortController().signal }
    );
    emit(toolResultMessage(sessionId, "toolu_mcp", "Issue created"));
    emit(assistantMessage(sessionId, "m2", [{ type: "text", text: "Filed." }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("elicitation") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "file a bug", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_question", "elicitation question");
  const question = eventsOfKind(appended, "question")[0]!;
  assert.equal(question.questions?.length, 4);
  assert.deepEqual(question.questions?.[1]?.options.map((option) => option.label), ["low", "high"]);
  assert.deepEqual(question.questions?.[2]?.options.map((option) => option.label), ["Yes", "No"]);
  assert.equal(question.questions?.[0]?.options.length, 0, "free-text fields rely on the card's Other entry");
  await handle.answerQuestion!({
    questionId: question.questionId,
    answer: "Repository: acme/app\nPriority: high\nNotify the team?: Yes\nHow many labels?: 3",
  });
  await promptPromise;
  assert.deepEqual(elicitationResult, {
    action: "accept",
    content: { repository: "acme/app", priority: "high", notify: true, count: 3 },
  });
  assert.equal(eventsOfKind(appended, "tool_call")[0]!.toolKind, "mcp");
  assert.ok(eventsOfKind(appended, "status").some((event) => event.detail === "Answer sent to the MCP server."));
  assert.equal(conversation().status, "idle");
  await handle.dispose();
});

test("URL elicitations are surfaced and accepted; dismissed questions decline", async () => {
  let urlResult: unknown = null;
  let dismissedResult: unknown = null;
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, options }) => {
    urlResult = await options.onElicitation!(
      { serverName: "linear", message: "Sign in to Linear", mode: "url", url: "https://linear.app/oauth/abc", elicitationId: "e1" },
      { signal: new AbortController().signal }
    );
    dismissedResult = await options.onElicitation!(
      { serverName: "linear", message: "Which team?", mode: "form", requestedSchema: { type: "object", properties: { team: { type: "string" } } } },
      { signal: new AbortController().signal }
    );
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "ok" }]));
    emit(resultMessage(sessionId));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("elicitation-url") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  const promptPromise = handle.prompt({ text: "sync linear", userMessageId: "u1" });
  await waitFor(() => conversation().status === "awaiting_question", "form question");
  const question = eventsOfKind(appended, "question")[0]!;
  // Dismissing the card goes through the permission path with the question id.
  await handle.answerPermission({ requestId: question.questionId, cancelled: true });
  await promptPromise;
  assert.deepEqual(urlResult, { action: "accept" });
  assert.deepEqual(dismissedResult, { action: "decline" });
  assert.ok(
    eventsOfKind(appended, "system").some(
      (event) => event.level === "warning" && /linear needs authorization in your browser: https:\/\/linear.app\/oauth\/abc/.test(event.text)
    )
  );
  assert.ok(eventsOfKind(appended, "question").some((event) => event.status === "cancelled"));
  assert.equal(conversation().pendingQuestion, null);
  await handle.dispose();
});

test("creating the runtime for an in-flight prompt never downgrades the record to idle", async () => {
  // The runtime manager marks the record `running`, then creates the runtime,
  // then calls prompt(). An idle write in between arms its idle-dispose timer
  // and kills the process mid-turn (only masked in the UI, which retains it).
  let sawIdleDuringTurn = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = createFakeClaudeQuery(async ({ sessionId, emit }) => {
    emit(assistantMessage(sessionId, "m1", [{ type: "text", text: "ok" }]));
    await gate;
    emit(resultMessage(sessionId));
  });
  const { callbacks, conversation } = createCallbacks({ root: workspaceRoot("status-running") });
  await callbacks.updateConversation((current) => ({ ...current, status: "running" }));
  const originalUpdate = callbacks.updateConversation;
  callbacks.updateConversation = async (patch) => {
    const next = await originalUpdate(patch);
    if (next.status === "idle" && fake.calls.received.length > 0 && !next.lastError) {
      // idle is only legitimate once the result landed (finalizeTurn)
      sawIdleDuringTurn = sawIdleDuringTurn || !finalizing;
    }
    return next;
  };
  let finalizing = false;
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  assert.equal(conversation().status, "running", "startSession keeps the manager's running status");
  const promptPromise = handle.prompt({ text: "hi", userMessageId: "u1" });
  await waitFor(() => fake.calls.received.length === 1, "prompt delivered");
  await waitFor(() => conversation().providerSessionId === "fake-session-1", "session adopted mid-turn");
  assert.equal(conversation().status, "running", "session adoption mid-turn keeps running");
  finalizing = true;
  release();
  await promptPromise;
  assert.equal(conversation().status, "idle");
  assert.equal(sawIdleDuringTurn, false);
  await handle.dispose();

  // A stale terminal state from a previous runtime is still reset on load.
  const stale = createCallbacks({ root: workspaceRoot("status-running") });
  await stale.callbacks.updateConversation((current) => ({ ...current, status: "failed", lastError: "old" }));
  const handle2 = await providerWith(fake.queryFn).startSession(stale.callbacks);
  assert.equal(stale.conversation().status, "idle");
  assert.equal(stale.conversation().lastError, null);
  await handle2.dispose();
});

test("local slash commands: /clear placeholder results are not rendered as replies", async () => {
  const fake = createFakeClaudeQuery(async ({ sessionId, emit, turn }) => {
    if (turn === 1) {
      emit({ type: "conversation_reset", session_id: sessionId, new_conversation_id: "fresh-session", uuid: uuid() });
      emit(resultMessage("fresh-session", { result: "(no content)" }));
      return;
    }
    emit(assistantMessage("fresh-session", "m2", [{ type: "text", text: "clean slate" }]));
    emit(resultMessage("fresh-session"));
  });
  const { callbacks, appended, conversation } = createCallbacks({ root: workspaceRoot("slash") });
  const handle = await providerWith(fake.queryFn).startSession(callbacks);
  await handle.prompt({ text: "/clear", userMessageId: "u1" });
  assert.equal(eventsOfKind(appended, "assistant_message_chunk").length, 0, "placeholder result is not a reply");
  assert.ok(eventsOfKind(appended, "system").some((event) => /history was cleared/.test(event.text)));
  assert.equal(conversation().providerSessionId, "fresh-session", "the reset adopts the new session id");
  assert.equal(conversation().status, "idle");
  await handle.prompt({ text: "hello", userMessageId: "u2" });
  assert.deepEqual(eventsOfKind(appended, "assistant_message_chunk").map((chunk) => chunk.text), ["clean slate"]);
  await handle.dispose();
});
