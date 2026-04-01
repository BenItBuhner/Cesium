import type { AcpStdioClient } from "./acp-transport.js";

/** Best-effort: ACP notifications/requests often include a session id at the top level or under `update`. */
export function extractAcpEventSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const r = params as Record<string, unknown>;
  for (const key of ["sessionId", "session_id"] as const) {
    const v = r[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  const update = r.update;
  if (update && typeof update === "object") {
    const u = update as Record<string, unknown>;
    for (const key of ["sessionId", "session_id"] as const) {
      const v = u[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return undefined;
}

export type AcpSessionMessageHooks = {
  onNotification: (method: string, params: unknown) => void | Promise<void>;
  onRequest: (
    id: number | string,
    method: string,
    params: unknown
  ) => void | Promise<void>;
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

/**
 * Multiplexes one ACP stdio JSON-RPC connection across multiple logical sessions.
 * Notifications and incoming requests are routed by `sessionId` when present;
 * if it is missing and exactly one session is registered, that session receives the event.
 */
export class AcpSharedBridge {
  private readonly sessions = new Map<string, AcpSessionMessageHooks>();
  private creationCapture: Array<{ method: string; params: unknown }> | null = null;
  private exitNotified = false;

  constructor(private readonly transport: AcpStdioClient) {
    this.transport.onNotification((notification) => {
      void this.dispatchNotification(notification.method, notification.params);
    });
    this.transport.onRequest((request) => {
      void this.dispatchRequest(request.id, request.method, request.params);
    });
    this.transport.onStderr((line) => {
      for (const hooks of this.sessions.values()) {
        hooks.onStderr(line);
      }
    });
    this.transport.onExit((code) => {
      if (this.exitNotified) {
        return;
      }
      this.exitNotified = true;
      for (const hooks of this.sessions.values()) {
        hooks.onExit(code);
      }
      this.sessions.clear();
    });
  }

  startCreationCapture(): void {
    this.creationCapture = [];
  }

  cancelCreationCapture(): void {
    this.creationCapture = null;
  }

  endCreationCapture(
    sessionId: string,
    replay: (method: string, params: unknown) => void
  ): void {
    const batch = this.creationCapture ?? [];
    this.creationCapture = null;
    for (const item of batch) {
      const sid = extractAcpEventSessionId(item.params);
      if (sid === undefined || sid === sessionId) {
        replay(item.method, item.params);
      }
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }

  notify(method: string, params?: unknown): void {
    this.transport.notify(method, params);
  }

  respond(id: number | string, result: unknown): void {
    this.transport.respond(id, result);
  }

  register(sessionId: string, hooks: AcpSessionMessageHooks): void {
    this.sessions.set(sessionId, hooks);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async closeTransport(): Promise<void> {
    await this.transport.close();
  }

  private singleRegisteredHooks(): AcpSessionMessageHooks | undefined {
    if (this.sessions.size !== 1) {
      return undefined;
    }
    return this.sessions.values().next().value as AcpSessionMessageHooks | undefined;
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (this.creationCapture && method === "session/update") {
      const update =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).update
          : null;
      if (
        update &&
        typeof update === "object" &&
        ((update as Record<string, unknown>).sessionUpdate === "config_option_update" ||
          (update as Record<string, unknown>).sessionUpdate === "current_mode_update")
      ) {
        this.creationCapture.push({ method, params });
      }
      return;
    }
    const sid = extractAcpEventSessionId(params);
    const hooks =
      (sid ? this.sessions.get(sid) : undefined) ?? this.singleRegisteredHooks();
    void hooks?.onNotification(method, params);
  }

  private dispatchRequest(
    id: number | string,
    method: string,
    params: unknown
  ): void {
    const sid = extractAcpEventSessionId(params);
    const hooks =
      (sid ? this.sessions.get(sid) : undefined) ?? this.singleRegisteredHooks();
    void hooks?.onRequest(id, method, params);
  }
}

type PoolEntry = {
  bridge: AcpSharedBridge;
  refs: number;
};

const sharedPools = new Map<string, PoolEntry>();
const poolChains = new Map<string, Promise<void>>();

function enqueuePoolOp<T>(poolKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = poolChains.get(poolKey) ?? Promise.resolve();
  const job = prev.catch(() => undefined).then(() => fn());
  poolChains.set(
    poolKey,
    job.then(
      () => undefined,
      () => undefined
    )
  );
  return job;
}

export function makeAcpPoolKey(input: {
  workspaceRoot: string;
  backendId: string;
  command: string;
  args: readonly string[];
}): string {
  return `${input.backendId}\0${input.workspaceRoot}\0${input.command}\0${input.args.join("\0")}`;
}

export async function retainAcpSharedBridge(input: {
  poolKey: string;
  spawn: () => Promise<AcpStdioClient>;
  /** Return human-readable bootstrap lines (e.g. auth outcome) when the transport is new. */
  afterSpawn: (transport: AcpStdioClient) => Promise<void | string[]>;
}): Promise<{
  bridge: AcpSharedBridge;
  release: () => Promise<void>;
  bootstrapSystemMessages: string[];
}> {
  return enqueuePoolOp(input.poolKey, async () => {
    let entry = sharedPools.get(input.poolKey);
    let bootstrapSystemMessages: string[] = [];
    if (!entry) {
      const transport = await input.spawn();
      const maybe = await input.afterSpawn(transport);
      bootstrapSystemMessages = Array.isArray(maybe) ? maybe : [];
      entry = { bridge: new AcpSharedBridge(transport), refs: 0 };
      sharedPools.set(input.poolKey, entry);
    }
    entry.refs += 1;
    const snapshot = entry;
    return {
      bridge: snapshot.bridge,
      bootstrapSystemMessages,
      release: async () => {
        await enqueuePoolOp(input.poolKey, async () => {
          const current = sharedPools.get(input.poolKey);
          if (!current || current.bridge !== snapshot.bridge) {
            return;
          }
          current.refs -= 1;
          if (current.refs <= 0) {
            await current.bridge.closeTransport().catch(() => undefined);
            sharedPools.delete(input.poolKey);
          }
        });
      },
    };
  });
}
