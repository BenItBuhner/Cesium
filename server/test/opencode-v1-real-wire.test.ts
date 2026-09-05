/**
 * OpenCode Current (1.x legacy API) – tests driven by the REAL wire format.
 *
 * Fixtures under `fixtures/opencode-v1/` are verbatim captures of the
 * directory-scoped `/event` stream and the `/global/event` stream from
 * `opencode serve` 1.18.29 running a real model. They pin what the shipped
 * server does: every event is published to BOTH streams, assistant text arrives
 * as `message.part.delta` frames before the full part, subagent children share
 * the directory stream, and permission asks are `permission.asked` rows.
 */
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-v1-real-"));
delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.NODE_ENV = "test";
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.OPENCURSOR_HARNESS_DIAGNOSTICS = "0";
// Keep the finish quiet window short so turns settle quickly in tests.
process.env.OPENCODE_SERVER_FINISH_QUIET_MS = "40";
process.env.OPENCODE_SERVER_PERMISSION_POLL_MS = "100000";

const [{ AGENT_BACKENDS }, { createOpenCodeServerProvider }] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/opencode-server-provider.js"),
]);
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type { OpenCodeServerConnection } from "../src/lib/agents/opencode-server-process.js";
import type { OpenCodeServerEvent } from "../src/lib/agents/opencode-server-events.js";

type Json = Record<string, unknown>;
type Fixture = {
  rootSessionId: string;
  childSessionIds?: string[];
  events: Json[];
  global?: Array<{ directory?: string; project?: string; payload: Json }>;
};

const BACKEND = AGENT_BACKENDS["opencode-server"];
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v1");

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")) as Fixture;
}

const activeHandles: Array<{ dispose: () => Promise<void> }> = [];
after(async () => {
  for (const handle of activeHandles.splice(0)) {
    await handle.dispose().catch(() => undefined);
  }
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out: ${label}`);
    }
    await sleep(10);
  }
}

function properties(event: Json): Json {
  return (event.properties ?? {}) as Json;
}

function eventSession(event: Json): string | undefined {
  const props = properties(event);
  return (
    (props.sessionID as string | undefined) ??
    ((props.part as Json | undefined)?.sessionID as string | undefined) ??
    ((props.info as Json | undefined)?.sessionID as string | undefined)
  );
}

function createRig(input: {
  fixture: Fixture;
  listMessages?: () => Promise<Array<{ info?: Json; parts?: Json[] }>>;
  answerPermission?: (sessionId: string, permissionId: string, body: Json) => Promise<boolean>;
}) {
  const root = input.fixture.rootSessionId;
  const appended: AgentEventInput[] = [];
  const answerPermissionCalls: Array<{ sessionId: string; permissionId: string; body: Json }> = [];
  let seq = 0;
  let pushEvent: ((event: OpenCodeServerEvent) => void | Promise<void>) | null = null;
  let globalTarget: { onEvent: (directory: string, payload: Json) => Promise<void> } | null = null;
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: `conv-${root}`,
    workspaceId: "ws-real",
    title: "Real wire v1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "opencode-server", mode: "build", modelId: "techlit/kimi-k3", modelName: "Kimi K3" },
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
  let promptCount = 0;
  const client = {
    baseUrl: "http://127.0.0.1:0",
    headers: () => ({}),
    createSession: async () => ({ id: root }),
    getSession: async (id: string) => ({ id }),
    sendPromptAsync: async () => {
      promptCount += 1;
      return null;
    },
    sendMessage: async () => ({}),
    abortSession: async () => true,
    listMessages: input.listMessages ?? (async () => []),
    answerPermission: async (sessionId: string, permissionId: string, body: Json) => {
      answerPermissionCalls.push({ sessionId, permissionId, body });
      return input.answerPermission ? input.answerPermission(sessionId, permissionId, body) : true;
    },
    listPermissions: async () => [],
  };
  const connection: OpenCodeServerConnection = {
    client: client as unknown as OpenCodeServerConnection["client"],
    managed: true,
    onProcessExit: () => () => undefined,
    dispose: async () => undefined,
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: { id: "ws-real", name: "real", root: TEST_DATA_DIR, createdAt: 0, updatedAt: 0, lastOpenedAt: 0 },
    conversation,
    appendEvents: async (events) => {
      appended.push(...events);
      return events.map((event) => ({ ...event, seq: ++seq, createdAt: Date.now() })) as AgentStoredEvent[];
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation = typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      callbacks.conversation = conversation;
      return conversation;
    },
  };
  const provider = createOpenCodeServerProvider({
    backend: BACKEND,
    configOptions: [],
    deps: {
      connect: async () => connection,
      startEvents: (options) => {
        pushEvent = options.onEvent;
        return { close: () => undefined };
      },
      attachGlobalSse: (_poolKey, _registrationId, target) => {
        globalTarget = target as typeof globalTarget;
      },
      detachGlobalSse: () => undefined,
    },
  });
  return {
    appended,
    answerPermissionCalls,
    conversation: () => conversation,
    startSession: async () => {
      const handle = await provider.startSession(callbacks);
      activeHandles.push(handle);
      return handle;
    },
    /** Resolves once prompt() has handed the prompt to the server and is listening for SSE. */
    promptSent: (count = 1) => waitFor(() => promptCount >= count, `prompt #${count} sent`),
    emitEvent: async (payload: Json) => {
      assert.ok(pushEvent, "SSE stream not started");
      await pushEvent!({ route: "/event", data: payload });
    },
    emitGlobal: async (directory: string, payload: Json) => {
      assert.ok(globalTarget, "global SSE not attached");
      await globalTarget!.onEvent(directory, payload);
    },
    toolTraces: () => {
      const traces = new Map<string, { statuses: string[]; child?: string; title?: string; detail?: string }>();
      for (const event of appended) {
        if (event.kind !== "tool_call" && event.kind !== "tool_call_update") continue;
        const trace = traces.get(event.toolCallId) ?? { statuses: [] };
        trace.statuses.push(event.status);
        if (event.title) trace.title = event.title;
        if (event.detail) trace.detail = event.detail;
        if (event.openCodeSubagentSessionId) trace.child = event.openCodeSubagentSessionId;
        traces.set(event.toolCallId, trace);
      }
      return traces;
    },
    text: (messageId: string) =>
      appended
        .filter((event) => event.kind === "assistant_message_chunk" && event.messageId === messageId)
        .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""))
        .join(""),
  };
}

test("1.x write/edit parts render diff previews from metadata.diff or the written content", async () => {
  const { normalizeOpenCodeServerEvent } = await import("../src/lib/agents/opencode-server-normalize.js");
  const root = "ses_write";
  const part = (state: Json) => ({
    type: "message.part.updated",
    properties: {
      sessionID: root,
      part: { id: "prt_w", messageID: "msg_w", sessionID: root, type: "tool", tool: "write", callID: "call_w", state },
    },
  });
  // Shape produced by opencode 1.18.29's write tool (createTwoFilesPatch output in metadata.diff).
  const withDiff = normalizeOpenCodeServerEvent({
    conversationId: "conv",
    rootSessionId: root,
    payload: part({
      status: "completed",
      input: { filePath: "notes.txt", content: "alpha\ngamma\n" },
      output: "",
      title: "notes.txt",
      metadata: {
        filepath: "/ws/notes.txt",
        exists: true,
        diff: "Index: /ws/notes.txt\n===================================================================\n--- /ws/notes.txt\n+++ /ws/notes.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n",
      },
    }),
  });
  const diffEvent = withDiff[0]!;
  assert.equal(diffEvent.kind, "tool_call_update");
  const diffPreview = diffEvent.kind === "tool_call_update" ? diffEvent.editPreview : undefined;
  assert.ok(diffPreview, "metadata.diff produces a preview");
  assert.equal(diffPreview!.addedLines, 1);
  assert.equal(diffPreview!.removedLines, 1);
  assert.ok(diffPreview!.lines.some((line) => line.kind === "remove" && line.text === "beta"));
  assert.ok(diffPreview!.lines.some((line) => line.kind === "add" && line.text === "gamma"));

  // Pending/running write: only the input is known -> all-added preview of the new content.
  const pending = normalizeOpenCodeServerEvent({
    conversationId: "conv",
    rootSessionId: root,
    payload: part({ status: "running", input: { filePath: "notes.txt", content: "alpha\nbeta\n" } }),
  });
  const runningPreview = pending[0]!.kind === "tool_call_update" ? pending[0]!.editPreview : undefined;
  assert.ok(runningPreview, "write input renders a preview before completion");
  assert.equal(runningPreview!.addedLines, 2);
  assert.deepEqual(pending[0]!.kind === "tool_call_update" && pending[0]!.locations, [{ path: "notes.txt" }]);
});

test("real 1.18.29 bash turn: one monotonic tool card and streamed text from delta frames", async () => {
  const fixture = loadFixture("bash-turn");
  const rig = createRig({ fixture });
  const handle = await rig.startSession();
  const prompt = handle.prompt({ text: "run it", userMessageId: "user-1" });
  await rig.promptSent();
  for (const event of fixture.events) {
    await rig.emitEvent(event);
  }
  await prompt;
  assert.equal(rig.conversation().status, "idle");
  const traces = rig.toolTraces();
  assert.equal(traces.size, 1, `expected one tool card, got ${[...traces.keys()].join(", ")}`);
  const [trace] = [...traces.values()];
  assert.equal(trace!.statuses[0], "pending");
  assert.equal(trace!.statuses.at(-1), "completed");
  assert.equal(trace!.statuses.filter((status) => status === "completed").length, 1);
  const completedIndex = trace!.statuses.indexOf("completed");
  assert.ok(
    trace!.statuses.slice(completedIndex).every((status) => status === "completed"),
    `status regressed after completion: ${trace!.statuses.join(">")}`
  );
  assert.match(trace!.detail ?? "", /hello-from-v1/);
  const chunks = rig.appended.filter(
    (event) => event.kind === "assistant_message_chunk" && event.messageId === "opencode-server-user-1"
  );
  // Two delta frames in the capture ("hello-from-v1\n" then "1788585692") stream
  // as two chunks; the final full-part snapshot must not add a third copy.
  assert.equal(chunks.length, 2, JSON.stringify(chunks.map((c) => (c.kind === "assistant_message_chunk" ? c.text : ""))));
  assert.equal(rig.text("opencode-server-user-1"), "hello-from-v1\n1788585692");
  assert.ok(rig.appended.some((event) => event.kind === "reasoning"), "reasoning deltas stream");
  assert.ok(rig.appended.some((event) => event.kind === "assistant_message_end"));
});

test("real 1.18.29 task subagent on both streams: no duplicate cards, child tool tagged, child permission routed", async () => {
  const fixture = loadFixture("task-child-permission");
  const child = fixture.childSessionIds![0]!;
  const rig = createRig({ fixture });
  const handle = await rig.startSession();
  const prompt = handle.prompt({ text: "spawn", userMessageId: "user-1" });
  prompt.catch(() => undefined);
  await rig.promptSent();
  // Interleave the two streams the way the server publishes them: the same
  // event id reaches the directory stream and the global stream.
  const globalByIndex = fixture.global ?? [];
  const max = Math.max(fixture.events.length, globalByIndex.length);
  for (let index = 0; index < max; index += 1) {
    const global = globalByIndex[index];
    if (global) await rig.emitGlobal(global.directory ?? "", global.payload);
    const event = fixture.events[index];
    if (event) await rig.emitEvent(event);
  }
  await waitFor(() => rig.conversation().status === "awaiting_permission", "child permission surfaced");
  const traces = rig.toolTraces();
  const taskCard = [...traces.entries()].find(([, trace]) => trace.title === "Run echo command" || /task/.test(trace.title ?? ""));
  assert.ok(taskCard, `task card present: ${JSON.stringify([...traces.entries()])}`);
  for (const [id, trace] of traces) {
    assert.equal(trace.statuses[0], "pending", `${id} opens pending: ${trace.statuses.join(">")}`);
    assert.equal(trace.statuses.filter((s) => s === "pending").length, 1, `${id} opened once despite dual delivery`);
  }
  const childTool = [...traces.entries()].find(([, trace]) => trace.child === child);
  assert.ok(childTool, "child bash tool tagged with the subagent session");
  assert.equal(childTool![1].statuses.at(-1), "in_progress", "child bash is blocked on permission");
  const pending = rig.conversation().pendingPermission;
  assert.ok(pending);
  assert.equal(pending.toolCallId, childTool![0], "permission points at the child's tool card");
  assert.match(pending.detail ?? "", /echo from-subagent-v1/);
  assert.match(pending.detail ?? "", /Allow Always remembers: echo \*/);
  assert.equal(
    rig.appended.filter((event) => event.kind === "permission_request").length,
    1,
    "permission surfaced once although permission.asked arrived on both streams"
  );
  await handle.answerPermission({ requestId: pending.requestId, optionId: "allow" });
  assert.deepEqual(rig.answerPermissionCalls, [
    { sessionId: child, permissionId: pending.requestId, body: { response: "once" } },
  ]);
  assert.equal(rig.conversation().status, "running");
  await handle.cancel();
  await prompt.catch(() => undefined);
});

test("synthetic background-task completion resumes the root as an autonomous turn", async () => {
  const fixture = loadFixture("bash-turn");
  const root = fixture.rootSessionId;
  const rig = createRig({
    fixture,
    listMessages: async () => [
      {
        info: { id: "msg_auto", role: "assistant", sessionID: root, finish: "stop", time: { completed: Date.now() } },
        parts: [{ id: "prt_auto_text", type: "text", text: "The background task finished: bg-output" }],
      },
    ],
  });
  const handle = await rig.startSession();
  const prompt = handle.prompt({ text: "run it", userMessageId: "user-1" });
  await rig.promptSent();
  for (const event of fixture.events) {
    await rig.emitEvent(event);
  }
  await prompt;
  assert.equal(rig.conversation().status, "idle");
  const before = rig.appended.length;

  // Real 1.18.29 shapes: the task tool injects a synthetic user prompt into the
  // parent, which opens a fresh assistant message with no client prompt.
  const inject = async (type: string, props: Json) => rig.emitEvent({ id: `evt_auto_${type}_${Math.random()}`, type, properties: { sessionID: root, ...props } });
  await inject("session.status", { status: { type: "busy" } });
  await inject("message.updated", { info: { id: "msg_synth_user", role: "user", sessionID: root, time: { created: Date.now() } } });
  await inject("message.part.updated", {
    part: {
      id: "prt_synth",
      messageID: "msg_synth_user",
      sessionID: root,
      type: "text",
      synthetic: true,
      text: '<task id="ses_child" state="completed">\n<summary>Background task completed: Run echo in background</summary>\n<task_result>\nbg-output\n</task_result>\n</task>',
    },
  });
  await inject("message.updated", { info: { id: "msg_auto", role: "assistant", sessionID: root, time: { created: Date.now() } } });
  await waitFor(() => rig.conversation().status === "running", "autonomous turn opened");
  assert.ok(
    rig.appended.slice(before).some((event) => event.kind === "system" && /Background task completed: Run echo in background/.test(event.text)),
    "synthetic completion notice surfaced"
  );
  assert.ok(
    rig.appended.slice(before).some((event) => event.kind === "status" && event.status === "running" && /resumed after background work/.test(event.detail ?? "")),
    "running status for the autonomous turn"
  );
  await inject("message.part.updated", { part: { id: "prt_auto_text", messageID: "msg_auto", sessionID: root, type: "text", text: "" } });
  await inject("message.part.delta", { messageID: "msg_auto", partID: "prt_auto_text", field: "text", delta: "The background task finished: " });
  await inject("message.part.delta", { messageID: "msg_auto", partID: "prt_auto_text", field: "text", delta: "bg-output" });
  await inject("message.part.updated", { part: { id: "prt_auto_text", messageID: "msg_auto", sessionID: root, type: "text", text: "The background task finished: bg-output" } });
  await inject("message.updated", { info: { id: "msg_auto", role: "assistant", sessionID: root, finish: "stop", time: { created: Date.now(), completed: Date.now() } } });
  await inject("session.idle", {});
  await waitFor(
    () => rig.appended.slice(before).some((event) => event.kind === "status" && event.status === "idle"),
    "autonomous turn completed"
  );
  const autonomousChunks = rig.appended.slice(before).filter(
    (event) => event.kind === "assistant_message_chunk" && event.messageId.startsWith("opencode-server-autonomous-")
  );
  assert.equal(
    autonomousChunks.map((event) => (event.kind === "assistant_message_chunk" ? event.text : "")).join(""),
    "The background task finished: bg-output"
  );
  assert.equal(autonomousChunks.length, 2, "text streamed from the two delta frames, no duplicate from the full part");
  const autonomousId = autonomousChunks[0]!.kind === "assistant_message_chunk" ? autonomousChunks[0]!.messageId : "";
  assert.ok(rig.appended.some((event) => event.kind === "assistant_message_end" && event.messageId === autonomousId));
  assert.equal(rig.conversation().status, "idle");
  // Trailing updates for the finished message must not open another turn.
  await inject("message.updated", { info: { id: "msg_auto", role: "assistant", sessionID: root, finish: "stop", time: { created: Date.now(), completed: Date.now() } } });
  await sleep(60);
  assert.equal(rig.conversation().status, "idle");
  await handle.dispose();
});
