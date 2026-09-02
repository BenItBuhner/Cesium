import assert from "node:assert/strict";
import http2 from "node:http2";
import { describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  CODESPACE_HOST_RPC_PATH,
  CODESPACE_HOST_RPC_PORT,
  CodespaceKeepaliveService,
  KEEPALIVE_ACTIVITY,
  KEEPALIVE_CONNECTED_ACTIVITY,
  KEEPALIVE_RUNTIME_GRACE_MS,
  KeepalivePresenceTracker,
  decodeClientActivityResponse,
  encodeClientActivityRequest,
  frameGrpcMessage,
  isCodespaceUserActivityRequest,
  notifyCodespaceOfClientActivity,
  resolveCodespaceKeepaliveConfig,
  unframeGrpcMessage,
  type CodespaceKeepaliveConfig,
  type NotifyClientActivityInput,
} from "../src/lib/codespace-keepalive.ts";
import type { AgentConversationRecord, AgentManagerEvent } from "../src/lib/agents/types.ts";

/* ------------------------------ protobuf ---------------------------------- */

function decodeVarint(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let position = offset;
  for (;;) {
    const byte = buffer[position++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, position];
    shift += 7;
  }
}

/** Independent decoder so the encoder is checked against the proto, not itself. */
function decodeRequest(payload: Uint8Array): { clientId: string; activities: string[] } {
  const out = { clientId: "", activities: [] as string[] };
  let position = 0;
  while (position < payload.length) {
    const tag = payload[position++]!;
    assert.equal(tag & 0x7, 2, "string fields are length-delimited");
    const [length, next] = decodeVarint(payload, position);
    position = next;
    const value = new TextDecoder().decode(payload.subarray(position, position + length));
    position += length;
    if (tag >> 3 === 1) out.clientId = value;
    else if (tag >> 3 === 2) out.activities.push(value);
    else assert.fail(`unexpected field ${tag >> 3}`);
  }
  return out;
}

describe("codespace keep-alive wire format", () => {
  test("encodes NotifyCodespaceOfClientActivityRequest per the gh proto", () => {
    const encoded = encodeClientActivityRequest("cesium", ["connected", "keepAlive"]);
    // 0x0A = field 1 / length-delimited, 0x12 = field 2 / length-delimited.
    assert.equal(encoded[0], 0x0a);
    assert.equal(encoded[1], "cesium".length);
    assert.deepEqual(decodeRequest(encoded), {
      clientId: "cesium",
      activities: ["connected", "keepAlive"],
    });
  });

  test("decodes the response message (bool Result = 1, string Message = 2)", () => {
    const message = new TextEncoder().encode("all good");
    const payload = Uint8Array.from([0x08, 0x01, 0x12, message.length, ...message]);
    assert.deepEqual(decodeClientActivityResponse(payload), {
      result: true,
      message: "all good",
    });
    assert.deepEqual(decodeClientActivityResponse(new Uint8Array(0)), {
      result: false,
      message: "",
    });
    // Unknown varint fields are skipped, not fatal.
    assert.deepEqual(decodeClientActivityResponse(Uint8Array.from([0x18, 0x05, 0x08, 0x01])), {
      result: true,
      message: "",
    });
  });

  test("gRPC framing round-trips and rejects compressed/truncated bodies", () => {
    const payload = encodeClientActivityRequest("x", ["y"]);
    const frame = frameGrpcMessage(payload);
    assert.equal(frame.length, payload.length + 5);
    assert.equal(frame[0], 0);
    assert.deepEqual([...unframeGrpcMessage(frame)], [...payload]);
    assert.throws(() => unframeGrpcMessage(frame.subarray(0, 3)), /shorter/);
    assert.throws(() => unframeGrpcMessage(Uint8Array.from([1, 0, 0, 0, 0])), /compressed/);
    assert.throws(() => unframeGrpcMessage(Uint8Array.from([0, 0, 0, 0, 9, 1])), /truncated/);
  });

  test("long strings use multi-byte varint lengths", () => {
    const long = "a".repeat(300);
    const encoded = encodeClientActivityRequest(long, []);
    assert.equal(encoded[0], 0x0a);
    // 300 = 0xAC 0x02 as a varint.
    assert.equal(encoded[1], 0xac);
    assert.equal(encoded[2], 0x02);
    assert.equal(decodeRequest(encoded).clientId, long);
  });
});

/* ------------------------------ transport --------------------------------- */

type FakeHostCall = {
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  request: { clientId: string; activities: string[] };
};

/** Minimal stand-in for the codespace host agent's gRPC endpoint (h2c). */
async function startFakeCodespaceHost(options?: {
  result?: boolean;
  message?: string;
  grpcStatus?: string;
}) {
  const calls: FakeHostCall[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push({
        path: String(headers[":path"]),
        authorization: headers.authorization as string | undefined,
        contentType: headers["content-type"] as string | undefined,
        request: decodeRequest(unframeGrpcMessage(body)),
      });
      const message = new TextEncoder().encode(options?.message ?? "");
      const proto = Uint8Array.from([
        0x08,
        options?.result === false ? 0 : 1,
        0x12,
        message.length,
        ...message,
      ]);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true }
      );
      stream.on("wantTrailers", () => {
        stream.sendTrailers({ "grpc-status": options?.grpcStatus ?? "0", "grpc-message": "" });
      });
      stream.end(Buffer.from(frameGrpcMessage(proto)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("codespace keep-alive transport", () => {
  test("performs a plaintext HTTP/2 unary call the host agent understands", async () => {
    const host = await startFakeCodespaceHost({ message: "ok" });
    try {
      const response = await notifyCodespaceOfClientActivity({
        host: "127.0.0.1",
        port: host.port,
        clientId: "cesium",
        activities: ["connected", "keepAlive"],
      });
      assert.deepEqual(response, { result: true, message: "ok" });
      assert.equal(host.calls.length, 1);
      const call = host.calls[0]!;
      assert.equal(call.path, CODESPACE_HOST_RPC_PATH);
      assert.equal(call.authorization, "Bearer token");
      assert.equal(call.contentType, "application/grpc");
      assert.deepEqual(call.request, {
        clientId: "cesium",
        activities: ["connected", "keepAlive"],
      });
    } finally {
      await host.close();
    }
  });

  test("surfaces non-zero grpc-status trailers as errors", async () => {
    const host = await startFakeCodespaceHost({ grpcStatus: "16" });
    try {
      await assert.rejects(
        notifyCodespaceOfClientActivity({
          host: "127.0.0.1",
          port: host.port,
          clientId: "cesium",
          activities: ["keepAlive"],
        }),
        /grpc-status 16/
      );
    } finally {
      await host.close();
    }
  });

  test("rejects quickly when nothing listens on the endpoint", async () => {
    const probe = http2.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await assert.rejects(
      notifyCodespaceOfClientActivity({
        host: "127.0.0.1",
        port,
        clientId: "cesium",
        activities: ["keepAlive"],
        timeoutMs: 3_000,
      })
    );
  });
});

/* ------------------------------- config ----------------------------------- */

describe("codespace keep-alive config", () => {
  test("is off outside codespaces and on when CODESPACE_NAME is present", () => {
    assert.equal(resolveCodespaceKeepaliveConfig({}).enabled, false);
    const inside = resolveCodespaceKeepaliveConfig({ CODESPACE_NAME: "fluffy-space-1234" });
    assert.equal(inside.enabled, true);
    assert.equal(inside.codespaceName, "fluffy-space-1234");
    assert.equal(inside.host, "127.0.0.1");
    assert.equal(inside.port, CODESPACE_HOST_RPC_PORT);
    assert.equal(inside.clientId, "cesium");
  });

  test("honors the persisted CESIUM_CODESPACE_NAME and explicit toggles", () => {
    assert.equal(
      resolveCodespaceKeepaliveConfig({ CESIUM_CODESPACE_NAME: "persisted" }).enabled,
      true
    );
    const forcedOff = resolveCodespaceKeepaliveConfig({
      CODESPACE_NAME: "x",
      CESIUM_CODESPACE_KEEPALIVE: "0",
    });
    assert.equal(forcedOff.enabled, false);
    assert.match(forcedOff.reason, /CESIUM_CODESPACE_KEEPALIVE=0/);
    const forcedOn = resolveCodespaceKeepaliveConfig({ CESIUM_CODESPACE_KEEPALIVE: "1" });
    assert.equal(forcedOn.enabled, true);
    assert.equal(forcedOn.codespaceName, null);
  });

  test("parses endpoint and cadence overrides, ignoring garbage", () => {
    const config = resolveCodespaceKeepaliveConfig({
      CODESPACE_NAME: "x",
      CESIUM_CODESPACE_HOST_RPC: "10.0.0.5:4242",
      CESIUM_CODESPACE_KEEPALIVE_INTERVAL_MS: "15000",
      CESIUM_CODESPACE_KEEPALIVE_CLIENT_WINDOW_MS: "nope",
      CESIUM_CODESPACE_KEEPALIVE_CLIENT_ID: "gh",
    });
    assert.equal(config.host, "10.0.0.5");
    assert.equal(config.port, 4242);
    assert.equal(config.intervalMs, 15_000);
    assert.equal(config.clientActivityWindowMs, 5 * 60_000);
    assert.equal(config.clientId, "gh");
    assert.equal(
      resolveCodespaceKeepaliveConfig({ CESIUM_CODESPACE_HOST_RPC: "[::1]:16634" }).host,
      "::1"
    );
  });
});

/* ------------------------------ presence ---------------------------------- */

function conversationEvent(
  id: string,
  status: AgentConversationRecord["status"]
): AgentManagerEvent {
  return {
    type: "conversation",
    conversation: { id, status } as AgentConversationRecord,
  };
}

const TRACKER_OPTIONS = {
  clientActivityWindowMs: 5 * 60_000,
  turnCooldownMs: 3 * 60_000,
  waitingHoldMs: 60 * 60_000,
};

describe("keep-alive presence tracker", () => {
  test("running turns hold the codespace, then a cooldown, then nothing", () => {
    const tracker = new KeepalivePresenceTracker(TRACKER_OPTIONS);
    assert.equal(tracker.resolveReason(0), null);
    tracker.observeStoreEvent(conversationEvent("a", "running"), 1_000);
    assert.equal(tracker.resolveReason(60_000), "agent-turn");
    assert.equal(tracker.busyConversationCount, 1);
    tracker.observeStoreEvent(conversationEvent("a", "idle"), 100_000);
    assert.equal(tracker.busyConversationCount, 0);
    assert.equal(tracker.resolveReason(100_000 + 60_000), "turn-cooldown");
    assert.equal(tracker.resolveReason(100_000 + TRACKER_OPTIONS.turnCooldownMs), null);
  });

  test("waiting states (permission/question/pause) hold only for the bounded window", () => {
    const tracker = new KeepalivePresenceTracker(TRACKER_OPTIONS);
    tracker.observeStoreEvent(conversationEvent("a", "awaiting_permission"), 0);
    assert.equal(tracker.resolveReason(30 * 60_000), "agent-turn");
    assert.equal(tracker.resolveReason(TRACKER_OPTIONS.waitingHoldMs + 1), null);
    // Resuming work resets the clock (waiting -> working).
    tracker.observeStoreEvent(conversationEvent("a", "running"), TRACKER_OPTIONS.waitingHoldMs + 5);
    assert.equal(tracker.resolveReason(TRACKER_OPTIONS.waitingHoldMs + 10 * 60_000), "agent-turn");
  });

  test("user activity keeps the codespace awake for the activity window", () => {
    const tracker = new KeepalivePresenceTracker(TRACKER_OPTIONS);
    tracker.noteClientActivity(10_000);
    assert.equal(tracker.resolveReason(10_000 + 60_000), "client-activity");
    assert.equal(tracker.resolveReason(10_000 + TRACKER_OPTIONS.clientActivityWindowMs), null);
  });

  test("deleted and vanished conversations settle into the cooldown", () => {
    const tracker = new KeepalivePresenceTracker(TRACKER_OPTIONS);
    tracker.observeStoreEvent(conversationEvent("a", "running"), 0);
    tracker.observeStoreEvent(conversationEvent("b", "running"), 0);
    tracker.observeStoreEvent(
      { type: "conversation_deleted", workspaceId: "w", conversationId: "a" },
      1_000
    );
    assert.equal(tracker.busyConversationCount, 1);
    // Within the runtime grace window the missing runtime is tolerated...
    tracker.pruneBusy(() => false, KEEPALIVE_RUNTIME_GRACE_MS - 1);
    assert.equal(tracker.busyConversationCount, 1);
    // ...after it, the entry is dropped and starts the cooldown.
    tracker.pruneBusy(() => false, KEEPALIVE_RUNTIME_GRACE_MS + 1);
    assert.equal(tracker.busyConversationCount, 0);
    assert.equal(tracker.resolveReason(KEEPALIVE_RUNTIME_GRACE_MS + 2), "turn-cooldown");
  });
});

/* ------------------------------- service ---------------------------------- */

const SERVICE_CONFIG: CodespaceKeepaliveConfig = {
  enabled: true,
  reason: "test",
  codespaceName: "test-space",
  host: "127.0.0.1",
  port: 1,
  clientId: "cesium",
  intervalMs: 60_000,
  clientActivityWindowMs: 5 * 60_000,
  turnCooldownMs: 3 * 60_000,
  waitingHoldMs: 60 * 60_000,
};

function createServiceHarness(options?: {
  notify?: (input: NotifyClientActivityInput) => Promise<{ result: boolean; message: string }>;
}) {
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const calls: NotifyClientActivityInput[] = [];
  const logs: { info: string[]; warn: string[] } = { info: [], warn: [] };
  let now = 0;
  const service = new CodespaceKeepaliveService({
    config: SERVICE_CONFIG,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    notify: async (input) => {
      calls.push(input);
      if (options?.notify) {
        return options.notify(input);
      }
      return { result: true, message: "" };
    },
    now: () => now,
    log: {
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
    },
  });
  service.start();
  return {
    service,
    calls,
    logs,
    emit: (event: AgentManagerEvent) => listener?.(event),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("codespace keep-alive service", () => {
  test("stays silent while idle and heartbeats while a turn runs", async () => {
    const harness = createServiceHarness();
    try {
      await harness.service.tick();
      assert.equal(harness.calls.length, 0);
      assert.equal(harness.service.snapshot().activeReason, null);

      harness.emit(conversationEvent("a", "running"));
      harness.advance(60_000);
      await harness.service.tick();
      assert.equal(harness.calls.length, 1);
      // First heartbeat announces the connection like gh does.
      assert.deepEqual(harness.calls[0]!.activities, [
        KEEPALIVE_CONNECTED_ACTIVITY,
        KEEPALIVE_ACTIVITY,
      ]);
      assert.equal(harness.calls[0]!.clientId, "cesium");
      harness.advance(60_000);
      await harness.service.tick();
      assert.deepEqual(harness.calls[1]!.activities, [KEEPALIVE_ACTIVITY]);
      const snapshot = harness.service.snapshot();
      assert.equal(snapshot.activeReason, "agent-turn");
      assert.equal(snapshot.busyConversations, 1);
      assert.equal(snapshot.lastError, null);
      assert.equal(snapshot.consecutiveFailures, 0);
      assert.equal(snapshot.lastNotifiedAt, 120_000);
    } finally {
      harness.service.stop();
    }
  });

  test("records rejections and transport failures, logging with backoff", async () => {
    let fail = true;
    const harness = createServiceHarness({
      notify: async () => {
        if (fail) {
          throw new Error("ECONNREFUSED");
        }
        return { result: false, message: "nope" };
      },
    });
    try {
      harness.emit(conversationEvent("a", "running"));
      for (let index = 0; index < 5; index += 1) {
        harness.advance(60_000);
        await harness.service.tick();
      }
      let snapshot = harness.service.snapshot();
      assert.equal(snapshot.consecutiveFailures, 5);
      assert.match(snapshot.lastError ?? "", /ECONNREFUSED/);
      // Three loud warnings, then silence until the hourly backoff elapses.
      assert.equal(harness.logs.warn.length, 3);
      assert.match(harness.logs.warn[0]!, /GitHub may stop this codespace/);

      fail = false;
      harness.advance(60_000);
      await harness.service.tick();
      snapshot = harness.service.snapshot();
      assert.equal(snapshot.consecutiveFailures, 6);
      assert.match(snapshot.lastError ?? "", /rejected the keep-alive: nope/);
    } finally {
      harness.service.stop();
    }
  });

  test("client activity alone is a valid reason and recovery resets failures", async () => {
    let fail = true;
    const harness = createServiceHarness({
      notify: async () => {
        if (fail) throw new Error("boom");
        return { result: true, message: "" };
      },
    });
    try {
      harness.service.noteClientActivity();
      harness.advance(1_000);
      await harness.service.tick();
      assert.equal(harness.service.snapshot().activeReason, "client-activity");
      assert.equal(harness.service.snapshot().consecutiveFailures, 1);
      fail = false;
      harness.advance(1_000);
      await harness.service.tick();
      const snapshot = harness.service.snapshot();
      assert.equal(snapshot.consecutiveFailures, 0);
      assert.equal(snapshot.lastError, null);
      assert.ok(harness.logs.info.some((line) => /recovered/.test(line)));
    } finally {
      harness.service.stop();
    }
  });

  test("does not start when disabled", () => {
    let subscribed = false;
    const service = new CodespaceKeepaliveService({
      config: { ...SERVICE_CONFIG, enabled: false },
      subscribe: () => {
        subscribed = true;
        return () => undefined;
      },
      notify: async () => ({ result: true, message: "" }),
      log: { info: () => undefined, warn: () => undefined },
    });
    service.start();
    assert.equal(subscribed, false);
    service.stop();
  });
});

/* ---------------------------- request policy ------------------------------ */

describe("codespace user-activity request policy", () => {
  test("counts mutating API calls but not polling or background writes", () => {
    assert.equal(isCodespaceUserActivityRequest("POST", "/api/agents/conversations"), true);
    assert.equal(isCodespaceUserActivityRequest("PATCH", "/api/agents/conversations/x"), true);
    assert.equal(isCodespaceUserActivityRequest("PUT", "/api/fs/file"), true);
    assert.equal(isCodespaceUserActivityRequest("GET", "/api/agents/conversations"), false);
    assert.equal(isCodespaceUserActivityRequest("GET", "/health"), false);
    assert.equal(isCodespaceUserActivityRequest("POST", "/health"), false);
    assert.equal(isCodespaceUserActivityRequest("PUT", "/api/workspaces/abc/session"), false);
    assert.equal(isCodespaceUserActivityRequest("POST", "/api/auth/status"), false);
    assert.equal(isCodespaceUserActivityRequest("POST", "/api/usage/report"), false);
  });
});
