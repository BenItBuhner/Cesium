import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAdapter, streamAdapter } from "../src/lib/agents/cesium/cesium-model-adapters.js";
import type { CesiumAdapterStreamEvent } from "../src/lib/agents/cesium/cesium-types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    { status: 200 }
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  assert.equal(typeof init?.body, "string");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

test("Cesium OpenAI Responses adapter yields text deltas as SSE frames arrive", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      "data: [DONE]\n\n",
    ]);

  const events: CesiumAdapterStreamEvent[] = [];
  for await (const event of streamAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say hello" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])),
    ["Hel", "lo"]
  );
  assert.equal(events.some((event) => event.kind === "done"), true);
});

test("Cesium batch adapter compatibility accumulates streamed deltas", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"fast "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"path"}\n\n',
      "data: [DONE]\n\n",
    ]);

  const result = await runAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say fast path" }],
  });

  assert.equal(result.text, "fast path");
  assert.deepEqual(result.toolRequests, []);
});

test("Cesium OpenAI-compatible chat adapter normalizes usage and forwards output limit", async () => {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    requestBody = parseRequestBody(init);
    return jsonResponse({
      choices: [{ message: { content: "chat result" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  };

  const result = await runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    maxOutputTokens: 2048.9,
    messages: [{ role: "user", content: "Say hello" }],
  });

  assert.equal(result.text, "chat result");
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
  });
  assert.equal(requestBody?.max_tokens, 2048);
});

test("Cesium OpenAI Responses stream adapter emits final usage and clamps output limit", async () => {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    requestBody = parseRequestBody(init);
    return sseResponse([
      'data: {"type":"response.output_text.delta","delta":"streamed"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const events: CesiumAdapterStreamEvent[] = [];
  for await (const event of streamAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    maxOutputTokens: 0,
    messages: [{ role: "user", content: "Say hello" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])),
    ["streamed"]
  );
  assert.deepEqual(events.find((event) => event.kind === "done"), {
    kind: "done",
    raw: {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 18,
        },
      },
    },
    usage: {
      inputTokens: 13,
      outputTokens: 5,
      totalTokens: 18,
    },
  });
  assert.equal(requestBody?.max_output_tokens, 1);
});

test("Cesium batch adapter accumulates OpenAI Responses stream usage", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"usage"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
      "data: [DONE]\n\n",
    ]);

  const result = await runAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say hello" }],
  });

  assert.equal(result.text, "usage");
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });
});

test("Cesium adapters forward workflow cancellation to active provider requests", async () => {
  globalThis.fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const rejectAbort = () => {
        const error = new Error("provider request aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener("abort", rejectAbort, { once: true });
      if (signal?.aborted) {
        rejectAbort();
      }
    });

  const controller = new AbortController();
  const pending = runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Wait forever" }],
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});
