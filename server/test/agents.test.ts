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
  `opencursor-agent-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

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
    readConversationEventsSince,
    updateConversationRecord,
  },
  { AGENT_BACKENDS },
] = await Promise.all([
  import("../src/lib/workspace-registry.js"),
  import("../src/lib/agents/runtime-manager.js"),
  import("../src/lib/agents/session-store.js"),
  import("../src/lib/agents/providers.js"),
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
};

const testBackends: Record<AgentBackendId, AgentBackendInfo> = {
  ...AGENT_BACKENDS,
  "cursor-acp": {
    ...AGENT_BACKENDS["cursor-acp"],
    available: true,
    capabilities: testCapabilities,
    defaultMode: "agent",
    defaultModelId: "test-fast",
    defaultModelName: "Test Fast",
  },
  "opencode-acp": {
    ...AGENT_BACKENDS["opencode-acp"],
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

    if (input.text.toLowerCase().includes("permission")) {
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
    backendId: "cursor-acp",
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

test("permission requests persist and can be answered", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-acp",
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
    backendId: "cursor-acp",
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

test("multiple conversations keep isolated event streams", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const first = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-acp",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });
  const second = await testRuntimeManager.createConversation(workspace, {
    backendId: "opencode-acp",
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

test("persisted provider sessions can be rehydrated after dropping runtime state", async () => {
  const workspace = await ensureWorkspaceRegistered(repoRoot, "repo");
  const conversation = await testRuntimeManager.createConversation(workspace, {
    backendId: "cursor-acp",
    mode: "agent",
    modelId: "test-fast",
    modelName: "Test Fast",
  });

  await testRuntimeManager.promptConversation(workspace, conversation.id, "warm runtime");

  const warmed = await waitFor(
    "provider session to exist",
    () => readConversationSnapshot(workspace.id, conversation.id),
    (value) => value.conversation.providerSessionId !== null
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
