import type { OpenCodeV2Client, OpenCodeV2Json } from "./opencode-v2-client.js";

export type OpenCodeV2EventStream = {
  ready: Promise<void>;
  close: () => void;
};

function eventBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let match = /\r?\n\r?\n/.exec(rest);
  while (match?.index != null) {
    blocks.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
    match = /\r?\n\r?\n/.exec(rest);
  }
  return { blocks, rest };
}

function parseBlock(block: string): unknown[] {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return [];
  try {
    return [JSON.parse(data) as unknown];
  } catch {
    return [];
  }
}

/**
 * Above this many unprocessed events the reader waits for the handler chain to
 * catch up. Normal turns stay far below it; the cap only bounds memory if a
 * handler stalls for a long time.
 */
const SSE_BACKLOG_SOFT_LIMIT = 10_000;

async function consumeSse(input: {
  client: OpenCodeV2Client;
  path: string;
  signal: AbortSignal;
  onData: (data: unknown) => void | Promise<void>;
}): Promise<void> {
  const response = await fetch(`${input.client.baseUrl}${input.path}`, {
    headers: {
      ...input.client.headers(),
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
      // Bun's fetch advertises `gzip, deflate, br, zstd`; the beta server then
      // Brotli-compresses the durable session log stream, and the encoder
      // buffers the tiny `log.synced` frame indefinitely - the stream never
      // becomes ready. SSE must always be delivered uncompressed.
      "Accept-Encoding": "identity",
    },
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    const error = new Error(`OpenCode v2 SSE ${input.path} failed with ${response.status}.`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The server's `/api/event` feed is volatile by contract: a subscriber that
  // does not keep up overflows its queue and the server *terminates the
  // stream*, dropping every event until the client reconnects. Handlers here
  // persist events to storage, so processing must never block the socket read.
  // Events are read as fast as they arrive and handled in order on a chain.
  let chain: Promise<void> = Promise.resolve();
  let backlog = 0;
  let failure: unknown;
  const enqueue = (data: unknown) => {
    backlog += 1;
    chain = chain
      .then(() => input.onData(data))
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        backlog -= 1;
      });
  };
  try {
    while (!input.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = eventBlocks(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        for (const data of parseBlock(block)) {
          enqueue(data);
        }
      }
      if (failure) throw failure;
      if (backlog > SSE_BACKLOG_SOFT_LIMIT) {
        await chain;
      }
    }
  } finally {
    // Preserve ordering guarantees for callers: everything read from this
    // connection is handled before the caller reconnects or returns.
    await chain;
    if (failure) throw failure;
  }
}

export function startOpenCodeV2Events(input: {
  client: OpenCodeV2Client;
  onEvent: (event: OpenCodeV2Json) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  /**
   * Invoked when the stream re-establishes after having been connected before.
   * Anything the server published in between is gone (volatile feed), so the
   * caller should reconcile state (pending permissions, tool results, ...).
   */
  onReconnect?: () => void | Promise<void>;
}): OpenCodeV2EventStream {
  const controller = new AbortController();
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let attempt = 0;
  void (async () => {
    while (!controller.signal.aborted) {
      // Keyed on connection attempts, not on counting `server.connected`
      // frames: the marker is per connection, and treating a stray duplicate
      // as a reconnect would trigger needless reconciliation.
      const reconnecting = attempt > 0;
      let reconnectHandled = false;
      try {
        await consumeSse({
          client: input.client,
          path: "/api/event",
          signal: controller.signal,
          onData: async (data) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) {
              return;
            }
            const event = data as OpenCodeV2Json;
            if (event.type === "server.connected") {
              readyResolve();
              if (reconnecting && !reconnectHandled) {
                reconnectHandled = true;
                await input.onReconnect?.();
              }
              return;
            }
            await input.onEvent(event);
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        await input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      attempt += 1;
      if (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
  return { ready, close: () => controller.abort() };
}

export function startOpenCodeV2SessionLog(input: {
  client: OpenCodeV2Client;
  sessionId: string;
  replayExisting: boolean;
  reconnectOnCleanClose?: boolean;
  onEvent: (event: OpenCodeV2Json) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): OpenCodeV2EventStream {
  const controller = new AbortController();
  let lastSeq: number | undefined;
  let initial = true;
  let preferExperimentalLog = false;
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  void (async () => {
    while (!controller.signal.aborted) {
      const skipUntilSynced = initial && !input.replayExisting;
      let synced = !skipUntilSynced;
      const query = new URLSearchParams({ follow: "true" });
      if (lastSeq != null) {
        query.set("after", String(lastSeq));
      }
      const paths = input.client.sessionLogPath(input.sessionId, query);
      // Annotated to break a circular inference chain through
      // `preferExperimentalLog` (assigned from `path` inside the loop below).
      const orderedPaths: string[] = preferExperimentalLog ? [...paths].reverse() : paths;
      try {
        let lastError: Error | null = null;
        for (const [index, path] of orderedPaths.entries()) {
          try {
            await consumeSse({
              client: input.client,
              path,
              signal: controller.signal,
              onData: async (data) => {
                if (!data || typeof data !== "object" || Array.isArray(data)) {
                  return;
                }
                const event = data as OpenCodeV2Json;
                if (event.type === "log.synced") {
                  if (typeof event.seq === "number") {
                    lastSeq = Math.max(lastSeq ?? -1, event.seq);
                  }
                  synced = true;
                  initial = false;
                  readyResolve();
                  return;
                }
                const durable =
                  event.durable && typeof event.durable === "object" && !Array.isArray(event.durable)
                    ? (event.durable as OpenCodeV2Json)
                    : undefined;
                if (typeof durable?.seq === "number") {
                  lastSeq = Math.max(lastSeq ?? -1, durable.seq);
                }
                if (synced) {
                  await input.onEvent(event);
                }
              },
            });
            lastError = null;
            break;
          } catch (error) {
            const status = (error as { status?: number }).status;
            lastError = error instanceof Error ? error : new Error(String(error));
            if (status === 404 && index < orderedPaths.length - 1) {
              preferExperimentalLog = path.includes("/api/session/");
              continue;
            }
            throw lastError;
          }
        }
        if (lastError) {
          throw lastError;
        }
        if (input.reconnectOnCleanClose === false) {
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        await input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      if (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
  return { ready, close: () => controller.abort() };
}
