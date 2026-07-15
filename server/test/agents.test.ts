import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationMode,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-agent-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;

process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const [
  { ensureWorkspaceRegistered },
  { AgentRuntimeManager },
  {
    readConversationSnapshot,
    readConversationRecord,
    readConversationEventsSince,
    updateConversationRecord,
  },
  { AGENT_BACKENDS },
  { agentRoutes },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/providers.js"),
  import("../src/routes/agents.js"),
]);

const testCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: true,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: false,
  supportsInlineReasoning: false,
  supportsCompletionRetry: false,
};

const testBackends: Record<AgentBackendId, AgentBackendInfo> = {
  ...AGENT_BACKENDS,
  "cesium-agent": {
    ...AGENT_BACKENDS["cesium-agent"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
  "cursor-sdk": {
    ...AGENT_BACKENDS["cursor-sdk"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
  "opencode-server": {
    ...AGENT_BACKENDS["opencode-server"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
  "gemini-acp": {
    ...AGENT_BACKENDS["gemini-acp"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
};

function buildConfigOptions(
  mode: AgentConversationMode,
  modelId: string
): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: mode,
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: modelId,
      options: [
        { value: "test-fast", name: "Test Fast" },
        { value: "test-deep", name: "Test Deep" },
      ],
    },
  ];
}

/**
 * Runtime wrappers (session recovery, goal mode, fork/handoff injection) embed
 * the actual user prompt inside <current_user_message> markers. Match fake
 * directives against that block only, the way a real model would, so transcript
 * context echoing words like "permission" cannot re-trigger directive branches.
 */
function directiveTextFromPrompt(text: string): string {
  const match = /<current_user_message>\r?\n?([\s\S]*?)\r?\n?<\/current_user_message>/.exec(text);
  return (match?.[1] ?? text).trim();
}

class FakeSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities = testCapabilities;

  private readonly callbacks: AgentRuntimeCallbacks;
  private pendingPermission:
    | {
        requestId: string;
        resolve: () => void;
        reject: (reason?: unknown) => void;
      }
    | null = null;
  private disposed = false;
  private cancelRequested = false;

  constructor(callbacks: AgentRuntimeCallbacks, sessionId: string) {
    this.callbacks = callbacks;
    this.sessionId = sessionId;
    this.configOptions = buildConfigOptions(
      callbacks.conversation.config.mode,
      callbacks.conversation.config.modelId
    );
  }

  async prompt(input: { text: string; userMessageId: string }): Promise<void> {
    if (this.disposed) {
      throw new Error("Fake ACP session has been disposed.");
    }
    this.cancelRequested = false;
    const directiveText = directiveTextFromPrompt(input.text);
    const assistantMessageId = randomUUID();
    const toolCallId = randomUUID();
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));

    await delay(20);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call",
        toolCallId,
        title: "Prepare fake workspace context",
        toolKind: "read",
        status: "in_progress",
        detail: "Scanning the fake runtime state for the active test conversation.",
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_chunk",
        messageId: assistantMessageId,
        text: `Handling: ${input.text.trim() || "hello"} `,
      },
    ]);
    if (this.cancelRequested || this.disposed) {
      return;
    }

    await delay(20);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId,
        status: "completed",
        detail: "Fake workspace context prepared.",
      },
    ]);
    if (this.cancelRequested || this.disposed) {
      return;
    }

    if (directiveText.toLowerCase().includes("late-tail")) {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: "Fake ACP request resolved before trailing provider events flushed.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
      await delay(20);
      if (this.cancelRequested || this.disposed) {
        return;
      }
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId: assistantMessageId,
          text: "late provider tail.",
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason: "end_turn",
        },
      ]);
      return;
    }

    if (directiveText.toLowerCase().includes("permission")) {
      const requestId = randomUUID();
      const options = [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once" as const,
        },
        {
          optionId: "reject-once",
          name: "Reject",
          kind: "reject_once" as const,
        },
      ];
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_request",
          requestId,
          title: "Allow the fake ACP runtime to continue?",
          options,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "awaiting_permission",
          detail: "Waiting for fake runtime permission response.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId,
          requestedAt: Date.now(),
          title: "Allow the fake ACP runtime to continue?",
          options,
        },
      }));
      await new Promise<void>((resolve, reject) => {
        this.pendingPermission = { requestId, resolve, reject };
      }).catch(() => undefined);
      if (this.cancelRequested || this.disposed) {
        return;
      }
    }

    await delay(20);
    if (this.cancelRequested || this.disposed) {
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_chunk",
        messageId: assistantMessageId,
        text: "completed.",
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: assistantMessageId,
        stopReason: "end_turn",
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "idle",
        detail: "Fake ACP prompt completed.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.pendingPermission) {
      this.pendingPermission.reject(new Error("cancelled"));
      this.pendingPermission = null;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Fake ACP prompt cancelled.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
      config: {
        ...current.config,
        mode:
          configId === "mode"
            ? ((value === "plan" || value === "ask" || value === "agent"
                ? value
                : "agent") as AgentConversationMode)
            : current.config.mode,
        modelId: configId === "model" ? value : current.config.modelId,
        modelName:
          configId === "model"
            ? this.configOptions
                .find((option) => option.id === "model")
                ?.options.find((option) => option.value === value)?.name ??
              current.config.modelName
            : current.config.modelName,
      },
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    if (!this.pendingPermission || this.pendingPermission.requestId !== input.requestId) {
      throw new Error(`Unknown fake permission request: ${input.requestId}`);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: input.cancelled ? "Permission cancelled." : `Selected ${input.optionId}.`,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
    this.pendingPermission.resolve();
    this.pendingPermission = null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pendingPermission) {
      this.pendingPermission.reject(new Error("disposed"));
      this.pendingPermission = null;
    }
  }
}

async function createFakeProvider(backendId: AgentBackendId): Promise<AgentProvider> {
  const backend = testBackends[backendId];
  return {
    backend,
    async startSession(callbacks) {
      const handle = new FakeSessionHandle(callbacks, randomUUID());
      await callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: handle.sessionId,
        configOptions: handle.configOptions,
        capabilities: handle.capabilities,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
      return handle;
    },
    async loadSession(callbacks, providerSessionId) {
      const handle = new FakeSessionHandle(callbacks, providerSessionId);
      await callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: handle.sessionId,
        configOptions: handle.configOptions,
        capabilities: handle.capabilities,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
      return handle;
    },
  };
}

const testRuntimeManager = new AgentRuntimeManager({
  backends: testBackends,
  createProvider: createFakeProvider,
  listBackends: () => Object.values(testBackends),
});

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await probe();
    if (value != null && predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

test("prompt streams and replays append-only events", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, conversation.id, "hello replay");

  const snapshot = await waitFor(
    "fake prompt completion",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some((event) => event.kind === "assistant_message_end")
  );

  assert.ok(
    snapshot.events.some((event) => event.kind === "user_message"),
    "expected stored user message"
  );
  assert.ok(
    snapshot.events.some((event) => event.kind === "assistant_message_chunk"),
    "expected streamed assistant chunks"
  );

  const replay = await readConversationEventsSince(workspace.id, conversation.id, 1);
  assert.ok(
    replay.every((event) => event.seq > 1),
    "replay should only contain events newer than the requested sequence"
  );
});

test("prompt returns fast ACK containing only the appended user event", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  const clientEventId = randomUUID();
  const clientMessageId = randomUUID();

  const ack = await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "fast ack please",
    undefined,
    { clientEventId, clientMessageId }
  );

  assert.equal(ack.events.length, 1);
  assert.equal(ack.events[0]?.kind, "user_message");
  assert.equal(ack.events[0]?.eventId, clientEventId);
  assert.equal(ack.events[0]?.messageId, clientMessageId);
  assert.equal(ack.conversation.status, "running");
});

test("idle runtime disposal waits for trailing provider events", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "opencode-server",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, conversation.id, "late-tail please");

  const snapshot = await waitFor(
    "late provider tail",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          event.text.includes("late provider tail.")
      )
  );

  assert.ok(
    snapshot.events.some((event) => event.kind === "assistant_message_end"),
    "expected trailing assistant end after provider flush"
  );
});

test("duplicate client prompt ids do not enqueue repeated follow-up prompts", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  const clientEventId = randomUUID();
  const clientMessageId = randomUUID();

  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "dedupe me",
    undefined,
    { clientEventId, clientMessageId }
  );
  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "dedupe me",
    undefined,
    { clientEventId, clientMessageId }
  );

  const record = await readConversationRecord(workspace.id, conversation.id);
  assert.equal(record?.queuedPrompts.length, 0);
});

test("permission requests persist and can be answered", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "please require permission"
  );

  const awaiting = await waitFor(
    "pending permission",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "awaiting_permission" &&
      value.conversation.pendingPermission !== null
  );
  const pending = awaiting.conversation.pendingPermission;
  assert.ok(pending, "expected a persisted pending permission");

  await testRuntimeManager.answerPermission(workspace, conversation.id, {
    requestId: pending.requestId,
    optionId: "allow-once",
  });

  const completed = await waitFor(
    "conversation completion after permission answer",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some(
        (event) =>
          event.kind === "permission_resolved" &&
          event.requestId === pending.requestId
      )
  );

  assert.equal(
    completed.conversation.pendingPermission,
    null,
    "permission should clear once answered"
  );
});

test("cancellation stops the pending turn without completion tail", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "permission then cancel"
  );

  await waitFor(
    "permission before cancellation",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => value.conversation.pendingPermission !== null
  );

  await testRuntimeManager.cancelConversation(workspace, conversation.id);
  await delay(160);

  const snapshot = await readConversationSnapshot(workspace.id, conversation.id);
  assert.ok(snapshot, "expected snapshot after cancellation");
  assert.equal(snapshot.conversation.status, "idle");
  assert.ok(
    snapshot.events.some(
      (event) => event.kind === "status" && event.status === "cancelled"
    ),
    "expected cancelled status event"
  );
});

test("prompt after cancellation starts a fresh runtime turn", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "orchestration",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "permission then stop"
  );

  const awaiting = await waitFor(
    "permission before stop",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => value.conversation.pendingPermission !== null
  );
  const stoppedSessionId = awaiting.conversation.providerSessionId;
  assert.ok(stoppedSessionId, "expected active provider session before stop");

  const stopped = await testRuntimeManager.cancelConversation(workspace, conversation.id);
  assert.equal(stopped.providerSessionId, null);
  assert.equal(stopped.queuedPrompts.length, 0);

  await testRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "continue after stop"
  );

  const completed = await waitFor(
    "fresh prompt after stop",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.providerSessionId !== null &&
      value.conversation.providerSessionId !== stoppedSessionId &&
      value.events.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          event.text.includes("Handling: continue after stop")
      )
  );

  assert.equal(completed.conversation.pendingPermission, null);
});

test("multiple conversations keep isolated event streams", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const first = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  const second = await testRuntimeManager.createConversation(workspace, {
    backendId: "opencode-server",
    mode: "plan",
    modelId: "test-deep",
    modelName: "Test Deep",
  });

  await Promise.all([
    testRuntimeManager.promptConversation(workspace, first.id, "first chat"),
    testRuntimeManager.promptConversation(workspace, second.id, "second chat"),
  ]);

  const [firstSnapshot, secondSnapshot] = await Promise.all([
    waitFor(
      "first conversation completion",
      () => readConversationSnapshot(workspace.id, first.id),
      (value) => value.conversation.status === "idle"
    ),
    waitFor(
      "second conversation completion",
      () => readConversationSnapshot(workspace.id, second.id),
      (value) => value.conversation.status === "idle"
    ),
  ]);

  assert.ok(
    firstSnapshot.events.every((event) => event.conversationId === first.id)
  );
  assert.ok(
    secondSnapshot.events.every((event) => event.conversationId === second.id)
  );
});

test("handoff copies transcript and divider without a placeholder user message", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "hello from cursor");
  await waitFor(
    "source conversation idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  const { newConversationId } = await testRuntimeManager.handoffConversation(
    workspace,
    source.id,
    "opencode-server"
  );
  assert.equal(newConversationId, source.id, "expected handoff to stay in the same chat");

  const snap = await readConversationSnapshot(workspace.id, newConversationId);
  assert.ok(snap, "expected handoff target snapshot");
  assert.equal(
    snap.conversation.config.backendId,
    "opencode-server",
    "expected handoff to update the conversation backend in place"
  );
  const kinds = snap.events.map((e) => e.kind);
  assert.ok(kinds.includes("assistant_message_chunk"), "expected transcript chunk");
  assert.ok(kinds.includes("assistant_message_end"), "expected transcript end");
  assert.ok(kinds.includes("agent_handoff"), "expected handoff marker");
  assert.equal(
    snap.events.filter((e) => e.kind === "user_message").length,
    1,
    "handoff must not inject a synthetic user_message; the client sends the first real turn"
  );
  const handoff = snap.events.find((e) => e.kind === "agent_handoff");
  assert.ok(handoff && handoff.kind === "agent_handoff");
  const transcriptEnd = snap.events.find(
    (e) => e.kind === "assistant_message_end" && e.seq === handoff.seq - 1
  );
  assert.ok(transcriptEnd, "expected hidden handoff transcript end");
  const transcriptChunk = snap.events.find(
    (e) =>
      e.kind === "assistant_message_chunk" &&
      e.messageId === transcriptEnd.messageId
  );
  assert.ok(transcriptChunk, "expected handoff transcript chunk");
  assert.ok(
    transcriptChunk.text.indexOf("User: hello from cursor") <
      transcriptChunk.text.indexOf("Assistant: Handling: hello from cursor"),
    "expected handoff transcript to preserve user-before-assistant order"
  );
  assert.ok(
    !handoff.handoffMessageId,
    "handoffMessageId is optional when there is no paired placeholder user message"
  );

  await testRuntimeManager.promptConversation(workspace, newConversationId, "continue as opencode");
  const afterPrompt = await waitFor(
    "handoff target after first user prompt",
    () => readConversationSnapshot(workspace.id, newConversationId),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some((e) => e.kind === "user_message" && e.content === "continue as opencode")
  );
  assert.ok(afterPrompt.events.some((e) => e.kind === "user_message"));
  assert.equal(
    afterPrompt.events.filter((e) => e.kind === "user_message").length,
    2,
    "expected the original and first post-handoff user turns in the same chat"
  );
  const firstRealUserMessage = afterPrompt.events.find(
    (e) => e.kind === "user_message" && e.content === "continue as opencode"
  );
  assert.ok(firstRealUserMessage, "expected first real user turn after handoff");
  const seededAssistantChunk = afterPrompt.events.find(
    (e) =>
      e.kind === "assistant_message_chunk" &&
      e.seq > firstRealUserMessage.seq &&
      e.text.includes("continuing a conversation") &&
      e.text.includes("<transferred_conversation>")
  );
  assert.ok(
    seededAssistantChunk,
    "expected first target prompt to include the handoff seed context"
  );
  assert.ok(
    seededAssistantChunk.text.includes("User: hello from cursor"),
    "expected source user message in the seeded prompt"
  );
  assert.ok(
    seededAssistantChunk.text.includes("Assistant: Handling: hello from cursor"),
    "expected source assistant response in the seeded prompt"
  );
  assert.ok(
    seededAssistantChunk.text.includes("[Tool:"),
    "expected tool context in the seeded prompt"
  );
  assert.ok(
    seededAssistantChunk.text.includes("<current_user_message>\ncontinue as opencode\n</current_user_message>"),
    "expected the target user message to be appended after the transcript"
  );
});

test("consecutive handoffs coalesce superseded events and only keep the latest", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "hello from cursor");
  await waitFor(
    "source conversation idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  await testRuntimeManager.handoffConversation(workspace, source.id, "opencode-server");
  const afterFirst = await readConversationSnapshot(workspace.id, source.id);
  const firstHandoffCount = afterFirst.events.filter((e) => e.kind === "agent_handoff").length;
  assert.equal(firstHandoffCount, 1, "expected one handoff event after first handoff");

  const firstHandoff = afterFirst.events.find((e) => e.kind === "agent_handoff");
  assert.ok(firstHandoff && firstHandoff.kind === "agent_handoff");
  assert.equal(firstHandoff.turnCount, 1, "expected turnCount=1");
  assert.ok(
    typeof firstHandoff.toolCallCount === "number",
    "expected toolCallCount to be present"
  );

  await waitFor(
    "first handoff turn idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );
  await testRuntimeManager.handoffConversation(workspace, source.id, "cursor-sdk");
  const afterSecond = await readConversationSnapshot(workspace.id, source.id);
  const secondHandoffCount = afterSecond.events.filter((e) => e.kind === "agent_handoff").length;
  assert.equal(secondHandoffCount, 1, "expected only one handoff event after second handoff (superseded first deleted)");

  const secondHandoff = afterSecond.events.find((e) => e.kind === "agent_handoff");
  assert.ok(secondHandoff && secondHandoff.kind === "agent_handoff");
  assert.equal(secondHandoff.fromAgent, "opencode-server", "expected fromAgent to be the second source");
  assert.equal(secondHandoff.toAgent, "cursor-sdk", "expected toAgent to be the second target");

  await waitFor(
    "second handoff turn idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );
  await testRuntimeManager.handoffConversation(workspace, source.id, "opencode-server");
  const afterThird = await readConversationSnapshot(workspace.id, source.id);
  const thirdHandoffCount = afterThird.events.filter((e) => e.kind === "agent_handoff").length;
  assert.equal(thirdHandoffCount, 1, "expected only one handoff event after third handoff");

  const thirdHandoff = afterThird.events.find((e) => e.kind === "agent_handoff");
  assert.ok(thirdHandoff && thirdHandoff.kind === "agent_handoff");
  assert.equal(thirdHandoff.fromAgent, "cursor-sdk");
  assert.equal(thirdHandoff.toAgent, "opencode-server");

  const hiddenTranscriptCount = afterThird.events.filter((e) => {
    if (e.kind !== "assistant_message_end") return false;
    const next = afterThird.events.find((n) => n.kind === "agent_handoff" && n.seq === e.seq + 1);
    return !!next;
  }).length;
  assert.equal(hiddenTranscriptCount, 1, "expected only one hidden transcript pair after coalescing");
});

test("persisted provider sessions can be rehydrated after dropping runtime state", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, conversation.id, "warm runtime");

  // `promptConversation` returns after scheduling the async provider prompt; wait until the turn settles.
  const warmed = await waitFor(
    "prompt turn to finish",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.providerSessionId !== null,
    20_000
  );
  assert.ok(warmed.conversation.providerSessionId);

  await testRuntimeManager.disposeRuntime(conversation.id);
  await updateConversationRecord(workspace.id, conversation.id, (current) => ({
    ...current,
    status: "interrupted",
  }));

  await testRuntimeManager.ensureConversationRuntime(workspace, conversation.id);

  const resumed = await readConversationSnapshot(workspace.id, conversation.id);
  assert.ok(resumed, "expected resumed snapshot");
  assert.ok(
    resumed.conversation.providerSessionId,
    "expected persisted provider session id after rehydration"
  );
});

test("resume retries once before falling back to fresh provider session", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const loadAttempts = new Map<string, number>();
  const flakyRuntimeManager = new AgentRuntimeManager({
    backends: testBackends,
    listBackends: () => Object.values(testBackends),
    createProvider: async (backendId) => {
      const backend = testBackends[backendId];
      return {
        backend,
        async startSession(callbacks) {
          const handle = new FakeSessionHandle(callbacks, randomUUID());
          await callbacks.updateConversation((current) => ({
            ...current,
            providerSessionId: handle.sessionId,
            configOptions: handle.configOptions,
            capabilities: handle.capabilities,
            status: "idle",
            pendingPermission: null,
            lastError: null,
          }));
          return handle;
        },
        async loadSession(callbacks, providerSessionId) {
          const attempts = (loadAttempts.get(providerSessionId) ?? 0) + 1;
          loadAttempts.set(providerSessionId, attempts);
          if (attempts === 1) {
            throw new Error("Invalid params");
          }
          const handle = new FakeSessionHandle(callbacks, providerSessionId);
          await callbacks.updateConversation((current) => ({
            ...current,
            providerSessionId: handle.sessionId,
            configOptions: handle.configOptions,
            capabilities: handle.capabilities,
            status: "idle",
            pendingPermission: null,
            lastError: null,
          }));
          return handle;
        },
      } satisfies AgentProvider;
    },
  });

  const conversation = await flakyRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  await flakyRuntimeManager.promptConversation(workspace, conversation.id, "warm flaky runtime");
  const warmed = await waitFor(
    "flaky warm runtime",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.conversation.providerSessionId !== null
  );
  await flakyRuntimeManager.disposeRuntime(conversation.id);
  await updateConversationRecord(workspace.id, conversation.id, (current) => ({
    ...current,
    status: "interrupted",
  }));

  await flakyRuntimeManager.ensureConversationRuntime(workspace, conversation.id);
  const resumed = await readConversationSnapshot(workspace.id, conversation.id);
  assert.ok(resumed, "expected snapshot after retry resume");
  assert.equal(loadAttempts.get(warmed.conversation.providerSessionId ?? ""), 2);
  assert.ok(
    resumed.events.some(
      (event) =>
        event.kind === "system" &&
        event.text.includes("Recovered provider session resume after retry")
    ),
    "expected warning event recording the retry recovery path"
  );
  assert.ok(
    !resumed.events.some((event) => event.kind === "chat_fork"),
    "retry success should not enqueue transcript fork fallback"
  );
});

test("failed resume falls back to transcript-seeded fresh session", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const alwaysFailRuntimeManager = new AgentRuntimeManager({
    backends: testBackends,
    listBackends: () => Object.values(testBackends),
    createProvider: async (backendId) => {
      const backend = testBackends[backendId];
      return {
        backend,
        async startSession(callbacks) {
          const handle = new FakeSessionHandle(callbacks, randomUUID());
          await callbacks.updateConversation((current) => ({
            ...current,
            providerSessionId: handle.sessionId,
            configOptions: handle.configOptions,
            capabilities: handle.capabilities,
            status: "idle",
            pendingPermission: null,
            lastError: null,
          }));
          return handle;
        },
        async loadSession() {
          throw new Error("Invalid params");
        },
      } satisfies AgentProvider;
    },
  });

  const conversation = await alwaysFailRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  await alwaysFailRuntimeManager.promptConversation(workspace, conversation.id, "remember this detail");
  await waitFor(
    "always-fail warm runtime",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => value.conversation.status === "idle"
  );
  await alwaysFailRuntimeManager.disposeRuntime(conversation.id);
  await updateConversationRecord(workspace.id, conversation.id, (current) => ({
    ...current,
    status: "interrupted",
  }));

  await alwaysFailRuntimeManager.promptConversation(
    workspace,
    conversation.id,
    "continue after resume failure"
  );
  const recovered = await waitFor(
    "resume fallback prompt completion",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          event.text.includes("<recovered_conversation>") &&
          event.text.includes("User: remember this detail")
      )
  );

  assert.ok(
    recovered.events.some(
      (event) =>
        event.kind === "system" &&
        event.text.includes("Could not resume the previous provider session after retry")
    ),
    "expected fallback warning when both resume attempts fail"
  );
  assert.ok(
    recovered.events.some((event) => event.kind === "chat_fork"),
    "expected chat_fork marker so future prompts can reuse transcript fallback"
  );
});

test("unsupported backends fall back to cesium defaults when legacy conversations are read", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "opencode-server",
    mode: "plan",
    modelId: "test-deep",
    modelName: "Test Deep",
  });

  await updateConversationRecord(workspace.id, conversation.id, (current) => ({
    ...current,
    status: "running",
    providerSessionId: "legacy-removed-session",
    configOptions: buildConfigOptions("agent", "test-fast"),
    pendingPermission: {
      requestId: randomUUID(),
      requestedAt: Date.now(),
      title: "Allow the legacy runtime to continue?",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
    },
    config: {
      ...current.config,
      backendId: "removed-adapter" as unknown as AgentBackendId,
      mode: "agent",
      modelId: "removed-model",
      modelName: "Removed Model",
    },
  }));

  const migrated = await readConversationSnapshot(workspace.id, conversation.id);
  assert.ok(migrated, "expected migrated snapshot");
  const fallbackBackend = AGENT_BACKENDS["cesium-agent"];
  assert.equal(migrated.conversation.config.backendId, "cesium-agent");
  assert.equal(migrated.conversation.config.modelId, fallbackBackend.defaultModelId);
  assert.equal(migrated.conversation.config.modelName, fallbackBackend.defaultModelName);
  assert.equal(migrated.conversation.config.mode, fallbackBackend.defaultMode);
  assert.equal(migrated.conversation.status, "idle");
  assert.equal(migrated.conversation.providerSessionId, null);
  assert.deepEqual(migrated.conversation.configOptions, []);
  assert.equal(migrated.conversation.pendingPermission, null);
  assert.deepEqual(migrated.conversation.capabilities, fallbackBackend.capabilities);

  await testRuntimeManager.ensureConversationRuntime(workspace, conversation.id);
  const resumed = await readConversationSnapshot(workspace.id, conversation.id);
  assert.ok(resumed, "expected resumed snapshot after fallback runtime");
  assert.equal(resumed.conversation.config.backendId, "cesium-agent");
  assert.ok(
    resumed.conversation.providerSessionId,
    "expected a fallback cesium runtime session to start"
  );
});

test("lists grouped conversation summaries across all workspaces", async () => {
  const workspaceFixturesDir = path.join(repoRoot, ".tmp-agent-workspaces");
  await fs.mkdir(workspaceFixturesDir, { recursive: true });
  const workspaceRootA = await fs.mkdtemp(path.join(workspaceFixturesDir, "workspace-a-"));
  const workspaceRootB = await fs.mkdtemp(path.join(workspaceFixturesDir, "workspace-b-"));
  const workspaceA = await ensureWorkspaceRegistered(workspaceRootA, "workspace-a");
  const workspaceB = await ensureWorkspaceRegistered(workspaceRootB, "workspace-b");
  const conversationA = await testRuntimeManager.createConversation(workspaceA, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
    title: "Cross workspace A",
  });
  const conversationB = await testRuntimeManager.createConversation(workspaceB, {
    backendId: "opencode-server",
    mode: "plan",
    modelId: "test-deep",
    modelName: "Test Deep",
    title: "Cross workspace B",
  });

  await waitFor(
    "conversation B runtime warm before permission patch",
    () => readConversationSnapshot(workspaceB.id, conversationB.id),
    (snap) =>
      snap.conversation.status === "idle" && snap.conversation.providerSessionId !== null
  );

  await updateConversationRecord(workspaceB.id, conversationB.id, (current) => ({
    ...current,
    status: "awaiting_permission",
    pendingPermission: {
      requestId: randomUUID(),
      requestedAt: Date.now(),
      title: "Allow test permission?",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
    },
  }));

  const response = await agentRoutes.request("http://test.local/api/agents/conversations/all");
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    backends: AgentBackendInfo[];
    groups: Array<{
      workspace: { id: string; name: string };
      conversations: Array<{
        id: string;
        workspaceId: string;
        title: string;
        status: string;
        backendId: string;
        mode: string;
        hasPendingPermission: boolean;
      }>;
    }>;
  };

  assert.ok(payload.backends.length >= 2);
  const groupA = payload.groups.find((group) => group.workspace.id === workspaceA.id);
  const groupB = payload.groups.find((group) => group.workspace.id === workspaceB.id);
  assert.ok(groupA, "expected workspace A group");
  assert.ok(groupB, "expected workspace B group");
  assert.equal(groupA.conversations[0]?.id, conversationA.id);
  assert.equal(groupA.conversations[0]?.workspaceId, workspaceA.id);
  assert.equal(groupA.conversations[0]?.title, "Cross workspace A");
  assert.equal(groupA.conversations[0]?.backendId, "cursor-sdk");
  assert.equal(groupA.conversations[0]?.mode, "agent");
  assert.equal(groupA.conversations[0]?.hasPendingPermission, false);
  assert.equal(groupB.conversations[0]?.id, conversationB.id);
  assert.equal(groupB.conversations[0]?.workspaceId, workspaceB.id);
  assert.equal(groupB.conversations[0]?.title, "Cross workspace B");
  assert.equal(groupB.conversations[0]?.status, "awaiting_permission");
  assert.equal(groupB.conversations[0]?.backendId, "opencode-server");
  assert.equal(groupB.conversations[0]?.mode, "plan");
  assert.equal(groupB.conversations[0]?.hasPendingPermission, true);

  await Promise.all([
    fs.rm(workspaceRootA, { recursive: true, force: true }),
    fs.rm(workspaceRootB, { recursive: true, force: true }),
  ]);
});

test("fork creates new conversation with transcript and same backend", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "hello from cursor");
  await waitFor(
    "source conversation idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  const sourceSnap = await readConversationSnapshot(workspace.id, source.id);
  const userMessage = sourceSnap.events.find((e) => e.kind === "user_message");
  assert.ok(userMessage, "expected a user message in source");

  const { conversation: forked } = await testRuntimeManager.forkConversation(
    workspace,
    source.id
  );

  assert.notEqual(forked.id, source.id, "fork should create a new conversation");
  assert.equal(
    forked.config.backendId,
    "cursor-sdk",
    "fork should keep the same backend"
  );
  assert.ok(
    forked.title.includes("(fork)"),
    "fork title should include (fork)"
  );

  const forkedSnap = await readConversationSnapshot(workspace.id, forked.id);
  assert.ok(forkedSnap, "expected fork snapshot");

  const forkEvent = forkedSnap.events.find((e) => e.kind === "chat_fork");
  assert.ok(forkEvent && forkEvent.kind === "chat_fork", "expected chat_fork marker");
  assert.equal(forkEvent.fromConversationId, source.id);
  assert.equal(forkEvent.fromAgent, "cursor-sdk");
  assert.ok(
    forkedSnap.events.some(
      (e) => e.kind === "user_message" && "inheritedInFork" in e && e.inheritedInFork
    ),
    "expected inherited source messages to be copied into the fork for display"
  );
  assert.ok(
    forkEvent.transcript.length > 0,
    "expected transcript text in fork event"
  );
  assert.ok(
    forkEvent.transcript.includes("hello from cursor"),
    "expected source user message in fork transcript"
  );

  const sourceUserMessages = sourceSnap.events.filter((e) => e.kind === "user_message");
  assert.equal(sourceUserMessages.length, 1, "source should not be modified by fork");
});

test("fork with upToMessageId truncates transcript at that message", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "first prompt");
  await waitFor(
    "first prompt idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  await testRuntimeManager.promptConversation(workspace, source.id, "second prompt");
  await waitFor(
    "second prompt idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.filter((e) => e.kind === "user_message").length === 2
  );

  const sourceSnap = await readConversationSnapshot(workspace.id, source.id);
  const userMessages = sourceSnap.events.filter((e) => e.kind === "user_message");
  assert.equal(userMessages.length, 2, "expected two user messages");

  const firstUserMessageId = userMessages[0].messageId;

  await waitFor(
    "source ready to fork (idle, no server queue)",
    () => readConversationRecord(workspace.id, source.id),
    (record) =>
      record != null &&
      record.status === "idle" &&
      (record.queuedPrompts?.length ?? 0) === 0
  );

  const { conversation: forked } = await testRuntimeManager.forkConversation(
    workspace,
    source.id,
    { upToMessageId: firstUserMessageId }
  );

  const forkedSnap = await readConversationSnapshot(workspace.id, forked.id);
  const forkEvent = forkedSnap.events.find((e) => e.kind === "chat_fork");
  assert.ok(forkEvent && forkEvent.kind === "chat_fork");
  assert.equal(forkEvent.upToMessageId, firstUserMessageId);
  assert.ok(
    forkEvent.transcript.includes("first prompt"),
    "expected first prompt in fork transcript"
  );
  assert.ok(
    !forkEvent.transcript.includes("second prompt"),
    "second prompt should be excluded from fork transcript"
  );
});

test("fork does not write any marker to source conversation", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "opencode-server",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "hello before fork");
  await waitFor(
    "source idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  const preForkSnap = await readConversationSnapshot(workspace.id, source.id);
  const preForkKinds = preForkSnap.events.map((e) => e.kind);

  await testRuntimeManager.forkConversation(workspace, source.id);

  const postForkSnap = await readConversationSnapshot(workspace.id, source.id);
  const postForkKinds = postForkSnap.events.map((e) => e.kind);

  assert.deepEqual(
    preForkKinds,
    postForkKinds,
    "source conversation events should be unchanged after fork"
  );
});

test("fork injects transcript on first prompt via resolvePendingForkContext", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const source = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-sdk",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, source.id, "hello from source");
  await waitFor(
    "source idle",
    () => readConversationSnapshot(workspace.id, source.id),
    (value) => value.conversation.status === "idle"
  );

  const { conversation: forked } = await testRuntimeManager.forkConversation(
    workspace,
    source.id
  );

  await testRuntimeManager.promptConversation(
    workspace,
    forked.id,
    "continue in fork"
  );
  const afterPrompt = await waitFor(
    "fork first prompt completion",
    () => readConversationSnapshot(workspace.id, forked.id),
    (value) =>
      value.conversation.status === "idle" &&
      value.events.some((e) => e.kind === "user_message" && e.content === "continue in fork")
  );

  const forkUserMessages = afterPrompt.events.filter((e) => e.kind === "user_message");
  const inherited = forkUserMessages.filter(
    (e) => "inheritedInFork" in e && e.inheritedInFork
  );
  const newPostFork = forkUserMessages.filter(
    (e) => !("inheritedInFork" in e) || !e.inheritedInFork
  );
  assert.equal(inherited.length, 1, "fork should materialize the source user turn");
  assert.equal(
    newPostFork.length,
    1,
    "expected exactly the new post-fork user message"
  );
  const firstNewUser = newPostFork[0]!;

  const seededAssistantChunk = afterPrompt.events.find(
    (e) =>
      e.kind === "assistant_message_chunk" &&
      e.seq > firstNewUser.seq &&
      e.text.includes("<forked_conversation>")
  );
  assert.ok(
    seededAssistantChunk,
    "expected first fork prompt to include the forked_conversation seed context"
  );
  assert.ok(
    seededAssistantChunk.text.includes("User: hello from source"),
    "expected source user message in the seeded prompt"
  );
  assert.ok(
    seededAssistantChunk.text.includes("Assistant: Handling: hello from source"),
    "expected source assistant response in the seeded prompt"
  );
  assert.ok(
    seededAssistantChunk.text.includes("<current_user_message>\ncontinue in fork\n</current_user_message>"),
    "expected the fork user message to be appended after the transcript"
  );
});

test("archived createConversationWithPrompt does not fail with unknown conversation", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const childSnapshot = await testRuntimeManager.createConversationWithPrompt(
    workspace,
    {
      title: "Issue child",
      archived: true,
      backendId: "cursor-sdk",
      mode: "agent",
      modelId: "test-fast",
      modelName: "Test Fast",
    },
    { text: "Work on the assigned issue." }
  );

  const record = await readConversationRecord(workspace.id, childSnapshot.conversation.id);
  assert.ok(record, "expected archived child conversation to persist");
  assert.ok(record.archivedAt != null, "expected archived child conversation");

  const snapshot = await waitFor(
    "archived child prompt",
    () => readConversationSnapshot(workspace.id, childSnapshot.conversation.id),
    (value) =>
      value.events.some((event) => event.kind === "user_message") &&
      !value.events.some(
        (event) =>
          event.kind === "assistant_message_chunk" &&
          /failed to start: Unknown conversation/i.test(event.text)
      )
  );

  assert.ok(
    snapshot.events.some((event) => event.kind === "user_message"),
    "expected child prompt to be stored"
  );
});
