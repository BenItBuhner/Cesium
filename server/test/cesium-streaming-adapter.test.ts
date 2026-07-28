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

const TIMEOUT = Symbol("timeout");

function waitForTimeout(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms));
}

async function nextMatchingEvent(
  iterator: AsyncIterator<CesiumAdapterStreamEvent>,
  predicate: (event: CesiumAdapterStreamEvent) => boolean,
  timeoutMs = 100
): Promise<CesiumAdapterStreamEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      assert.fail("Timed out waiting for matching stream event");
    }
    const result = await Promise.race([iterator.next(), waitForTimeout(remaining)]);
    if (result === TIMEOUT) {
      assert.fail("Timed out waiting for matching stream event");
    }
    if (result.done) {
      assert.fail("Stream ended before matching event arrived");
    }
    if (predicate(result.value)) {
      return result.value;
    }
  }
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

test("Cesium OpenAI-compatible chat adapter yields content deltas before stream closes", async () => {
  const encoder = new TextEncoder();
  let releaseSecondFrame!: () => void;
  const secondFrameAllowed = new Promise<void>((resolve) => {
    releaseSecondFrame = resolve;
  });
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n')
          );
          void secondFrameAllowed.then(() => {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          });
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };

  const iterator = streamAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say hello" }],
  })[Symbol.asyncIterator]();

  const first = await nextMatchingEvent(
    iterator,
    (event) => event.kind === "text_delta",
    50
  );
  assert.deepEqual(requestBody?.stream, true);
  assert.equal(first.kind, "text_delta");
  assert.equal(first.text, "Hel");

  releaseSecondFrame();
  const second = await nextMatchingEvent(
    iterator,
    (event) => event.kind === "text_delta",
    50
  );
  assert.equal(second.kind, "text_delta");
  assert.equal(second.text, "lo");
});

test("Cesium chat adapter streams reasoning and emits assembled tool calls only at completion", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":"{\\"pattern\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"stream\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

  const events: CesiumAdapterStreamEvent[] = [];
  for await (const event of streamAdapter({
    apiKind: "openai-chat-completions",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Search" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.flatMap((event) => (event.kind === "reasoning_delta" ? [event.text] : [])),
    ["think "]
  );
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])),
    ["Done"]
  );
  const toolIndex = events.findIndex((event) => event.kind === "tool_request");
  const doneIndex = events.findIndex((event) => event.kind === "done");
  assert.equal(toolIndex, doneIndex - 1);
  const tool = events[toolIndex];
  assert.equal(tool?.kind, "tool_request");
  assert.equal(tool.request.id, "call_1");
  assert.equal(tool.request.name, "grep");
  assert.deepEqual(tool.request.arguments, { pattern: "stream" });
});

test("Cesium chat adapter falls back when upstream ignores stream=true", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "fallback text" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const events: CesiumAdapterStreamEvent[] = [];
  for await (const event of streamAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say hello" }],
  })) {
    events.push(event);
  }

  assert.equal(requestBody?.stream, true);
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "text_delta" ? [event.text] : [])),
    ["fallback text"]
  );
  assert.equal(events.some((event) => event.kind === "done"), true);
});

test("Cesium batch adapter compatibility accumulates streamed chat deltas and tool calls", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"fast "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"path"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

  const result = await runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Say fast path" }],
  });

  assert.equal(result.text, "fast path");
  assert.equal(result.toolRequests.length, 1);
  assert.equal(result.toolRequests[0]?.name, "read_file");
  assert.deepEqual(result.toolRequests[0]?.arguments, { path: "README.md" });
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
