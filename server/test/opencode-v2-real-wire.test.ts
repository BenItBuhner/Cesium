/**
 * OpenCode v2 beta – tests driven by the REAL wire format.
 *
 * The fixtures under `fixtures/opencode-v2-beta/` are verbatim `/api/event`
 * captures from `opencode2 v0.0.0-beta-19135` (`@opencode-ai/cli@beta`) running
 * a real model, so these tests pin the dialect the shipped server actually
 * speaks: tool events keyed by `data.id`, `permission.asked` (not
 * `permission.v2.asked`), subagent children announced via
 * `metadata.sessionID`, shell processes mirrored as `shell.*` events, and
 * background subagents waking the parent without a client prompt.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type {
  AgentConversationRecord,
  AgentEventInput,
  AgentRuntimeCallbacks,
} from "../src/lib/agents/types.js";

// Remembered permission rules ("Allow Always") persist under the data dir; keep
// this suite away from the developer's real Cesium state.
const TEST_DATA_DIR = path.join(os.tmpdir(), `cesium-opencode-v2-real-wire-${Date.now()}-${randomUUID().slice(0, 8)}`);
delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [
  { AGENT_BACKENDS },
  {
    OpenCodeV2EventNormalizer,
    openCodeV2ChildSessionId,
    openCodeV2PermissionRequestEvent,
    openCodeV2PermissionToolCallId,
    readOpenCodeV2PermissionRequest,
  },
  { createOpenCodeV2Provider },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/opencode-v2-normalize.js"),
  import("../src/lib/agents/opencode-v2-provider.js"),
]);

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
});

type Json = Record<string, unknown>;
type Fixture = { rootSessionId: string; events: Json[]; pendingPermissionRequestSnapshot?: Json[] };

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v2-beta");

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")) as Fixture;
}

function data(event: Json): Json {
  return (event.data ?? {}) as Json;
}

function eventSession(event: Json): string | undefined {
  return data(event).sessionID as string | undefined;
}

function replayThroughNormalizer(fixture: Fixture, rootMessageId = "msg_root"): AgentEventInput[] {
  const normalizer = new OpenCodeV2EventNormalizer();
  const out: AgentEventInput[] = [];
  for (const payload of fixture.events) {
    const sessionId = eventSession(payload);
    const childSessionId = sessionId && sessionId !== fixture.rootSessionId ? sessionId : undefined;
    out.push(
      ...normalizer.normalize({
        conversationId: "conv",
        rootSessionId: fixture.rootSessionId,
        payload,
        rootMessageId,
        childSessionId,
      })
    );
  }
  return out;
}

test("real beta shell turn: one terminal card keyed by data.id, completed with output, no duplicate shell card", () => {
  const fixture = loadFixture("shell-turn");
  const events = replayThroughNormalizer(fixture);
  const toolEvents = events.filter(
    (event) => event.kind === "tool_call" || event.kind === "tool_call_update"
  );
  assert.ok(toolEvents.length >= 3, `expected tool events, got ${JSON.stringify(events.map((e) => e.kind))}`);
  const ids = new Set(toolEvents.map((event) => (event.kind === "tool_call" || event.kind === "tool_call_update" ? event.toolCallId : "")));
  assert.equal(ids.size, 1, `expected exactly one tool card, got ${[...ids].join(", ")}`);
  const [toolCallId] = [...ids];
  assert.match(toolCallId, new RegExp(`^opencode-v2:${fixture.rootSessionId}:call_[a-f0-9]+$`));
  assert.ok(!toolCallId.startsWith("opencode-v2-shell:"), "shell.* lifecycle must not produce a second card");
  const opened = toolEvents[0]!;
  assert.equal(opened.kind, "tool_call");
  assert.equal(opened.kind === "tool_call" && opened.status, "pending");
  assert.equal(opened.kind === "tool_call" && opened.toolKind, "terminal");
  assert.equal(opened.kind === "tool_call" && opened.title, "shell");
  const final = toolEvents.at(-1)!;
  assert.equal(final.kind, "tool_call_update");
  assert.equal(final.kind === "tool_call_update" && final.status, "completed");
  assert.match((final.kind === "tool_call_update" && final.detail) || "", /hello-from-v2/);
  const rawOutput = (final.raw as Json).rawOutput as Json;
  assert.deepEqual((rawOutput.metadata as Json).exit, 0);
  assert.deepEqual(((final.raw as Json).input as Json).command, "echo hello-from-v2 && date +%s");

  const text = events
    .filter((event) => event.kind === "assistant_message_chunk")
    .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""))
    .join("");
  assert.equal(text, "hello-from-v2\n1788584798");
  assert.ok(events.some((event) => event.kind === "reasoning"), "reasoning deltas surface");
});

test("shell lifecycle events without a session never render for shells this conversation did not see created", () => {
  const fixture = loadFixture("shell-turn");
  const normalizer = new OpenCodeV2EventNormalizer();
  // On a shared server another conversation's shell exits on the same feed;
  // `shell.exited` carries only { id, exit, status }.
  const foreign = normalizer.normalize({
    conversationId: "conv",
    rootSessionId: fixture.rootSessionId,
    payload: { type: "shell.exited", data: { id: "sh_foreign", exit: 0, status: "exited" } },
    rootMessageId: "msg_root",
  });
  assert.deepEqual(foreign, []);
  // A standalone shell (no owning tool call) still renders its own card.
  const created = normalizer.normalize({
    conversationId: "conv",
    rootSessionId: fixture.rootSessionId,
    payload: { type: "shell.created", data: { info: { id: "sh_alone", status: "running", command: "top", cwd: "/ws", metadata: {} } } },
    rootMessageId: "msg_root",
  });
  assert.equal(created.length, 1);
  assert.equal(created[0]!.kind === "tool_call" && created[0]!.toolCallId, "opencode-v2-shell:sh_alone");
  const exited = normalizer.normalize({
    conversationId: "conv",
    rootSessionId: fixture.rootSessionId,
    payload: { type: "shell.exited", data: { id: "sh_alone", exit: 0, status: "exited" } },
    rootMessageId: "msg_root",
  });
  assert.equal(exited.length, 1);
  assert.equal(exited[0]!.kind === "tool_call_update" && exited[0]!.status, "completed");
  // The real capture's tool-owned shell produces neither card.
  const events = replayThroughNormalizer(fixture);
  assert.ok(!events.some((e) => (e.kind === "tool_call" || e.kind === "tool_call_update") && e.toolCallId.startsWith("opencode-v2-shell:")));
});

test("real beta permission.asked normalizes to a permission_request linked to the tool call", () => {
  const fixture = loadFixture("permission-turn");
  const asked = fixture.events.find((event) => event.type === "permission.asked")!;
  const request = readOpenCodeV2PermissionRequest(asked);
  assert.ok(request, "permission.asked recognized");
  const event = openCodeV2PermissionRequestEvent({ conversationId: "conv", request, raw: asked });
  assert.equal(event.requestId, data(asked).id);
  assert.equal(event.title, "OpenCode requests shell");
  assert.match(event.detail ?? "", /echo permission-test/);
  assert.match(event.detail ?? "", /Allow Always remembers: echo \*/);
  const source = data(asked).source as Json;
  assert.equal(event.toolCallId, `opencode-v2:${fixture.rootSessionId}:${source.id}`);
  assert.equal(openCodeV2PermissionToolCallId(data(asked)), event.toolCallId);
  // The tool card the permission points at is the same one the tool events create.
  const events = replayThroughNormalizer(fixture);
  const cardIds = new Set(
    events.flatMap((e) => (e.kind === "tool_call" || e.kind === "tool_call_update" ? [e.toolCallId] : []))
  );
  assert.ok(cardIds.has(event.toolCallId!), "permission toolCallId matches the streamed tool card id");
  assert.ok(events.some((e) => e.kind === "permission_request" && e.requestId === event.requestId));
  // Polled `/api/permission/request` rows have the identical shape.
  const polled = fixture.pendingPermissionRequestSnapshot?.[0];
  assert.ok(polled);
  assert.equal(openCodeV2PermissionRequestEvent({ conversationId: "conv", request: polled }).toolCallId, event.toolCallId);
  // The legacy pre-release alias keeps working.
  assert.ok(readOpenCodeV2PermissionRequest({ ...asked, type: "permission.v2.asked" }));
});

test("real beta foreground subagent: child linked via metadata.sessionID and child tool/text tagged", () => {
  const fixture = loadFixture("subagent-foreground");
  const progress = fixture.events.find(
    (event) => event.type === "session.tool.progress" && eventSession(event) === fixture.rootSessionId
  )!;
  const childId = openCodeV2ChildSessionId(progress);
  assert.ok(childId?.startsWith("ses_"), "child session id read from metadata.sessionID");
  assert.notEqual(childId, fixture.rootSessionId);
  const created = fixture.events.find(
    (event) => event.type === "session.created" && eventSession(event) === childId
  )!;
  assert.equal(data(created).parentID, fixture.rootSessionId, "child session.created names the parent");
  // A shell tool's progress must NOT be mistaken for a child session.
  const shellProgress = fixture.events.find(
    (event) => event.type === "session.tool.progress" && eventSession(event) === childId
  )!;
  assert.equal(openCodeV2ChildSessionId(shellProgress), undefined);

  const events = replayThroughNormalizer(fixture);
  const subagentCard = events.find(
    (event) => event.kind === "tool_call" && event.toolKind === "task"
  );
  assert.ok(subagentCard, "subagent tool renders as a task card");
  // The card opens on `session.tool.input.started` (no input yet) and picks up
  // the human label once the input has streamed.
  assert.equal(subagentCard!.kind === "tool_call" && subagentCard!.title, "subagent");
  const subagentDone = events.find(
    (event) =>
      event.kind === "tool_call_update" &&
      event.toolCallId === (subagentCard!.kind === "tool_call" ? subagentCard!.toolCallId : "") &&
      event.status === "completed"
  );
  assert.ok(subagentDone, "subagent card completes");
  assert.equal(subagentDone!.kind === "tool_call_update" && subagentDone!.title, "Run echo command");
  assert.equal(
    ((((subagentDone!.raw as Json).rawOutput as Json).metadata as Json).sessionID),
    childId
  );
  const childTool = events.find(
    (event) => event.kind === "tool_call_update" && event.status === "completed" && event.toolKind === "terminal"
  );
  assert.ok(childTool, "child shell tool surfaces");
  assert.equal(childTool!.kind === "tool_call_update" && childTool!.openCodeSubagentSessionId, childId);
  const childText = events.filter(
    (event) => event.kind === "assistant_message_chunk" && event.messageId.startsWith(`opencode-subagent:${childId}:`)
  );
  assert.ok(childText.length > 0, "child text is routed to a subagent message");
  const rootText = events
    .filter((event) => event.kind === "assistant_message_chunk" && event.messageId === "msg_root")
    .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""))
    .join("");
  assert.match(rootText, /from-subagent-fg/);
});

test("write tool calls render an all-added preview and permission asks summarize file changes", () => {
  const normalizer = new OpenCodeV2EventNormalizer();
  const root = "ses_write";
  const base = { sessionID: root, assistantMessageID: "msg_w", id: "call_write" };
  normalizer.normalize({
    conversationId: "conv",
    rootSessionId: root,
    payload: { type: "session.tool.input.started", data: { ...base, name: "write" } },
    rootMessageId: "msg_root",
  });
  // Real beta write input: { path, content } (v1 uses filePath).
  const called = normalizer.normalize({
    conversationId: "conv",
    rootSessionId: root,
    payload: {
      type: "session.tool.called",
      data: { ...base, input: { path: "notes.txt", content: "alpha\nbeta\n" }, executed: false },
    },
    rootMessageId: "msg_root",
  });
  const update = called[0]!;
  assert.equal(update.kind, "tool_call_update");
  assert.equal(update.kind === "tool_call_update" && update.toolKind, "edit");
  assert.deepEqual(update.kind === "tool_call_update" && update.locations, [{ path: "notes.txt" }]);
  const preview = update.kind === "tool_call_update" ? update.editPreview : undefined;
  assert.ok(preview, "write produces a preview from its content");
  assert.equal(preview!.addedLines, 2);
  assert.equal(preview!.removedLines, 0);
  assert.deepEqual(
    preview!.lines.filter((line) => line.kind === "add").map((line) => line.text),
    ["alpha", "beta"]
  );

  const permission = openCodeV2PermissionRequestEvent({
    conversationId: "conv",
    request: {
      id: "per_edit",
      sessionID: root,
      action: "edit",
      resources: ["/ws/notes.txt"],
      save: ["*"],
      metadata: { files: [{ file: "/ws/notes.txt", status: "added", additions: 2, deletions: 0, patch: "..." }] },
      source: { type: "tool", messageID: "msg_w", id: "call_write" },
    },
  });
  assert.equal(permission.title, "OpenCode requests edit");
  assert.match(permission.detail ?? "", /added \/ws\/notes\.txt \(\+2 -0\)/);
  assert.equal(permission.toolCallId, `opencode-v2:${root}:call_write`);
});

test("reconcileMessages emits completion for a tool whose result event was missed", () => {
  const fixture = loadFixture("shell-turn");
  const normalizer = new OpenCodeV2EventNormalizer();
  const streamed: AgentEventInput[] = [];
  for (const payload of fixture.events) {
    if (payload.type === "session.tool.success") break;
    streamed.push(
      ...normalizer.normalize({
        conversationId: "conv",
        rootSessionId: fixture.rootSessionId,
        payload,
        rootMessageId: "msg_root",
      })
    );
  }
  assert.ok(!streamed.some((e) => e.kind === "tool_call_update" && e.status === "completed"));
  const success = fixture.events.find((e) => e.type === "session.tool.success")!;
  const messages: Json[] = [
    {
      id: data(success).assistantMessageID,
      type: "assistant",
      content: [
        {
          type: "tool",
          id: data(success).id,
          name: "shell",
          executed: false,
          state: {
            status: "completed",
            input: { command: "echo hello-from-v2 && date +%s" },
            content: data(success).content,
            metadata: data(success).metadata,
          },
        },
      ],
    },
  ];
  const reconciled = normalizer.reconcileMessages({
    conversationId: "conv",
    sessionId: fixture.rootSessionId,
    messages,
  });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]!.kind, "tool_call_update");
  assert.equal(reconciled[0]!.kind === "tool_call_update" && reconciled[0]!.status, "completed");
  assert.match((reconciled[0]!.kind === "tool_call_update" && reconciled[0]!.detail) || "", /hello-from-v2/);
  // Idempotent: nothing new once the state matches.
  assert.equal(
    normalizer.reconcileMessages({ conversationId: "conv", sessionId: fixture.rootSessionId, messages }).length,
    0
  );
  // A never-streamed call opens and completes its card.
  const fresh = new OpenCodeV2EventNormalizer().reconcileMessages({
    conversationId: "conv",
    sessionId: fixture.rootSessionId,
    messages,
  });
  assert.deepEqual(
    fresh.map((e) => [e.kind, e.kind === "tool_call" || e.kind === "tool_call_update" ? e.status : ""]),
    [
      ["tool_call", "pending"],
      ["tool_call_update", "completed"],
    ]
  );
  assert.equal(fresh[0]!.kind === "tool_call" && fresh[0]!.title, "shell");
});

/* ------------------------------------------------------------------------ */
/* Full provider runs against a dummy server speaking the real beta dialect */
/* ------------------------------------------------------------------------ */

type DummyServerOptions = {
  fixture: Fixture;
  /** Events before (and including) this predicate are replayed right after the prompt; the rest wait for `resumeReplay`. */
  pauseAfter?: (event: Json) => boolean;
  /** Skip these events on the volatile stream (simulating the volatile feed dropping them). */
  drop?: (event: Json) => boolean;
  /** Close the volatile stream right after this event (client must reconnect). */
  disconnectAfter?: (event: Json) => boolean;
  messages?: () => Json[];
  pendingPermissions?: () => Json[];
  activeSessions?: () => string[];
  replayGapMs?: number;
};

type DummyServer = {
  url: string;
  close: () => Promise<void>;
  resumeReplay: () => void;
  replayFinished: Promise<void>;
  requests: Array<{ method: string; path: string; body?: Json }>;
  permissionReplies: Array<{ sessionId: string; requestId: string; body: Json }>;
  pushEvent: (event: Json) => void;
};

async function startDummyServer(options: DummyServerOptions): Promise<DummyServer> {
  const { fixture } = options;
  const root = fixture.rootSessionId;
  const eventStreams = new Set<ServerResponse>();
  const requests: DummyServer["requests"] = [];
  const permissionReplies: DummyServer["permissionReplies"] = [];
  let replayStarted = false;
  let resumeReplay: () => void = () => undefined;
  const resumed = new Promise<void>((resolve) => {
    resumeReplay = resolve;
  });
  let replayDone: () => void = () => undefined;
  const replayFinished = new Promise<void>((resolve) => {
    replayDone = resolve;
  });
  let firstExecutionSucceededResolve: () => void = () => undefined;
  const firstExecutionSucceeded = new Promise<void>((resolve) => {
    firstExecutionSucceededResolve = resolve;
  });
  let firstSucceeded = false;
  const pushEvent = (event: Json) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of eventStreams) stream.write(frame);
  };
  const replay = async () => {
    const gap = options.replayGapMs ?? 2;
    let paused = false;
    for (const event of fixture.events) {
      // The capture starts with the connection marker of the recording client;
      // this server writes its own `server.connected` per connection.
      if (event.type === "server.connected") continue;
      if (paused) {
        await resumed;
        paused = false;
      }
      if (!options.drop?.(event)) {
        pushEvent(event);
      }
      if (
        event.type === "session.execution.succeeded" &&
        eventSession(event) === root &&
        !firstSucceeded
      ) {
        firstSucceeded = true;
        firstExecutionSucceededResolve();
      }
      if (options.disconnectAfter?.(event)) {
        for (const stream of eventStreams) stream.end();
      }
      if (options.pauseAfter?.(event)) paused = true;
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
    replayDone();
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body: Json | undefined;
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      body = text ? (JSON.parse(text) as Json) : undefined;
    }
    requests.push({ method: request.method ?? "GET", path: url.pathname, ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/health") return json({ healthy: true, version: "0.0.0-beta-19135", pid: 1 });
    if (url.pathname === "/api/agent") return json({ data: [{ id: "build", name: "Build", mode: "primary" }] });
    if (url.pathname === "/api/model") {
      return json({ data: [{ id: "kimi-k3", providerID: "techlit", name: "Kimi K3", enabled: true, variants: [] }] });
    }
    if (url.pathname === "/api/session/active") {
      return json({ data: Object.fromEntries((options.activeSessions?.() ?? []).map((id) => [id, { type: "running" }])) });
    }
    if (url.pathname === "/api/permission/request") return json({ data: options.pendingPermissions?.() ?? [] });
    if (request.method === "POST" && url.pathname === "/api/session") {
      return json({ data: { id: root, model: { id: "kimi-k3", providerID: "techlit" }, location: { directory: "/ws" } } });
    }
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: `evt_conn_${eventStreams.size}`, type: "server.connected", data: {} })}\n\n`);
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/(experimental\/)?session\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch) {
      const [, experimental, sessionId, rest = ""] = sessionMatch;
      if (rest === "log") {
        // The real beta has no /api/session/:id/log (404) – only the experimental route,
        // and with `persist` off it only ever emits the synced marker.
        if (!experimental) return json({ error: "not found" }, 404);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ type: "log.synced", aggregateID: sessionId, seq: 0 })}\n\n`);
        return;
      }
      if (rest === "" && request.method === "GET") {
        const created = fixture.events.find((e) => e.type === "session.created" && eventSession(e) === sessionId);
        if (!created) return json({ error: "not found" }, 404);
        return json({ data: { id: sessionId, ...(data(created).parentID ? { parentID: data(created).parentID } : {}) } });
      }
      if (rest === "rename" || rest === "interrupt" || rest === "agent" || rest === "model") {
        response.writeHead(204).end();
        return;
      }
      if (rest === "prompt") {
        json({ data: { id: body?.id ?? "msg_user", sessionID: sessionId, type: "user" } });
        if (!replayStarted) {
          replayStarted = true;
          void replay();
        }
        return;
      }
      if (rest === "synthetic") return json({ data: { id: "msg_synthetic" } });
      if (rest === "wait") {
        await firstExecutionSucceeded;
        response.writeHead(204).end();
        return;
      }
      if (rest === "message") return json({ data: options.messages?.() ?? [], cursor: {} });
      const permissionReply = rest.match(/^permission\/([^/]+)\/reply$/);
      if (permissionReply) {
        permissionReplies.push({ sessionId, requestId: permissionReply[1]!, body: body ?? {} });
        response.writeHead(204).end();
        return;
      }
    }
    json({ error: `unhandled ${request.method} ${url.pathname}` }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    permissionReplies,
    resumeReplay: () => resumeReplay(),
    replayFinished,
    pushEvent,
    close: async () => {
      for (const stream of eventStreams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withProvider(
  dummy: DummyServer,
  run: (input: {
    handle: Awaited<ReturnType<ReturnType<typeof createOpenCodeV2Provider>["startSession"]>>;
    appended: AgentEventInput[];
    conversation: () => AgentConversationRecord;
    waitFor: (predicate: () => boolean, label: string, timeoutMs?: number) => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  const previousUrl = process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
  const previousPoll = process.env.OPENCURSOR_OPENCODE_V2_PERMISSION_POLL_MS;
  process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = dummy.url;
  process.env.OPENCURSOR_OPENCODE_V2_PERMISSION_POLL_MS = "50";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-opencode-v2-real-"));
  const workspaceId = `workspace-real-${randomUUID().slice(0, 8)}`;
  const appended: AgentEventInput[] = [];
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "conv-real",
    workspaceId,
    title: "Real wire",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventSeq: 0,
    status: "idle",
    config: { backendId: "opencode-v2-beta", mode: "build", modelId: "techlit/kimi-k3", modelName: "Kimi K3" },
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
      id: workspaceId,
      root: workspaceRoot,
      name: "Real",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    conversation,
    appendEvents: async (events) => {
      appended.push(...events);
      return events.map((event, index) => ({ ...event, seq: appended.length + index, createdAt: Date.now() })) as never;
    },
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : ({ ...conversation, ...patch } as AgentConversationRecord);
      callbacks.conversation = conversation;
      return conversation;
    },
  };
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) {
        assert.fail(`timed out waiting for ${label}; events=${JSON.stringify(appended.map((e) => e.kind))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const provider = createOpenCodeV2Provider({ backend: AGENT_BACKENDS["opencode-v2-beta"], configOptions: [] });
  let handle: Awaited<ReturnType<typeof provider.startSession>> | undefined;
  try {
    handle = await provider.startSession(callbacks);
    await run({ handle, appended, conversation: () => conversation, waitFor });
  } finally {
    await handle?.dispose().catch(() => undefined);
    if (previousUrl == null) delete process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL;
    else process.env.OPENCURSOR_OPENCODE_V2_SERVER_URL = previousUrl;
    if (previousPoll == null) delete process.env.OPENCURSOR_OPENCODE_V2_PERMISSION_POLL_MS;
    else process.env.OPENCURSOR_OPENCODE_V2_PERMISSION_POLL_MS = previousPoll;
    await dummy.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("provider: real beta shell turn completes with a single completed terminal card and final text", async () => {
  const fixture = loadFixture("shell-turn");
  const dummy = await startDummyServer({ fixture });
  await withProvider(dummy, async ({ handle, appended, conversation }) => {
    await handle.prompt({ text: "run it", userMessageId: "user-1" });
    await dummy.replayFinished;
    assert.equal(conversation().status, "idle");
    const cards = new Set(
      appended.flatMap((e) => (e.kind === "tool_call" || e.kind === "tool_call_update" ? [e.toolCallId] : []))
    );
    assert.equal(cards.size, 1, `expected one card, got ${[...cards].join(", ")}`);
    const completed = appended.find(
      (e) => e.kind === "tool_call_update" && e.status === "completed" && e.toolKind === "terminal"
    );
    assert.ok(completed, "terminal tool completed");
    assert.equal(
      appended
        .filter((e) => e.kind === "assistant_message_chunk" && e.messageId === "opencode-v2-user-1")
        .map((e) => (e.kind === "assistant_message_chunk" ? e.text : ""))
        .join(""),
      "hello-from-v2\n1788584798"
    );
    assert.ok(appended.some((e) => e.kind === "assistant_message_end" && e.messageId === "opencode-v2-user-1"));
  });
});

test("provider: real beta permission.asked pauses the turn until Cesium replies via the v2 route", async () => {
  const fixture = loadFixture("permission-turn");
  const asked = fixture.events.find((e) => e.type === "permission.asked")!;
  const requestId = data(asked).id as string;
  const dummy = await startDummyServer({
    fixture,
    pauseAfter: (event) => event.type === "permission.asked",
  });
  await withProvider(dummy, async ({ handle, appended, conversation, waitFor }) => {
    const prompt = handle.prompt({ text: "run it", userMessageId: "user-1" });
    await waitFor(() => conversation().status === "awaiting_permission", "awaiting_permission");
    assert.equal(conversation().pendingPermission?.requestId, requestId);
    assert.equal(conversation().pendingPermission?.title, "OpenCode requests shell");
    assert.match(conversation().pendingPermission?.detail ?? "", /echo permission-test/);
    const permissionEvent = appended.find((e) => e.kind === "permission_request");
    assert.ok(permissionEvent && permissionEvent.kind === "permission_request");
    assert.equal(permissionEvent.toolCallId, `opencode-v2:${fixture.rootSessionId}:${(data(asked).source as Json).id}`);
    await handle.answerPermission!({ requestId, optionId: "allow" });
    assert.deepEqual(dummy.permissionReplies, [
      { sessionId: fixture.rootSessionId, requestId, body: { reply: "once" } },
    ]);
    assert.equal(conversation().status, "running");
    dummy.resumeReplay();
    await prompt;
    await dummy.replayFinished;
    assert.equal(conversation().status, "idle");
    assert.ok(appended.some((e) => e.kind === "permission_resolved" && e.requestId === requestId));
    // Our own echoed permission.replied must not be reported as an external resolution.
    assert.equal(appended.filter((e) => e.kind === "permission_resolved" && e.requestId === requestId).length, 1);
    assert.ok(appended.some((e) => e.kind === "tool_call_update" && e.status === "completed"));
  });
});

test("provider: a permission.asked dropped by the volatile stream is recovered by polling /api/permission/request", async () => {
  const fixture = loadFixture("permission-turn");
  const asked = fixture.events.find((e) => e.type === "permission.asked")!;
  const requestId = data(asked).id as string;
  let pending: Json[] = [];
  const dummy = await startDummyServer({
    fixture,
    drop: (event) => event.type === "permission.asked",
    pauseAfter: (event) => event.type === "permission.asked",
    pendingPermissions: () => pending,
  });
  await withProvider(dummy, async ({ handle, conversation, waitFor }) => {
    const prompt = handle.prompt({ text: "run it", userMessageId: "user-1" });
    // The server is blocked on the permission; the client never saw the ask.
    await waitFor(
      () => dummy.requests.some((r) => r.path === "/api/session/" + fixture.rootSessionId + "/wait"),
      "wait request"
    );
    pending = [data(asked)];
    await waitFor(() => conversation().status === "awaiting_permission", "polled permission surfaced");
    assert.equal(conversation().pendingPermission?.requestId, requestId);
    await handle.answerPermission!({ requestId, optionId: "allow_always" });
    pending = [];
    assert.deepEqual(dummy.permissionReplies.at(-1)?.body, { reply: "always" });
    dummy.resumeReplay();
    await prompt;
    await dummy.replayFinished;
    assert.equal(conversation().status, "idle");
    assert.equal(conversation().pendingPermission, null);
  });
});

test("provider: an externally answered permission clears the Cesium prompt", async () => {
  const fixture = loadFixture("permission-turn");
  const asked = fixture.events.find((e) => e.type === "permission.asked")!;
  const requestId = data(asked).id as string;
  const dummy = await startDummyServer({
    fixture,
    pauseAfter: (event) => event.type === "permission.asked",
  });
  await withProvider(dummy, async ({ handle, appended, conversation, waitFor }) => {
    const prompt = handle.prompt({ text: "run it", userMessageId: "user-1" });
    await waitFor(() => conversation().status === "awaiting_permission", "awaiting_permission");
    // Another client (TUI/desktop) sharing the server replies; the stream carries permission.replied.
    dummy.resumeReplay();
    await waitFor(
      () => appended.some((e) => e.kind === "permission_resolved" && e.requestId === requestId),
      "external permission_resolved"
    );
    assert.equal(dummy.permissionReplies.length, 0, "Cesium did not reply itself");
    await prompt;
    await dummy.replayFinished;
    assert.equal(conversation().pendingPermission, null);
    assert.equal(conversation().status, "idle");
  });
});

test("provider: background subagent completion resumes the root as an autonomous turn", async () => {
  const fixture = loadFixture("subagent-background");
  const dummy = await startDummyServer({ fixture });
  await withProvider(dummy, async ({ handle, appended, conversation, waitFor }) => {
    await handle.prompt({ text: "spawn it", userMessageId: "user-1" });
    // First execution finished: the user's turn is done while the child keeps running.
    assert.equal(conversation().status, "idle");
    const firstText = appended
      .filter((e) => e.kind === "assistant_message_chunk" && e.messageId === "opencode-v2-user-1")
      .map((e) => (e.kind === "assistant_message_chunk" ? e.text : ""))
      .join("");
    assert.match(firstText, /launched the background subagent/);
    const subagentCard = appended.find((e) => e.kind === "tool_call" && e.toolKind === "task");
    assert.ok(subagentCard, "subagent card opened");
    await dummy.replayFinished;
    await waitFor(
      () => appended.some((e) => e.kind === "status" && e.status === "idle" && /background turn complete/.test(e.detail ?? "")),
      "autonomous turn completion"
    );
    assert.ok(
      appended.some((e) => e.kind === "status" && e.status === "running" && /resumed after background work/.test(e.detail ?? "")),
      "autonomous turn opened with a running status"
    );
    assert.ok(
      appended.some((e) => e.kind === "system" && /Background subagent "Run echo command" \(General\) completed/.test(e.text)),
      "synthetic subagent completion notice surfaced"
    );
    const autonomousChunks = appended.filter(
      (e) => e.kind === "assistant_message_chunk" && e.messageId.startsWith("opencode-v2-autonomous-")
    );
    assert.ok(autonomousChunks.length > 0, "root text after the wake-up is not dropped");
    assert.match(
      autonomousChunks.map((e) => (e.kind === "assistant_message_chunk" ? e.text : "")).join(""),
      /from-subagent-bg/
    );
    const autonomousMessageId = autonomousChunks[0]!.kind === "assistant_message_chunk" ? autonomousChunks[0]!.messageId : "";
    assert.ok(appended.some((e) => e.kind === "assistant_message_end" && e.messageId === autonomousMessageId));
    assert.equal(conversation().status, "idle");
    const childText = appended.filter(
      (e) => e.kind === "assistant_message_chunk" && e.messageId.startsWith("opencode-subagent:")
    );
    assert.ok(childText.length > 0, "child output surfaces after the root turn ended");
  });
});

test("provider: a volatile-stream disconnect mid-turn is reconciled from the message list", async () => {
  const fixture = loadFixture("shell-turn");
  const success = fixture.events.find((e) => e.type === "session.tool.success")!;
  const messages: Json[] = [
    {
      id: data(success).assistantMessageID,
      type: "assistant",
      content: [
        {
          type: "tool",
          id: data(success).id,
          name: "shell",
          executed: false,
          state: {
            status: "completed",
            input: { command: "echo hello-from-v2 && date +%s" },
            content: data(success).content,
            metadata: data(success).metadata,
          },
        },
      ],
    },
  ];
  const dummy = await startDummyServer({
    fixture,
    // Drop the result and end the stream right after the tool is called; the
    // client reconnects and must recover the completed state via /message.
    drop: (event) => event.type === "session.tool.success" || event.type === "session.tool.progress",
    disconnectAfter: (event) => event.type === "session.tool.called",
    messages: () => messages,
    replayGapMs: 25,
  });
  await withProvider(dummy, async ({ handle, appended, conversation, waitFor }) => {
    await handle.prompt({ text: "run it", userMessageId: "user-1" });
    await dummy.replayFinished;
    await waitFor(
      () => appended.some((e) => e.kind === "tool_call_update" && e.status === "completed"),
      "reconciled tool completion",
      8_000
    );
    assert.ok(
      dummy.requests.filter((r) => r.path === "/api/event").length >= 2,
      `client reconnected; requests=${JSON.stringify(dummy.requests.map((r) => `${r.method} ${r.path}`))}`
    );
    assert.equal(conversation().status, "idle");
    const completed = appended.find((e) => e.kind === "tool_call_update" && e.status === "completed");
    assert.equal((completed!.raw as Json).reconciled, true);
  });
});
