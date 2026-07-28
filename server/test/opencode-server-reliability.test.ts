import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-rel-"));
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
// Keep the harness diagnostics file writer quiet during unit tests.
process.env.OPENCURSOR_HARNESS_DIAGNOSTICS = "0";

const [
  { AGENT_BACKENDS },
  { createOpenCodeServerProvider },
  { OpenCodeServerError },
  { extractOpenCodeEventSessionId },
  { readHarnessDiagnostics, resetHarnessDiagnosticsForTests },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/opencode-server-provider.js"),
  import("../src/lib/agents/opencode-server-client.js"),
  import("../src/lib/agents/opencode-global-sse.js"),
  import("../src/lib/agents/harness-diagnostics.js"),
]);

import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type {
  OpenCodeServerConnection,
  OpenCodeServerProcessExit,
} from "../src/lib/agents/opencode-server-process.js";
import type { OpenCodeServerEvent } from "../src/lib/agents/opencode-server-events.js";

const BACKEND = AGENT_BACKENDS["opencode-server"];
const ROOT_SESSION = "ses_root";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await sleep(10);
  }
}

function baseConversation(id: string): AgentConversationRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id,
    workspaceId: "ws-test",
    title: "Test chat",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "opencode-server",
      mode: "agent",
      modelId: "auto",
      modelName: "Auto",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: BACKEND.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
}

type FakeClientBehavior = {
  listMessages?: () => Promise<Array<{ info?: Record<string, unknown>; parts?: Record<string, unknown>[] }>>;
  answerPermission?: (
    sessionId: string,
    permissionId: string,
    body: Record<string, unknown>
  ) => Promise<boolean>;
  listPermissions?: () => Promise<Record<string, unknown>[]>;
};

function createHarnessTestRig(options: {
  conversationId: string;
  behavior?: FakeClientBehavior;
}) {
  let conversation = baseConversation(options.conversationId);
  const appended: AgentEventInput[] = [];
  const answerPermissionCalls: Array<{ sessionId: string; permissionId: string; body: Record<string, unknown> }> = [];
  let seq = 0;
  let exitListener: ((exit: OpenCodeServerProcessExit) => void) | null = null;
  let pushEvent: ((event: OpenCodeServerEvent) => void | Promise<void>) | null = null;
  let pushStreamError: ((error: Error) => void | Promise<void>) | null = null;

  const client = {
    baseUrl: "http://127.0.0.1:0",
    headers: () => ({}),
    createSession: async () => ({ id: ROOT_SESSION }),
    getSession: async (id: string) => ({ id }),
    sendPromptAsync: async () => null,
    sendMessage: async () => ({}),
    abortSession: async () => true,
    listMessages:
      options.behavior?.listMessages ??
      (async () => [
        {
          info: { id: "msg_provider", role: "assistant", finish: "stop", time: { completed: Date.now() } },
          parts: [{ type: "text", text: "final answer" }],
        },
      ]),
    answerPermission: async (
      sessionId: string,
      permissionId: string,
      body: Record<string, unknown>
    ) => {
      answerPermissionCalls.push({ sessionId, permissionId, body });
      if (options.behavior?.answerPermission) {
        return options.behavior.answerPermission(sessionId, permissionId, body);
      }
      return true;
    },
    listPermissions: async () => {
      if (options.behavior?.listPermissions) {
        return options.behavior.listPermissions();
      }
      return [];
    },
  };

  const connection: OpenCodeServerConnection = {
    client: client as unknown as OpenCodeServerConnection["client"],
    managed: true,
    onProcessExit: (listener) => {
      exitListener = listener;
      return () => {
        exitListener = null;
      };
    },
    dispose: async () => undefined,
  };

  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: "ws-test",
      name: "test",
      root: TEST_DATA_DIR,
      createdAt: 0,
      updatedAt: 0,
      lastOpenedAt: 0,
    },
    conversation,
    appendEvents: async (events) => {
      appended.push(...events);
      return events.map((event) => ({ ...event, seq: ++seq, createdAt: Date.now() })) as AgentStoredEvent[];
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      callbacks.conversation = conversation;
      return conversation;
    },
  };

  const provider = createOpenCodeServerProvider({
    backend: BACKEND,
    configOptions: [],
    deps: {
      connect: async () => connection,
      startEvents: (input) => {
        pushEvent = input.onEvent;
        pushStreamError = input.onError ?? null;
        return { close: () => undefined };
      },
      attachGlobalSse: () => undefined,
      detachGlobalSse: () => undefined,
    },
  });

  return {
    provider,
    callbacks,
    appended,
    answerPermissionCalls,
    conversation: () => conversation,
    emitSse: async (payload: Record<string, unknown>) => {
      assert.ok(pushEvent, "SSE stream was not started");
      await pushEvent!({ route: "/event", data: payload });
    },
    emitSseError: async (error: Error) => {
      assert.ok(pushStreamError, "SSE error handler was not registered");
      await pushStreamError!(error);
    },
    triggerProcessExit: (exit: OpenCodeServerProcessExit) => {
      assert.ok(exitListener, "process exit listener was not registered");
      exitListener!(exit);
    },
  };
}

function assistantMessageUpdated(finish?: string, id = "msg_provider"): Record<string, unknown> {
  return {
    type: "message.updated",
    properties: {
      sessionID: ROOT_SESSION,
      info: {
        id,
        role: "assistant",
        sessionID: ROOT_SESSION,
        ...(finish ? { finish } : {}),
      },
    },
  };
}

function assistantTextPartUpdated(messageId: string, partId: string, text: string): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: ROOT_SESSION,
      part: {
        id: partId,
        messageID: messageId,
        sessionID: ROOT_SESSION,
        type: "text",
        text,
      },
    },
  };
}

function permissionUpdated(id: string, sessionId = ROOT_SESSION): Record<string, unknown> {
  return {
    type: "permission.updated",
    properties: {
      sessionID: sessionId,
      permission: { id, sessionID: sessionId, title: "Run command", description: "rm -rf ./tmp" },
    },
  };
}

function setFastTimers(): void {
  process.env.OPENCODE_SERVER_FINISH_QUIET_MS = "20";
  process.env.OPENCODE_SERVER_WATCHDOG_INTERVAL_MS = "600000";
  process.env.OPENCODE_SERVER_STALL_THRESHOLD_MS = "600000";
  process.env.OPENCODE_SERVER_PERMISSION_POLL_MS = "600000";
}

test("permission arriving inside the finish quiet window defers turn completion", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-finish-race" });
  const handle = await rig.provider.startSession(rig.callbacks);

  const promptDone = handle.prompt({ text: "do something", userMessageId: "u1" });
  const promptSettled = { value: false };
  promptDone.then(
    () => {
      promptSettled.value = true;
    },
    () => {
      promptSettled.value = true;
    }
  );
  // The prompt flips into accepting SSE right after the running transition.
  await waitFor(() => rig.conversation().status === "running");
  await sleep(20);

  await rig.emitSse(assistantMessageUpdated());
  // Finish fires and schedules the quiet-window completion...
  await rig.emitSse(assistantMessageUpdated("stop"));
  // ...but a permission request lands inside the window.
  await rig.emitSse(permissionUpdated("perm_1"));

  assert.equal(rig.conversation().status, "awaiting_permission");
  assert.equal(rig.conversation().pendingPermission?.requestId, "perm_1");

  // Well past the quiet window: the turn must NOT have completed and the
  // permission prompt must still be pending.
  await sleep(120);
  assert.equal(promptSettled.value, false, "turn completed while permission was pending");
  assert.equal(rig.conversation().status, "awaiting_permission");
  assert.equal(rig.conversation().pendingPermission?.requestId, "perm_1");
  assert.ok(
    !rig.appended.some((event) => event.kind === "assistant_message_end"),
    "assistant_message_end must not be emitted while the permission is pending"
  );

  await handle.answerPermission({ requestId: "perm_1", optionId: "allow" });
  assert.equal(rig.conversation().status, "running");
  assert.equal(rig.answerPermissionCalls.length, 1);
  assert.deepEqual(rig.answerPermissionCalls[0]?.body, { response: "once" });

  // The agent resumes and finishes for real this time.
  await rig.emitSse(assistantMessageUpdated("stop"));
  await promptDone;
  assert.equal(rig.conversation().status, "idle");
  assert.ok(rig.appended.some((event) => event.kind === "assistant_message_end"));
  await handle.dispose();
});

test("permission events are processed even between turns (no active prompt)", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-out-of-turn" });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_late"));
  assert.equal(rig.conversation().status, "awaiting_permission");
  assert.equal(rig.conversation().pendingPermission?.requestId, "perm_late");
  assert.ok(
    rig.appended.some(
      (event) => event.kind === "permission_request" && event.requestId === "perm_late"
    )
  );

  await handle.answerPermission({ requestId: "perm_late", optionId: "deny" });
  assert.equal(rig.conversation().status, "idle");
  assert.equal(rig.conversation().pendingPermission, null);
  await handle.dispose();
});

test("duplicate permission events across SSE routes surface a single request", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-dup-perm" });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_dup"));
  await rig.emitSse(permissionUpdated("perm_dup"));

  const requests = rig.appended.filter(
    (event) => event.kind === "permission_request" && event.requestId === "perm_dup"
  );
  assert.equal(requests.length, 1);
  await handle.dispose();
});

test("permission replies are retried and failures keep the prompt actionable", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  let attempts = 0;
  const rig = createHarnessTestRig({
    conversationId: "conv-answer-fail",
    behavior: {
      answerPermission: async () => {
        attempts += 1;
        throw new Error("connection refused");
      },
    },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_fail"));
  assert.equal(rig.conversation().status, "awaiting_permission");

  await assert.rejects(
    handle.answerPermission({ requestId: "perm_fail", optionId: "allow" }),
    /Failed to deliver the permission response/
  );
  assert.equal(attempts, 3, "expected three delivery attempts");
  // The conversation must stay actionable instead of pretending to run.
  assert.equal(rig.conversation().status, "awaiting_permission");
  assert.equal(rig.conversation().pendingPermission?.requestId, "perm_fail");
  assert.ok(
    rig.appended.some(
      (event) =>
        event.kind === "system" &&
        event.level === "error" &&
        event.text.includes("Failed to deliver the permission response")
    )
  );
  assert.ok(
    !rig.appended.some((event) => event.kind === "permission_resolved"),
    "permission must not be marked resolved when delivery failed"
  );
  await handle.dispose();
});

test("a 404 permission reply resolves locally instead of freezing", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({
    conversationId: "conv-answer-gone",
    behavior: {
      answerPermission: async () => {
        throw new OpenCodeServerError("gone", 404, "");
      },
    },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_gone"));
  await handle.answerPermission({ requestId: "perm_gone", optionId: "allow" });
  assert.equal(rig.conversation().status, "idle");
  assert.equal(rig.conversation().pendingPermission, null);
  assert.ok(
    rig.appended.some(
      (event) => event.kind === "permission_resolved" && event.requestId === "perm_gone"
    )
  );
  await handle.dispose();
});

test("subagent permissions are answered on the child session that raised them", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-child-perm" });
  const handle = await rig.provider.startSession(rig.callbacks);

  // Child-session events reach providers via the global SSE pool.
  await (handle as unknown as {
    handleServerEvent: (data: unknown, options?: { allowChildSessionEvents?: boolean }) => Promise<void>;
  }).handleServerEvent(permissionUpdated("perm_child", "ses_child"), {
    allowChildSessionEvents: true,
  });
  assert.equal(rig.conversation().pendingPermission?.requestId, "perm_child");

  await handle.answerPermission({ requestId: "perm_child", optionId: "allow" });
  assert.equal(rig.answerPermissionCalls[0]?.sessionId, "ses_child");
  await handle.dispose();
});

test("watchdog reconciles a turn whose finish event was lost", async () => {
  resetHarnessDiagnosticsForTests();
  process.env.OPENCODE_SERVER_FINISH_QUIET_MS = "20";
  process.env.OPENCODE_SERVER_WATCHDOG_INTERVAL_MS = "30";
  process.env.OPENCODE_SERVER_STALL_THRESHOLD_MS = "60";
  const rig = createHarnessTestRig({ conversationId: "conv-watchdog" });
  const handle = await rig.provider.startSession(rig.callbacks);

  // No SSE events at all: the finish notification is "lost".
  await handle.prompt({ text: "hello", userMessageId: "u1" });

  assert.equal(rig.conversation().status, "idle");
  assert.ok(rig.appended.some((event) => event.kind === "assistant_message_end"));
  assert.ok(
    rig.appended.some(
      (event) => event.kind === "assistant_message_chunk" && event.text.includes("final answer")
    ),
    "fallback text from the HTTP message log should be recovered"
  );
  const diagnostics = await readHarnessDiagnostics({ conversationId: "conv-watchdog" });
  assert.ok(diagnostics.some((entry) => entry.event === "watchdog.reconciled_completion"));
  await handle.dispose();
});

test("watchdog fails the turn when OpenCode becomes unreachable", async () => {
  resetHarnessDiagnosticsForTests();
  process.env.OPENCODE_SERVER_FINISH_QUIET_MS = "20";
  process.env.OPENCODE_SERVER_WATCHDOG_INTERVAL_MS = "30";
  process.env.OPENCODE_SERVER_STALL_THRESHOLD_MS = "60";
  const rig = createHarnessTestRig({
    conversationId: "conv-watchdog-dead",
    behavior: {
      listMessages: async () => {
        throw new Error("fetch failed: connection refused");
      },
    },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await assert.rejects(
    handle.prompt({ text: "hello", userMessageId: "u1" }),
    /became unreachable/
  );
  assert.equal(rig.conversation().status, "failed");
  assert.ok(rig.conversation().lastError?.includes("became unreachable"));
  await handle.dispose();
});

test("managed process exit fails the active turn immediately", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-proc-exit" });
  const handle = await rig.provider.startSession(rig.callbacks);

  const promptDone = handle.prompt({ text: "hello", userMessageId: "u1" });
  const rejection = assert.rejects(promptDone, /exited unexpectedly/);
  await waitFor(() => rig.conversation().status === "running");
  await sleep(20);
  rig.triggerProcessExit({ code: 137, signal: null });
  await rejection;
  assert.equal(rig.conversation().status, "failed");
  assert.ok(rig.conversation().lastError?.includes("exited unexpectedly"));
  await handle.dispose();
});

test("repeated SSE stream errors do not spam the conversation log", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-sse-spam" });
  const handle = await rig.provider.startSession(rig.callbacks);

  for (let i = 0; i < 6; i += 1) {
    await rig.emitSseError(new Error("stream disconnected"));
  }
  const conversationWarnings = rig.appended.filter(
    (event) => event.kind === "system" && event.text.includes("event stream error")
  );
  assert.equal(conversationWarnings.length, 1, "only the first error goes to the conversation");
  const diagnostics = await readHarnessDiagnostics({ conversationId: "conv-sse-spam" });
  assert.equal(
    diagnostics.filter((entry) => entry.event === "sse.error").length,
    6,
    "diagnostics retain every occurrence"
  );
  await handle.dispose();
});

test("global SSE session extraction routes permission events", () => {
  assert.equal(
    extractOpenCodeEventSessionId("permission.updated", {
      sessionID: "ses_child",
      permission: { id: "perm_x" },
    }),
    "ses_child"
  );
  assert.equal(
    extractOpenCodeEventSessionId("permission.updated", {
      permission: { id: "perm_x", sessionID: "ses_nested" },
    }),
    "ses_nested"
  );
  assert.equal(
    extractOpenCodeEventSessionId("permission.replied", {
      sessionID: "ses_child",
      permissionID: "perm_x",
    }),
    "ses_child"
  );
});

test("pending permissions are discovered by polling when no ask event exists", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  process.env.OPENCODE_SERVER_PERMISSION_POLL_MS = "30";
  const pending: Record<string, unknown>[] = [
    {
      id: "per_polled",
      sessionID: ROOT_SESSION,
      permission: "bash",
      patterns: ["echo hi"],
      metadata: { command: "echo hi" },
      tool: { messageID: "msg_1", callID: "call_77" },
    },
  ];
  const rig = createHarnessTestRig({
    conversationId: "conv-polled",
    behavior: { listPermissions: async () => pending },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await waitFor(() => rig.conversation().pendingPermission?.requestId === "per_polled");
  assert.equal(rig.conversation().status, "awaiting_permission");
  assert.equal(rig.conversation().pendingPermission?.toolCallId, "call_77");
  assert.equal(rig.conversation().pendingPermission?.detail, "echo hi");

  pending.length = 0;
  await handle.answerPermission({ requestId: "per_polled", optionId: "allow" });
  assert.deepEqual(rig.answerPermissionCalls[0]?.body, { response: "once" });
  assert.equal(rig.conversation().status, "idle");
  const diagnostics = await readHarnessDiagnostics({ conversationId: "conv-polled" });
  assert.ok(diagnostics.some((entry) => entry.event === "permission.discovered_by_poll"));
  await handle.dispose();
});

test("permissions resolved elsewhere are reconciled away by polling", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  process.env.OPENCODE_SERVER_PERMISSION_POLL_MS = "30";
  const pending: Record<string, unknown>[] = [
    { id: "per_gone_ext", sessionID: ROOT_SESSION, permission: "bash", metadata: { command: "ls" } },
  ];
  const rig = createHarnessTestRig({
    conversationId: "conv-poll-reconcile",
    behavior: { listPermissions: async () => [...pending] },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await waitFor(() => rig.conversation().pendingPermission?.requestId === "per_gone_ext");
  // Someone else (another client / auto-allow rule) resolves it on OpenCode.
  pending.length = 0;
  await waitFor(() => rig.conversation().pendingPermission === null);
  assert.equal(rig.conversation().status, "idle");
  assert.ok(
    rig.appended.some(
      (event) => event.kind === "permission_resolved" && event.requestId === "per_gone_ext"
    )
  );
  await handle.dispose();
});

test("modern reply format falls back to legacy allow/deny on 400", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({
    conversationId: "conv-format-fallback",
    behavior: {
      answerPermission: async (_sessionId, _permissionId, body) => {
        if (body.response === "once" || body.response === "always" || body.response === "reject") {
          throw new OpenCodeServerError('Expected "allow" | "deny"', 400, "");
        }
        return true;
      },
    },
  });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_legacy"));
  await handle.answerPermission({ requestId: "perm_legacy", optionId: "allow_always" });
  assert.equal(rig.answerPermissionCalls.length, 2);
  assert.deepEqual(rig.answerPermissionCalls[0]?.body, { response: "always" });
  assert.deepEqual(rig.answerPermissionCalls[1]?.body, { response: "allow", remember: true });
  assert.equal(rig.conversation().pendingPermission, null);
  await handle.dispose();
});

test("transient provider retry status does not fail the turn", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-retry-status" });
  const handle = await rig.provider.startSession(rig.callbacks);

  const promptDone = handle.prompt({ text: "hello", userMessageId: "u1" });
  const promptSettled = { value: false };
  promptDone.then(
    () => {
      promptSettled.value = true;
    },
    () => {
      promptSettled.value = true;
    }
  );
  await waitFor(() => rig.conversation().status === "running");
  await sleep(20);

  await rig.emitSse(assistantMessageUpdated());
  await rig.emitSse({
    type: "session.status",
    properties: {
      sessionID: ROOT_SESSION,
      status: { type: "retry", attempt: 1, message: "Internal server error", next: Date.now() + 500 },
    },
  });
  await sleep(60);
  assert.equal(promptSettled.value, false, "retry status must not fail the turn");
  assert.ok(
    rig.appended.some(
      (event) =>
        event.kind === "system" && event.text.includes("transient provider error")
    )
  );

  await rig.emitSse(assistantMessageUpdated("stop"));
  await promptDone;
  assert.equal(rig.conversation().status, "idle");

  const diagnostics = await readHarnessDiagnostics({ conversationId: "conv-retry-status" });
  assert.ok(diagnostics.some((entry) => entry.event === "session.provider_retry"));
  await handle.dispose();
});

test("hard error status still fails the turn", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-error-status" });
  const handle = await rig.provider.startSession(rig.callbacks);

  const promptDone = handle.prompt({ text: "hello", userMessageId: "u1" });
  const rejection = assert.rejects(promptDone, /model exploded/);
  await waitFor(() => rig.conversation().status === "running");
  await sleep(20);
  await rig.emitSse({
    type: "session.status",
    properties: {
      sessionID: ROOT_SESSION,
      status: { type: "error", message: "model exploded" },
    },
  });
  await rejection;
  assert.equal(rig.conversation().status, "failed");
  await handle.dispose();
});

test("tool-calls step finish does not end the turn; final text streams from the follow-up message", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-step-finish" });
  const handle = await rig.provider.startSession(rig.callbacks);

  const promptDone = handle.prompt({ text: "run a tool", userMessageId: "u1" });
  const promptSettled = { value: false };
  promptDone.then(
    () => {
      promptSettled.value = true;
    },
    () => {
      promptSettled.value = true;
    }
  );
  await waitFor(() => rig.conversation().status === "running");
  await sleep(20);

  // Step boundary: the model paused to run tools. This must NOT end the turn.
  await rig.emitSse(assistantMessageUpdated("tool-calls", "msg_step1"));
  await sleep(80);
  assert.equal(promptSettled.value, false, "tool-calls finish must not complete the turn");

  // The final answer arrives in a fresh assistant message.
  await rig.emitSse(assistantMessageUpdated(undefined, "msg_step2"));
  await rig.emitSse(assistantTextPartUpdated("msg_step2", "prt_1", "The output is harness-ok"));
  await rig.emitSse(assistantMessageUpdated("stop", "msg_step2"));
  await promptDone;

  assert.equal(rig.conversation().status, "idle");
  assert.ok(
    rig.appended.some(
      (event) =>
        event.kind === "assistant_message_chunk" && event.text.includes("The output is harness-ok")
    ),
    "final text from the follow-up assistant message must be streamed"
  );
  await handle.dispose();
});

test("external permission replies clear the pending prompt", async () => {
  resetHarnessDiagnosticsForTests();
  setFastTimers();
  const rig = createHarnessTestRig({ conversationId: "conv-external-reply" });
  const handle = await rig.provider.startSession(rig.callbacks);

  await rig.emitSse(permissionUpdated("perm_ext"));
  assert.equal(rig.conversation().status, "awaiting_permission");

  // Real OpenCode 1.18 shape: requestID + reply (older servers use permissionID + response).
  await rig.emitSse({
    type: "permission.replied",
    properties: { sessionID: ROOT_SESSION, requestID: "perm_ext", reply: "once" },
  });
  assert.equal(rig.conversation().status, "idle");
  assert.equal(rig.conversation().pendingPermission, null);
  assert.ok(
    rig.appended.some(
      (event) => event.kind === "permission_resolved" && event.requestId === "perm_ext"
    )
  );
  await handle.dispose();
});
