import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scripted OpenAI-compatible `/chat/completions` server for Project tests.
 * Requests are routed to a per-conversation script by `keyOf`; tool-less
 * requests (title generation) get a fixed reply.
 */

export type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};
export type ChatTool = { function?: { name?: string } };
export type ChatRequest = { messages: ChatMessage[]; tools?: ChatTool[]; stream?: boolean };
export type Responder = (request: ChatRequest, res: ServerResponse) => Promise<void>;

export const ORCHESTRATOR_MARKER = "You are the orchestrator of a Cesium Project";

export function messageText(message: ChatMessage | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      )
      .join("");
  }
  return "";
}

/** "orchestrator" for the Project orchestrator, else the child name from its Project brief. */
export function projectScriptKey(request: ChatRequest): string {
  const texts = request.messages.map(messageText);
  if (texts.some((text) => text.includes(ORCHESTRATOR_MARKER))) {
    return "orchestrator";
  }
  for (const text of texts) {
    const match = text.match(/You are "([^"]+)", an agent in the Cesium Project/);
    if (match) {
      return match[1]!;
    }
  }
  return "unknown";
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): Responder {
  return async (_request, res) => {
    writeSseHead(res);
    writeSse(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    });
    writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    res.end("data: [DONE]\n\n");
  };
}

export function text(parts: string[], options: { delayMs?: number } = {}): Responder {
  return async (_request, res) => {
    writeSseHead(res);
    for (const part of parts) {
      writeSse(res, { choices: [{ index: 0, delta: { content: part } }] });
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
    writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  };
}

export type FakeChatModel = {
  port: number;
  /** `http://127.0.0.1:<port>/v1`, for `CESIUM_BASE_URL`. */
  baseUrl: string;
  script(key: string, ...responders: Responder[]): void;
  requestsFor(key: string): ChatRequest[];
  close(): Promise<void>;
};

export async function startFakeChatModel(
  keyOf: (request: ChatRequest) => string = projectScriptKey
): Promise<FakeChatModel> {
  const scripts = new Map<string, Responder[]>();
  const requests = new Map<string, ChatRequest[]>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        if (!Array.isArray(body.tools) || body.tools.length === 0) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: "Generated Title" } }] }));
          return;
        }
        const key = keyOf(body);
        requests.set(key, [...(requests.get(key) ?? []), body]);
        const responder = scripts.get(key)?.shift() ?? text([`${key}: acknowledged.`]);
        await responder(body, res);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    script(key, ...responders) {
      scripts.set(key, [...(scripts.get(key) ?? []), ...responders]);
    },
    requestsFor(key) {
      return requests.get(key) ?? [];
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000
): Promise<T> {
  const startedAt = Date.now();
  let last: T | null | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    last = await probe();
    if (last != null && predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)?.slice(0, 3000)}`);
}
