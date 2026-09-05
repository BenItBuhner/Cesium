import http2 from "node:http2";
import type { AgentConversationStatus, AgentManagerEvent } from "./agents/types.js";

/**
 * GitHub Codespaces idle-timeout keep-alive.
 *
 * GitHub stops a codespace after `idle_timeout_minutes` without "activity
 * indicative of a user's presence". Crucially, HTTP traffic to a forwarded
 * port does NOT count - so a Cesium engine running inside a codespace used to
 * be shut down mid-agent-run the moment the user closed the VS Code tab (or
 * never opened one, which is the normal case for a Cesium device).
 *
 * The signal GitHub *does* honor comes from clients talking to the codespace's
 * internal host agent: `gh codespace ssh -- <cmd>` keeps a codespace alive
 * for the duration of a non-interactive command by calling
 * `CodespaceHost.NotifyCodespaceOfClientActivity` on the agent's internal
 * gRPC endpoint (`localhost:16634`) once a minute with the `keepAlive`
 * activity. Codespace containers share the VM network namespace, so the
 * engine can reach that endpoint directly from inside the container.
 *
 * This module replicates that heartbeat with a hand-rolled gRPC/h2c client
 * (two fields of protobuf - no dependency) and drives it from two presence
 * signals the engine already has:
 *  - an agent turn is in flight (running / awaiting permission / ...), or
 *  - a user acted on this engine recently (mutating API call, WS command).
 *
 * Nothing here runs outside a codespace unless forced through env.
 */

/* ------------------------------------------------------------------------ */
/* Wire format                                                              */
/* ------------------------------------------------------------------------ */

export const CODESPACE_HOST_RPC_PORT = 16634;
export const CODESPACE_HOST_RPC_PATH =
  "/Codespaces.Grpc.CodespaceHostService.v1.CodespaceHost/NotifyCodespaceOfClientActivity";
/** The agent only checks for a bearer scheme; `gh` sends this literal. */
const CODESPACE_HOST_RPC_AUTHORIZATION = "Bearer token";

export const KEEPALIVE_CLIENT_ID = "cesium";
export const KEEPALIVE_CONNECTED_ACTIVITY = "connected";
export const KEEPALIVE_ACTIVITY = "keepAlive";

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("varint must be a non-negative integer");
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function decodeVarint(buffer: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  let position = offset;
  for (;;) {
    if (position >= buffer.length) {
      throw new RangeError("truncated varint");
    }
    const byte = buffer[position]!;
    position += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, next: position };
    }
    multiplier *= 128;
  }
}

function encodeLengthDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const tag = Uint8Array.of((fieldNumber << 3) | 2);
  const length = encodeVarint(payload.length);
  const out = new Uint8Array(tag.length + length.length + payload.length);
  out.set(tag, 0);
  out.set(length, tag.length);
  out.set(payload, tag.length + length.length);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** `NotifyCodespaceOfClientActivityRequest { string ClientId = 1; repeated string ClientActivities = 2; }` */
export function encodeClientActivityRequest(
  clientId: string,
  activities: readonly string[]
): Uint8Array {
  const encoder = new TextEncoder();
  return concat([
    encodeLengthDelimited(1, encoder.encode(clientId)),
    ...activities.map((activity) => encodeLengthDelimited(2, encoder.encode(activity))),
  ]);
}

export type ClientActivityResponse = { result: boolean; message: string };

/** `NotifyCodespaceOfClientActivityResponse { bool Result = 1; string Message = 2; }` */
export function decodeClientActivityResponse(payload: Uint8Array): ClientActivityResponse {
  const decoder = new TextDecoder();
  let result = false;
  let message = "";
  let position = 0;
  while (position < payload.length) {
    const tag = decodeVarint(payload, position);
    position = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const varint = decodeVarint(payload, position);
      position = varint.next;
      if (fieldNumber === 1) {
        result = varint.value !== 0;
      }
      continue;
    }
    if (wireType === 2) {
      const length = decodeVarint(payload, position);
      position = length.next;
      const end = position + length.value;
      if (end > payload.length) {
        throw new RangeError("truncated length-delimited field");
      }
      if (fieldNumber === 2) {
        message = decoder.decode(payload.subarray(position, end));
      }
      position = end;
      continue;
    }
    // Unknown wire types (fixed64/fixed32) never appear in this message.
    throw new RangeError(`unsupported protobuf wire type ${wireType}`);
  }
  return { result, message };
}

/** gRPC length-prefixed message framing: 1 byte compressed flag + u32 BE length. */
export function frameGrpcMessage(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export function unframeGrpcMessage(body: Uint8Array): Uint8Array {
  if (body.length < 5) {
    throw new RangeError("gRPC body shorter than its length prefix");
  }
  if (body[0] !== 0) {
    throw new RangeError("compressed gRPC messages are not supported");
  }
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1, false);
  if (5 + length > body.length) {
    throw new RangeError("gRPC body truncated");
  }
  return body.subarray(5, 5 + length);
}

/* ------------------------------------------------------------------------ */
/* Transport                                                                */
/* ------------------------------------------------------------------------ */

export type NotifyClientActivityInput = {
  host: string;
  port: number;
  clientId: string;
  activities: readonly string[];
  timeoutMs?: number;
};

/**
 * One unary gRPC call over plaintext HTTP/2 to the codespace host agent.
 * Resolves with the decoded response; rejects on transport errors, non-zero
 * `grpc-status`, or timeout. A fresh session per call keeps the connection
 * state trivial (one call a minute at most).
 */
export function notifyCodespaceOfClientActivity(
  input: NotifyClientActivityInput
): Promise<ClientActivityResponse> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  return new Promise<ClientActivityResponse>((resolve, reject) => {
    let settled = false;
    const session = http2.connect(`http://${input.host}:${input.port}`);
    const finish = (error: Error | null, response?: ClientActivityResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session.close();
      if (error) {
        reject(error);
      } else {
        resolve(response!);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`codespace host RPC timed out after ${timeoutMs}ms`));
      session.destroy();
    }, timeoutMs);
    timer.unref?.();

    session.on("error", (error: Error) => finish(error));
    const request = session.request({
      ":method": "POST",
      ":path": CODESPACE_HOST_RPC_PATH,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: CODESPACE_HOST_RPC_AUTHORIZATION,
    });
    const chunks: Uint8Array[] = [];
    let status = 0;
    let grpcStatus: string | null = null;
    let grpcMessage = "";
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
      if (typeof headers["grpc-status"] === "string") {
        grpcStatus = headers["grpc-status"];
        grpcMessage = String(headers["grpc-message"] ?? "");
      }
    });
    request.on("trailers", (trailers) => {
      if (typeof trailers["grpc-status"] === "string") {
        grpcStatus = trailers["grpc-status"];
        grpcMessage = String(trailers["grpc-message"] ?? "");
      }
    });
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("error", (error: Error) => finish(error));
    request.on("end", () => {
      if (status !== 200) {
        finish(new Error(`codespace host RPC returned HTTP ${status}`));
        return;
      }
      if (grpcStatus !== null && grpcStatus !== "0") {
        finish(
          new Error(
            `codespace host RPC failed with grpc-status ${grpcStatus}${
              grpcMessage ? `: ${decodeURIComponent(grpcMessage)}` : ""
            }`
          )
        );
        return;
      }
      try {
        finish(null, decodeClientActivityResponse(unframeGrpcMessage(concat(chunks))));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.end(frameGrpcMessage(encodeClientActivityRequest(input.clientId, input.activities)));
  });
}

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

export type CodespaceKeepaliveConfig = {
  enabled: boolean;
  /** Why the service is (not) enabled - surfaced in `/health`. */
  reason: string;
  codespaceName: string | null;
  host: string;
  port: number;
  clientId: string;
  /** Heartbeat cadence while a keep-alive reason holds (gh uses 60s). */
  intervalMs: number;
  /** How long after the last user action the engine still reports presence. */
  clientActivityWindowMs: number;
  /**
   * Grace window after the last busy turn settles. Back-to-back prompts and
   * queued follow-ups should not race GitHub's idle clock between turns.
   */
  turnCooldownMs: number;
  /** Max hold for runs parked on the user (paused / awaiting permission or question). */
  waitingHoldMs: number;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CLIENT_ACTIVITY_WINDOW_MS = 5 * 60_000;
const DEFAULT_TURN_COOLDOWN_MS = 3 * 60_000;
const DEFAULT_WAITING_HOLD_MS = 60 * 60_000;

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Env contract:
 * - `CODESPACE_NAME` (set by GitHub inside every codespace) or
 *   `CESIUM_CODESPACE_NAME` (persisted into `server.env` by the bootstrap so
 *   supervised restarts still see it) turn the service on.
 * - `CESIUM_CODESPACE_KEEPALIVE=0` disables it; `=1` forces it on (harnesses).
 * - `CESIUM_CODESPACE_HOST_RPC=host:port` overrides the agent endpoint.
 * - `CESIUM_CODESPACE_KEEPALIVE_INTERVAL_MS`, `..._CLIENT_WINDOW_MS`,
 *   `..._TURN_COOLDOWN_MS` tune the cadence.
 */
export function resolveCodespaceKeepaliveConfig(
  env: NodeJS.ProcessEnv = process.env
): CodespaceKeepaliveConfig {
  const codespaceName =
    env.CODESPACE_NAME?.trim() || env.CESIUM_CODESPACE_NAME?.trim() || null;
  const toggle = env.CESIUM_CODESPACE_KEEPALIVE?.trim();
  let enabled: boolean;
  let reason: string;
  if (toggle === "0") {
    enabled = false;
    reason = "disabled by CESIUM_CODESPACE_KEEPALIVE=0";
  } else if (toggle === "1") {
    enabled = true;
    reason = "forced by CESIUM_CODESPACE_KEEPALIVE=1";
  } else if (codespaceName) {
    enabled = true;
    reason = "running inside a GitHub Codespace";
  } else {
    enabled = false;
    reason = "not running inside a GitHub Codespace";
  }
  let host = "127.0.0.1";
  let port = CODESPACE_HOST_RPC_PORT;
  const endpoint = env.CESIUM_CODESPACE_HOST_RPC?.trim();
  if (endpoint) {
    const separator = endpoint.lastIndexOf(":");
    if (separator > 0) {
      host = endpoint.slice(0, separator).replace(/^\[|\]$/g, "") || host;
      const parsedPort = Number.parseInt(endpoint.slice(separator + 1), 10);
      if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
        port = parsedPort;
      }
    } else {
      host = endpoint;
    }
  }
  return {
    enabled,
    reason,
    codespaceName,
    host,
    port,
    clientId: env.CESIUM_CODESPACE_KEEPALIVE_CLIENT_ID?.trim() || KEEPALIVE_CLIENT_ID,
    intervalMs: readPositiveIntEnv(env, "CESIUM_CODESPACE_KEEPALIVE_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    clientActivityWindowMs: readPositiveIntEnv(
      env,
      "CESIUM_CODESPACE_KEEPALIVE_CLIENT_WINDOW_MS",
      DEFAULT_CLIENT_ACTIVITY_WINDOW_MS
    ),
    turnCooldownMs: readPositiveIntEnv(
      env,
      "CESIUM_CODESPACE_KEEPALIVE_TURN_COOLDOWN_MS",
      DEFAULT_TURN_COOLDOWN_MS
    ),
    waitingHoldMs: readPositiveIntEnv(
      env,
      "CESIUM_CODESPACE_KEEPALIVE_WAITING_HOLD_MS",
      DEFAULT_WAITING_HOLD_MS
    ),
  };
}

/* ------------------------------------------------------------------------ */
/* Presence tracking                                                        */
/* ------------------------------------------------------------------------ */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Background writes clients issue without anyone at the keyboard. Session
 * autosave fires on pagehide/visibility flips; the rest are machine traffic.
 */
const NON_PRESENCE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/workspaces\/[^/]+\/session$/,
  /^\/api\/auth\/(status|refresh|logout)$/,
  /^\/api\/cloud-context\//,
  /^\/api\/public-access\//,
  /^\/api\/usage/,
];

/** Whether an HTTP request counts as a user acting on this engine. */
export function isCodespaceUserActivityRequest(method: string, path: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) {
    return false;
  }
  if (!path.startsWith("/api/")) {
    return false;
  }
  return !NON_PRESENCE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Statuses where the provider is actively working; held awake without limit. */
export const KEEPALIVE_WORKING_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  "running",
  "pause_requested",
  "pausing",
]);

/**
 * Statuses where a live runtime is parked on the user (permission prompt,
 * question, explicit pause). Losing the codespace here interrupts the run,
 * so they hold it awake too - but only for `waitingHoldMs`, otherwise a
 * forgotten permission prompt would burn codespace hours all night.
 */
export const KEEPALIVE_WAITING_STATUSES: ReadonlySet<AgentConversationStatus> = new Set([
  "paused",
  "awaiting_permission",
  "awaiting_question",
]);

export type KeepaliveReason = "agent-turn" | "turn-cooldown" | "client-activity";

/** Same startup allowance the stale-run watchdog grants before trusting `hasLiveRuntime`. */
export const KEEPALIVE_RUNTIME_GRACE_MS = 120_000;

export type KeepaliveSnapshot = {
  enabled: boolean;
  reason: string;
  codespaceName: string | null;
  /** Reason the last tick kept the codespace awake; null when idle. */
  activeReason: KeepaliveReason | null;
  busyConversations: number;
  lastClientActivityAt: number | null;
  lastNotifiedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type KeepaliveTrackerOptions = {
  clientActivityWindowMs: number;
  turnCooldownMs: number;
  waitingHoldMs: number;
};

type BusyEntry = {
  /** True for paused / awaiting_* (bounded hold), false while actively working. */
  waiting: boolean;
  /** When the conversation entered its current busy class. */
  since: number;
};

/**
 * Pure presence bookkeeping: which conversations are busy, when the last
 * turn settled, when a user last acted. Fully deterministic given `now`, so
 * the tick policy is unit-testable without timers or sockets.
 */
export class KeepalivePresenceTracker {
  private readonly busy = new Map<string, BusyEntry>();
  private lastTurnSettledAt: number | null = null;
  private lastClientActivityAt: number | null = null;

  constructor(private readonly options: KeepaliveTrackerOptions) {}

  get busyConversationCount(): number {
    return this.busy.size;
  }

  get clientActivityAt(): number | null {
    return this.lastClientActivityAt;
  }

  noteClientActivity(now: number): void {
    this.lastClientActivityAt = now;
  }

  observeStoreEvent(event: AgentManagerEvent, now: number): void {
    if (event.type === "conversation_deleted") {
      this.settle(event.conversationId, now);
      return;
    }
    if (event.type !== "conversation") {
      return;
    }
    const { id, status } = event.conversation;
    if (KEEPALIVE_WORKING_STATUSES.has(status)) {
      const existing = this.busy.get(id);
      if (!existing || existing.waiting) {
        this.busy.set(id, { waiting: false, since: now });
      }
      return;
    }
    if (KEEPALIVE_WAITING_STATUSES.has(status)) {
      const existing = this.busy.get(id);
      if (!existing || !existing.waiting) {
        this.busy.set(id, { waiting: true, since: now });
      }
      return;
    }
    this.settle(id, now);
  }

  /**
   * Drop conversations whose runtime vanished without a terminal status.
   * Entries younger than `graceMs` are left alone: a fresh prompt flips the
   * record to "running" before `ensureRuntime` finishes spawning the provider.
   */
  pruneBusy(
    isStillBusy: (conversationId: string) => boolean,
    now: number,
    graceMs = KEEPALIVE_RUNTIME_GRACE_MS
  ): void {
    for (const [conversationId, entry] of [...this.busy]) {
      if (now - entry.since < graceMs) {
        continue;
      }
      if (!isStillBusy(conversationId)) {
        this.settle(conversationId, now);
      }
    }
  }

  private settle(conversationId: string, now: number): void {
    if (this.busy.delete(conversationId)) {
      this.lastTurnSettledAt = now;
    }
  }

  /** Busy conversations that still justify a heartbeat at `now`. */
  private holdingConversations(now: number): number {
    let count = 0;
    for (const entry of this.busy.values()) {
      if (!entry.waiting || now - entry.since < this.options.waitingHoldMs) {
        count += 1;
      }
    }
    return count;
  }

  resolveReason(now: number): KeepaliveReason | null {
    if (this.holdingConversations(now) > 0) {
      return "agent-turn";
    }
    if (
      this.lastTurnSettledAt !== null &&
      now - this.lastTurnSettledAt < this.options.turnCooldownMs
    ) {
      return "turn-cooldown";
    }
    if (
      this.lastClientActivityAt !== null &&
      now - this.lastClientActivityAt < this.options.clientActivityWindowMs
    ) {
      return "client-activity";
    }
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Service                                                                  */
/* ------------------------------------------------------------------------ */

export type CodespaceKeepaliveServiceDeps = {
  config: CodespaceKeepaliveConfig;
  subscribe: (listener: (event: AgentManagerEvent) => void) => () => void;
  notify: (input: NotifyClientActivityInput) => Promise<ClientActivityResponse>;
  /** Cross-check against the runtime manager so a stuck record cannot pin the codespace awake forever. */
  isConversationBusy?: (conversationId: string) => boolean;
  now?: () => number;
  log?: Pick<Console, "info" | "warn">;
};

/** After this many consecutive RPC failures, warnings back off to one per hour. */
const FAILURE_LOG_THRESHOLD = 3;
const FAILURE_LOG_BACKOFF_MS = 60 * 60_000;

export class CodespaceKeepaliveService {
  private readonly tracker: KeepalivePresenceTracker;
  private readonly now: () => number;
  private readonly log: Pick<Console, "info" | "warn">;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private activeReason: KeepaliveReason | null = null;
  private lastNotifiedAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private lastFailureLogAt = 0;
  private announcedConnection = false;

  constructor(private readonly deps: CodespaceKeepaliveServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? console;
    this.tracker = new KeepalivePresenceTracker({
      clientActivityWindowMs: deps.config.clientActivityWindowMs,
      turnCooldownMs: deps.config.turnCooldownMs,
      waitingHoldMs: deps.config.waitingHoldMs,
    });
  }

  start(): void {
    if (this.timer || !this.deps.config.enabled) {
      return;
    }
    this.unsubscribe = this.deps.subscribe((event) =>
      this.tracker.observeStoreEvent(event, this.now())
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.config.intervalMs);
    this.timer.unref?.();
    this.log.info(
      `[codespace] keep-alive armed for ${this.deps.config.codespaceName ?? "codespace"} via ${this.deps.config.host}:${this.deps.config.port} (${this.deps.config.reason}).`
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  noteClientActivity(): void {
    this.tracker.noteClientActivity(this.now());
  }

  /** Test seam + manual trigger: evaluate presence once and heartbeat if warranted. */
  async tick(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  snapshot(): KeepaliveSnapshot {
    return {
      enabled: this.deps.config.enabled,
      reason: this.deps.config.reason,
      codespaceName: this.deps.config.codespaceName,
      activeReason: this.activeReason,
      busyConversations: this.tracker.busyConversationCount,
      lastClientActivityAt: this.tracker.clientActivityAt,
      lastNotifiedAt: this.lastNotifiedAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    if (this.deps.isConversationBusy) {
      this.tracker.pruneBusy(this.deps.isConversationBusy, now);
    }
    const reason = this.tracker.resolveReason(now);
    this.activeReason = reason;
    if (!reason) {
      return;
    }
    const activities = this.announcedConnection
      ? [KEEPALIVE_ACTIVITY]
      : [KEEPALIVE_CONNECTED_ACTIVITY, KEEPALIVE_ACTIVITY];
    try {
      const response = await this.deps.notify({
        host: this.deps.config.host,
        port: this.deps.config.port,
        clientId: this.deps.config.clientId,
        activities,
      });
      this.lastNotifiedAt = this.now();
      this.announcedConnection = true;
      if (!response.result) {
        this.recordFailure(
          `codespace host rejected the keep-alive${response.message ? `: ${response.message}` : ""}`
        );
        return;
      }
      if (this.consecutiveFailures > 0) {
        this.log.info("[codespace] keep-alive heartbeat recovered.");
      }
      this.consecutiveFailures = 0;
      this.lastError = null;
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private recordFailure(message: string): void {
    this.consecutiveFailures += 1;
    this.lastError = message;
    const now = this.now();
    const shouldLog =
      this.consecutiveFailures <= FAILURE_LOG_THRESHOLD ||
      now - this.lastFailureLogAt >= FAILURE_LOG_BACKOFF_MS;
    if (!shouldLog) {
      return;
    }
    this.lastFailureLogAt = now;
    this.log.warn(
      `[codespace] keep-alive heartbeat failed (${this.consecutiveFailures}x): ${message}. ` +
        "GitHub may stop this codespace while agents are still running. " +
        "Set CESIUM_CODESPACE_HOST_RPC if the host agent listens elsewhere, or CESIUM_CODESPACE_KEEPALIVE=0 to silence this."
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Process singleton                                                        */
/* ------------------------------------------------------------------------ */

let singleton: CodespaceKeepaliveService | null = null;

export function startCodespaceKeepalive(
  deps: Omit<CodespaceKeepaliveServiceDeps, "config"> & {
    config?: CodespaceKeepaliveConfig;
  }
): CodespaceKeepaliveService {
  if (singleton) {
    return singleton;
  }
  const config = deps.config ?? resolveCodespaceKeepaliveConfig();
  singleton = new CodespaceKeepaliveService({ ...deps, config });
  singleton.start();
  return singleton;
}

/** Cheap hook for request/socket paths; no-op when the service is not running. */
export function noteCodespaceClientActivity(): void {
  singleton?.noteClientActivity();
}

export function getCodespaceKeepaliveStatus(): KeepaliveSnapshot {
  if (singleton) {
    return singleton.snapshot();
  }
  const config = resolveCodespaceKeepaliveConfig();
  return {
    enabled: false,
    reason: config.enabled ? "not started" : config.reason,
    codespaceName: config.codespaceName,
    activeReason: null,
    busyConversations: 0,
    lastClientActivityAt: null,
    lastNotifiedAt: null,
    lastError: null,
    consecutiveFailures: 0,
  };
}
