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

test("Cesium chat adapter asks for stream usage and reports it with cached tokens", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":800},"completion_tokens_details":{"reasoning_tokens":10}}}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const result = await runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://usage.invalid/v1",
    providerId: "usagehost",
    modelId: "usagehost/test-model",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(requestBody?.stream_options, { include_usage: true });
  assert.deepEqual(result.usage, {
    inputTokens: 900,
    outputTokens: 30,
    cachedInputTokens: 800,
    reasoningTokens: 10,
  });
});

test("Cesium chat adapter retries without stream_options when a host rejects it, and remembers", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (body.stream_options) {
      return new Response('{"error":"Unrecognized request argument supplied: stream_options"}', { status: 400 });
    }
    return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
  };
  const input = {
    apiKind: "openai-compatible" as const,
    apiKey: "test-key",
    baseUrl: "https://strict.invalid/v1",
    providerId: "stricthost",
    modelId: "stricthost/test-model",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  assert.equal((await runAdapter(input)).text, "ok");
  assert.equal((await runAdapter(input)).text, "ok");
  assert.deepEqual(
    bodies.map((body) => Boolean(body.stream_options)),
    [true, false, false]
  );
});

test("Cesium Responses adapter reports usage from response.completed", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":500,"output_tokens":40,"input_tokens_details":{"cached_tokens":450},"output_tokens_details":{"reasoning_tokens":25}}}}\n\n',
    ]);

  const result = await runAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(result.usage, {
    inputTokens: 500,
    outputTokens: 40,
    cachedInputTokens: 450,
    reasoningTokens: 25,
  });
});

test("Cesium Anthropic adapter counts cache reads and writes as input", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const result = await runAdapter({
    apiKind: "anthropic",
    apiKey: "test-key",
    providerId: "anthropic",
    modelId: "anthropic/claude-test",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(result.usage, {
    inputTokens: 4320,
    outputTokens: 7,
    cachedInputTokens: 4000,
    cacheWriteTokens: 300,
  });
});

test("Cesium Google adapter reads usageMetadata with thinking tokens as output", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 50, thoughtsTokenCount: 30, cachedContentTokenCount: 1000 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const result = await runAdapter({
    apiKind: "google-genai",
    apiKey: "test-key",
    providerId: "google",
    modelId: "google/gemini-test",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(result.usage, {
    inputTokens: 1200,
    outputTokens: 80,
    cachedInputTokens: 1000,
    reasoningTokens: 30,
  });
});

test("Cesium chat adapter reports finish_reason length and flags tool arguments cut off mid-JSON", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_w","function":{"name":"write_file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"line 1\\\\nline"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  };

  const result = await runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Write a big file" }],
    maxOutputTokens: 16_384,
  });

  assert.equal(requestBody?.max_tokens, 16_384);
  assert.equal(result.stopReason, "length");
  assert.equal(result.toolRequests.length, 1);
  assert.deepEqual(result.toolRequests[0]?.arguments, {});
  assert.equal(result.toolRequests[0]?.unparsedArgumentChars, 39);
});

test("Cesium chat adapter does not flag a tool call with no arguments", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_g","function":{"name":"goal_get","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

  const result = await runAdapter({
    apiKind: "openai-compatible",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Get the goal" }],
  });

  assert.equal(result.stopReason, "tool_calls");
  assert.equal(result.toolRequests[0]?.unparsedArgumentChars, undefined);
});

test("Cesium Responses adapter reports max_output_tokens truncation and takes calls only from finished items", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return sseResponse([
      'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_r","name":"grep","arguments":""}}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_r","name":"grep","arguments":"{\\"pattern\\":\\"x\\"}"}}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ]);
  };

  const result = await runAdapter({
    apiKind: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    providerId: "example",
    modelId: "example/test-model",
    messages: [{ role: "user", content: "Search" }],
    maxOutputTokens: 12_000,
  });

  assert.equal(requestBody?.max_output_tokens, 12_000);
  assert.equal(result.stopReason, "length");
  assert.deepEqual(
    result.toolRequests.map((request) => [request.id, request.arguments]),
    [["call_r", { pattern: "x" }]]
  );
});

test("Cesium Anthropic and Google adapters fall back to a JSON body and report max-token stop reasons", async () => {
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("anthropic")
          ? { content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }
          : { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] }
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const anthropic = await runAdapter({
    apiKind: "anthropic",
    apiKey: "test-key",
    providerId: "anthropic",
    modelId: "anthropic/claude-test",
    messages: [{ role: "user", content: "hi" }],
  });
  const google = await runAdapter({
    apiKind: "google-genai",
    apiKey: "test-key",
    providerId: "google",
    modelId: "google/gemini-test",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(anthropic.stopReason, "length");
  assert.equal(google.stopReason, "length");
});

/** One SSE frame, with the `event:` line Anthropic sends before each payload. */
function anthropicFrame(payload: { type: string } & Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(stream: AsyncIterable<CesiumAdapterStreamEvent>): Promise<CesiumAdapterStreamEvent[]> {
  const events: CesiumAdapterStreamEvent[] = [];
  for await (const event of stream) {
    if (event.kind !== "raw") {
      events.push(event);
    }
  }
  return events;
}

test("Cesium Anthropic adapter streams text, assembles split tool input, and merges usage", async () => {
  let requestUrl = "";
  let requestHeaders: Headers | null = null;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return sseResponse([
      anthropicFrame({
        type: "message_start",
        message: { id: "msg_1", usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40, output_tokens: 1 } },
      }),
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } }),
      anthropicFrame({ type: "content_block_stop", index: 0 }),
      anthropicFrame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "src/' } }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'a.ts"}' } }),
      anthropicFrame({ type: "content_block_stop", index: 1 }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 57 } }),
      anthropicFrame({ type: "message_stop" }),
    ]);
  };

  const events = await collect(
    streamAdapter({
      apiKind: "anthropic",
      apiKey: "sk-ant-test",
      providerId: "anthropic",
      modelId: "anthropic/claude-test",
      messages: [
        { role: "system", content: "You are Cesium." },
        { role: "user", content: "Read a.ts" },
      ],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } }],
      promptCacheKey: "conv-1",
    })
  );

  assert.equal(requestUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(requestHeaders?.get("x-api-key"), "sk-ant-test");
  assert.equal(requestBody?.stream, true);
  const system = requestBody?.system as Array<Record<string, unknown>>;
  assert.deepEqual(system.at(-1)?.cache_control, { type: "ephemeral" }, "cache breakpoints survive streaming");
  assert.deepEqual(
    events.filter((event) => event.kind === "text_delta").map((event) => event.text),
    ["Let me ", "look."]
  );
  const toolRequest = events.find((event) => event.kind === "tool_request");
  assert.deepEqual(
    toolRequest?.kind === "tool_request" ? [toolRequest.request.id, toolRequest.request.name, toolRequest.request.arguments] : null,
    ["toolu_1", "read_file", { path: "src/a.ts" }]
  );
  const usage = events.find((event) => event.kind === "usage");
  assert.deepEqual(usage?.kind === "usage" ? usage.usage : null, {
    inputTokens: 3052,
    outputTokens: 57,
    cachedInputTokens: 3000,
    cacheWriteTokens: 40,
  });
  assert.deepEqual(events.at(-1), { kind: "done", stopReason: "tool_calls" });
});

test("Cesium Anthropic adapter keeps OAuth and Copilot auth when streaming", async () => {
  const seen: Array<{ authorization: string | null; beta: string | null; initiator: string | null; stream: unknown }> = [];
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      authorization: headers.get("authorization"),
      beta: headers.get("anthropic-beta"),
      initiator: headers.get("x-initiator"),
      stream: (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>).stream,
    });
    return sseResponse([
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);
  };
  for (const providerId of ["anthropic", "github-copilot"]) {
    const result = await runAdapter({
      apiKind: "anthropic",
      apiKey: "oauth-token",
      providerId,
      modelId: `${providerId}/claude-test`,
      messages: [{ role: "user", content: "hi" }],
      oauth: { providerId, headers: {} },
    });
    assert.equal(result.text, "ok");
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(seen[0]?.authorization, "Bearer oauth-token");
  assert.ok(seen[0]?.beta, "Claude subscription requests keep the OAuth beta flags");
  assert.equal(seen[1]?.authorization, "Bearer oauth-token");
  assert.ok(seen[1]?.initiator, "Copilot requests keep X-Initiator");
  assert.deepEqual(seen.map((entry) => entry.stream), [true, true]);
});

test("Cesium Anthropic adapter reports max_tokens and flags a tool input cut off mid-JSON", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      anthropicFrame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }),
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_w", name: "write_file", input: {} } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt","content":"aaaa' } }),
      anthropicFrame({ type: "content_block_stop", index: 0 }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } }),
      anthropicFrame({ type: "message_stop" }),
    ]);

  const result = await runAdapter({
    apiKind: "anthropic",
    apiKey: "sk-ant-test",
    providerId: "anthropic",
    modelId: "anthropic/claude-test",
    messages: [{ role: "user", content: "Write a.txt" }],
  });

  assert.equal(result.stopReason, "length");
  assert.equal(result.toolRequests.length, 1);
  assert.deepEqual(result.toolRequests[0]?.arguments, {});
  assert.equal(result.toolRequests[0]?.unparsedArgumentChars, 31);
  assert.equal(result.usage?.outputTokens, 8192);
});

test("Cesium Anthropic adapter surfaces thinking deltas as reasoning and stream errors as failures", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Consider it." } }),
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      anthropicFrame({ type: "content_block_stop", index: 0 }),
      anthropicFrame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } }),
      anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);
  const result = await runAdapter({
    apiKind: "anthropic",
    apiKey: "sk-ant-test",
    providerId: "anthropic",
    modelId: "anthropic/claude-test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.reasoning, "Consider it.");
  assert.equal(result.text, "Answer.");

  globalThis.fetch = async () =>
    sseResponse([
      anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half" } }),
      anthropicFrame({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ]);
  await assert.rejects(
    runAdapter({
      apiKind: "anthropic",
      apiKey: "sk-ant-test",
      providerId: "anthropic",
      modelId: "anthropic/claude-test",
      messages: [{ role: "user", content: "hi" }],
    }),
    /overloaded_error: Overloaded/
  );
});

test("Cesium Google adapter streams text, thoughts, function calls, and the final usage over SSE", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return sseResponse([
      sseFrame({ candidates: [{ content: { role: "model", parts: [{ text: "Weighing it.", thought: true }] } }] }),
      sseFrame({
        candidates: [{ content: { role: "model", parts: [{ text: "Checking " }] } }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 2 },
      }),
      sseFrame({ candidates: [{ content: { role: "model", parts: [{ text: "the file." }] } }] }),
      sseFrame({
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30, thoughtsTokenCount: 12 },
      }),
    ]);
  };

  const events = await collect(
    streamAdapter({
      apiKind: "google-genai",
      apiKey: "test-key",
      providerId: "google",
      modelId: "google/gemini-test",
      messages: [{ role: "user", content: "Read a.ts" }],
    })
  );

  assert.equal(
    requests[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=test-key"
  );
  assert.equal(requests[0]?.authorization, null);
  assert.deepEqual(
    events.filter((event) => event.kind === "text_delta").map((event) => event.text),
    ["Checking ", "the file."]
  );
  assert.deepEqual(
    events.filter((event) => event.kind === "reasoning_delta").map((event) => event.text),
    ["Weighing it."]
  );
  const toolRequest = events.find((event) => event.kind === "tool_request");
  assert.deepEqual(
    toolRequest?.kind === "tool_request" ? [toolRequest.request.name, toolRequest.request.arguments] : null,
    ["read_file", { path: "a.ts" }]
  );
  const usage = events.filter((event) => event.kind === "usage");
  assert.equal(usage.length, 1, "cumulative usageMetadata is reported once, from the last chunk");
  assert.deepEqual(usage[0]?.kind === "usage" ? usage[0].usage : null, {
    inputTokens: 900,
    outputTokens: 42,
    reasoningTokens: 12,
  });
  assert.deepEqual(events.at(-1), { kind: "done", stopReason: "stop" });

  await collect(
    streamAdapter({
      apiKind: "google-genai",
      apiKey: "oauth-token",
      providerId: "google",
      modelId: "google/gemini-test",
      messages: [{ role: "user", content: "hi" }],
      oauth: { providerId: "google-gemini-cli", headers: {} },
    })
  );
  assert.equal(
    requests[1]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
  );
  assert.equal(requests[1]?.authorization, "Bearer oauth-token");
});

test("Cesium Google adapter reports MAX_TOKENS from the stream and reads a JSON array body", async () => {
  globalThis.fetch = async () =>
    sseResponse([
      sseFrame({ candidates: [{ content: { parts: [{ text: "Cut" }] } }] }),
      sseFrame({ candidates: [{ content: { parts: [{ text: " off" }] }, finishReason: "MAX_TOKENS" }] }),
    ]);
  const streamed = await runAdapter({
    apiKind: "google-genai",
    apiKey: "test-key",
    providerId: "google",
    modelId: "google/gemini-test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(streamed.text, "Cut off");
  assert.equal(streamed.stopReason, "length");

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        { candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
        { candidates: [{ content: { parts: [{ text: "there." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } },
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const json = await runAdapter({
    apiKind: "google-genai",
    apiKey: "test-key",
    providerId: "google",
    modelId: "google/gemini-test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(json.text, "Hello there.");
  assert.equal(json.stopReason, "stop");
  assert.deepEqual(json.usage, { inputTokens: 5, outputTokens: 3 });
});
