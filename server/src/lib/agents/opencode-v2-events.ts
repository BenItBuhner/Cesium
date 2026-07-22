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
    },
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`OpenCode v2 SSE ${input.path} failed with ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
        await input.onData(data);
      }
    }
  }
}

export function startOpenCodeV2Events(input: {
  client: OpenCodeV2Client;
  onEvent: (event: OpenCodeV2Json) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): OpenCodeV2EventStream {
  const controller = new AbortController();
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  void (async () => {
    while (!controller.signal.aborted) {
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
      try {
        await consumeSse({
          client: input.client,
          path: `/api/experimental/session/${encodeURIComponent(input.sessionId)}/log?${query.toString()}`,
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
