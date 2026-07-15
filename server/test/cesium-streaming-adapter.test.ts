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
