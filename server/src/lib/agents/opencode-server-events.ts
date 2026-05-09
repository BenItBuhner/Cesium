import type { OpenCodeServerClient, OpenCodeServerJson } from "./opencode-server-client.js";

export type OpenCodeServerEvent = {
  route: "/event" | "/global/event";
  data: unknown;
};

export type OpenCodeServerEventStream = {
  close: () => void;
};

function parseSseChunk(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    events.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { events, rest };
}

function dataLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function parseData(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function consumeOpenCodeSse(input: {
  client: OpenCodeServerClient;
  route: "/event" | "/global/event";
  signal: AbortSignal;
  onEvent: (event: OpenCodeServerEvent) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): Promise<void> {
  while (!input.signal.aborted) {
    try {
      const response = await fetch(`${input.client.baseUrl}${input.route}`, {
        headers: {
          Accept: "text/event-stream",
          ...input.client.headers(),
        },
        signal: input.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode SSE ${input.route} failed with ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const chunk of parsed.events) {
          for (const line of dataLines(chunk)) {
            await input.onEvent({ route: input.route, data: parseData(line) });
          }
        }
      }
    } catch (error) {
      if (input.signal.aborted) {
        return;
      }
      await input.onError?.(error instanceof Error ? error : new Error(String(error)));
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

export function startOpenCodeServerEvents(input: {
  client: OpenCodeServerClient;
  routes?: Array<"/event" | "/global/event">;
  onEvent: (event: OpenCodeServerEvent) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): OpenCodeServerEventStream {
  const controller = new AbortController();
  const routes = input.routes ?? ["/event", "/global/event"];
  for (const route of routes) {
    void consumeOpenCodeSse({
      client: input.client,
      route,
      signal: controller.signal,
      onEvent: input.onEvent,
      onError: input.onError,
    });
  }
  return {
    close: () => controller.abort(),
  };
}

export function openCodeSseDataRecord(event: OpenCodeServerEvent): OpenCodeServerJson | null {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as OpenCodeServerJson)
    : null;
}
