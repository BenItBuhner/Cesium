import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { CesiumProviderKind } from "../../cesium-agent-settings.js";
import { asRecord, asString, parseJsonArgs } from "./cesium-coerce.js";
import { CESIUM_SYSTEM_PROMPT, DEFAULT_MAX_OUTPUT_TOKENS } from "./cesium-prompt.js";
import { repairOpenAiMessageSequence, satisfyOpenAiToolProtocol } from "./cesium-history.js";
import {
  anthropicTools,
  createCesiumToolRequest,
  googleTools,
  openAiTools,
  responseTools,
  type CesiumToolDefinition,
} from "./cesium-tools.js";
import type {
  CesiumAdapterResult,
  CesiumAdapterStreamEvent,
  CesiumHistoryMessage,
  CesiumToolRequest,
} from "./cesium-types.js";

/** Omit tools when the caller passed an empty list (tool-less child turns). */
function optionalProviderTools(
  tools: CesiumToolDefinition[] | undefined,
  build: (tools?: CesiumToolDefinition[]) => unknown
): unknown | undefined {
  if (tools && tools.length === 0) {
    return undefined;
  }
  return build(tools);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function modelPart(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

export function providerPart(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/", 1)[0]! : "openai";
}

function resolveOpenAiCompatibleBaseUrl(baseUrl: string | undefined, providerId: string): string {
  const trimmed = baseUrl?.trim();
  if (trimmed) {
    return trimmed.replace(/\/+$/, "");
  }
  if (providerPart(providerId) === "openai") {
    return "https://api.openai.com/v1";
  }
  throw new Error(
    `No API base URL for provider ${providerId}. Save a ${providerId} key in Cesium settings and refresh models.dev.`
  );
}

export function openAiMessages(messages: CesiumHistoryMessage[]) {
  return satisfyOpenAiToolProtocol(repairOpenAiMessageSequence(messages)).map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? message.name ?? randomUUID(),
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      };
    }
    if (message.role === "user" && message.images && message.images.length > 0) {
      return {
        role: "user",
        content: [
          ...(message.content.trim()
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...message.images.map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: toDataUrl(image.mimeType, image.data),
            },
          })),
        ],
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function toDataUrl(mimeType: string, data: string): string {
  const trimmed = data.trim();
  if (trimmed.startsWith("data:")) {
    return trimmed;
  }
  return `data:${mimeType || "image/png"};base64,${trimmed}`;
}

async function runOpenAiChat(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
}): Promise<CesiumAdapterResult> {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
  const tools =
    input.tools && input.tools.length === 0 ? undefined : openAiTools(input.tools);
  const payload = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: openAiMessages(input.messages),
      ...(tools ? { tools, tool_choice: "auto" as const } : {}),
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    }),
  });
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    text: asString(message?.content) ?? "",
    reasoning: asString(message?.reasoning),
    toolRequests: toolCalls.flatMap((toolCall): CesiumToolRequest[] => {
      const record = asRecord(toolCall);
      const fn = asRecord(record?.function);
      const name = asString(fn?.name);
      if (!record || !name) {
        return [];
      }
      return [createCesiumToolRequest(
        asString(record.id) ?? randomUUID(),
        name,
        parseJsonArgs(fn?.arguments)
      )];
    }),
    raw: payload,
  };
}

async function* streamOpenAiResponses(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
}): AsyncGenerator<CesiumAdapterStreamEvent> {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
  const tools = optionalProviderTools(input.tools, responseTools);
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: input.messages.map((message) => {
        if (message.role === "user" && message.images?.length) {
          return {
            role: "user",
            content: [
              ...(message.content.trim()
                ? [{ type: "input_text", text: message.content }]
                : []),
              ...message.images.map((image) => ({
                type: "input_image",
                image_url: toDataUrl(image.mimeType, image.data),
              })),
            ],
          };
        }
        return {
          role: message.role === "system" ? "developer" : message.role,
          content: message.content,
        };
      }),
      ...(tools ? { tools } : {}),
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  if (response.body) {
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split(/\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());
        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") {
            continue;
          }
          const event = parseJsonArgs(dataLine);
          yield { kind: "raw", raw: event };
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            yield { kind: "text_delta", text: event.delta, raw: event };
          }
          const item = asRecord(event.item);
          if (item?.type === "function_call") {
            const name = asString(item.name);
            if (name) {
              yield {
                kind: "tool_request",
                request: createCesiumToolRequest(
                  asString(item.call_id) ?? asString(item.id) ?? randomUUID(),
                  name,
                  parseJsonArgs(item.arguments)
                ),
                raw: event,
              };
            }
          }
        }
      }
    }
    yield { kind: "done" };
    return;
  }
  const payload = await response.json();
  const record = asRecord(payload);
  const output = Array.isArray(record?.output) ? record.output : [];
  const toolRequests: CesiumToolRequest[] = [];
  const textParts: string[] = [];
  for (const item of output) {
    const out = asRecord(item);
    if (!out) continue;
    if (out.type === "function_call") {
      const name = asString(out.name);
      if (name) {
        toolRequests.push(
          createCesiumToolRequest(
            asString(out.call_id) ?? asString(out.id) ?? randomUUID(),
            name,
            parseJsonArgs(out.arguments)
          )
        );
      }
    }
    if (Array.isArray(out.content)) {
      for (const content of out.content) {
        const c = asRecord(content);
        const text = asString(c?.text);
        if (text) textParts.push(text);
      }
    }
  }
  const text = asString(record?.output_text) ?? textParts.join("");
  if (text) {
    yield { kind: "text_delta", text, raw: payload };
  }
  const reasoning = asString(record?.reasoning);
  if (reasoning) {
    yield { kind: "reasoning_delta", text: reasoning, raw: payload };
  }
  for (const request of toolRequests) {
    yield { kind: "tool_request", request, raw: payload };
  }
  yield { kind: "done", raw: payload };
}

async function* streamOpenAiRealtime(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
}): AsyncGenerator<CesiumAdapterStreamEvent> {
  type QueueItem =
    | { kind: "event"; event: CesiumAdapterStreamEvent }
    | { kind: "error"; error: Error }
    | { kind: "closed" };
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(input.model)}`, {
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "openai-beta": "realtime=v1",
    },
  });
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;
  let completed = false;
  const push = (item: QueueItem) => {
    queue.push(item);
    notify?.();
    notify = null;
  };
  ws.on("open", () => {
    const tools = optionalProviderTools(input.tools, responseTools);
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text"],
        instructions: CESIUM_SYSTEM_PROMPT,
        ...(tools ? { tools } : {}),
      },
    }));
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") }],
      },
    }));
    ws.send(JSON.stringify({ type: "response.create" }));
  });
  ws.on("message", (data) => {
    const event = parseJsonArgs(data.toString());
    push({ kind: "event", event: { kind: "raw", raw: event } });
    if (event.type === "response.text.delta" && typeof event.delta === "string") {
      push({ kind: "event", event: { kind: "text_delta", text: event.delta, raw: event } });
    }
    if (event.type === "response.done") {
      completed = true;
      push({ kind: "event", event: { kind: "done", raw: event } });
      push({ kind: "closed" });
      ws.close();
    }
  });
  ws.on("error", (error) => {
    push({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
  });
  ws.on("close", () => {
    if (!completed) {
      push({ kind: "closed" });
    }
  });

  try {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const item = queue.shift();
      if (!item) {
        continue;
      }
      if (item.kind === "error") {
        throw item.error;
      }
      if (item.kind === "closed") {
        return;
      }
      yield item.event;
    }
  } finally {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

function anthropicMessages(messages: CesiumHistoryMessage[]) {
  return repairOpenAiMessageSequence(messages)
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId ?? message.name ?? randomUUID(),
              content: message.content,
            },
          ],
        };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        const blocks: Array<Record<string, unknown>> = [];
        if (message.content.trim()) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: parseJsonArgs(call.arguments),
          });
        }
        return { role: "assistant", content: blocks };
      }
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      };
    });
}

async function runAnthropic(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
}): Promise<CesiumAdapterResult> {
  const tools = optionalProviderTools(input.tools, anthropicTools);
  const payload = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      system: CESIUM_SYSTEM_PROMPT,
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      messages: anthropicMessages(input.messages),
      ...(tools ? { tools } : {}),
    }),
  });
  const root = asRecord(payload);
  const content = Array.isArray(root?.content) ? root.content : [];
  const toolRequests: CesiumToolRequest[] = [];
  const text: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
    } else if (item.type === "tool_use") {
      const name = asString(item.name);
      if (name) {
        toolRequests.push(
          createCesiumToolRequest(
            asString(item.id) ?? randomUUID(),
            name,
            asRecord(item.input) ?? {}
          )
        );
      }
    }
  }
  return { text: text.join(""), toolRequests, raw: payload };
}

function googleContents(messages: CesiumHistoryMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
}

async function runGoogle(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
}): Promise<CesiumAdapterResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const tools = optionalProviderTools(input.tools, googleTools);
  const payload = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: googleContents(input.messages),
      systemInstruction: { parts: [{ text: CESIUM_SYSTEM_PROMPT }] },
      ...(tools ? { tools } : {}),
      generationConfig: {
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      },
    }),
  });
  const root = asRecord(payload);
  const candidates = Array.isArray(root?.candidates)
    ? root.candidates
    : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const parts = Array.isArray(content?.parts)
    ? content.parts
    : [];
  const text: string[] = [];
  const toolRequests: CesiumToolRequest[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string") {
      text.push(record.text);
    }
    const call = asRecord(record.functionCall);
    const name = asString(call?.name);
    if (name) {
      toolRequests.push(
        createCesiumToolRequest(
          randomUUID(),
          name,
          asRecord(call?.args) ?? {}
        )
      );
    }
  }
  return { text: text.join(""), toolRequests, raw: payload };
}

export type RunAdapterInput = {
  apiKind: CesiumProviderKind;
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  modelId: string;
  messages: CesiumHistoryMessage[];
  /** When set, overrides the default composed Cesium tool list (including harness feature modules). */
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
};

async function* streamStaticResult(
  result: CesiumAdapterResult
): AsyncGenerator<CesiumAdapterStreamEvent> {
  if (result.text) {
    yield { kind: "text_delta", text: result.text, raw: result.raw };
  }
  if (result.reasoning) {
    yield { kind: "reasoning_delta", text: result.reasoning, raw: result.raw };
  }
  for (const request of result.toolRequests) {
    yield { kind: "tool_request", request, raw: result.raw };
  }
  yield { kind: "done", raw: result.raw };
}

export async function* streamAdapter(
  input: RunAdapterInput
): AsyncGenerator<CesiumAdapterStreamEvent> {
  const model = modelPart(input.modelId);
  const providerId = providerPart(input.modelId);
  switch (input.apiKind) {
    case "openai-chat-completions":
    case "openai-compatible":
      yield* streamStaticResult(
        await runOpenAiChat({
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          providerId,
          model,
          messages: input.messages,
          tools: input.tools,
        })
      );
      return;
    case "openai-realtime":
      yield* streamOpenAiRealtime({
        apiKey: input.apiKey,
        model,
        messages: input.messages,
        tools: input.tools,
      });
      return;
    case "anthropic":
      yield* streamStaticResult(
        await runAnthropic({
          apiKey: input.apiKey,
          model,
          messages: input.messages,
          tools: input.tools,
        })
      );
      return;
    case "google-genai":
      yield* streamStaticResult(
        await runGoogle({
          apiKey: input.apiKey,
          model,
          messages: input.messages,
          tools: input.tools,
        })
      );
      return;
    case "openai-responses":
    default:
      yield* streamOpenAiResponses({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerId,
        model,
        messages: input.messages,
        tools: input.tools,
      });
      return;
  }
}

export async function runAdapter(input: RunAdapterInput): Promise<CesiumAdapterResult> {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolRequests: CesiumToolRequest[] = [];
  const rawEvents: unknown[] = [];
  let finalRaw: unknown;
  for await (const event of streamAdapter(input)) {
    if ("raw" in event && event.raw !== undefined) {
      finalRaw = event.raw;
      rawEvents.push(event.raw);
    }
    switch (event.kind) {
      case "text_delta":
        textParts.push(event.text);
        break;
      case "reasoning_delta":
        reasoningParts.push(event.text);
        break;
      case "tool_request":
        toolRequests.push(event.request);
        break;
      case "raw":
      case "done":
        break;
    }
  }
  return {
    text: textParts.join(""),
    reasoning: reasoningParts.join("") || undefined,
    toolRequests,
    raw: rawEvents.length > 1 ? rawEvents : finalRaw,
  };
}
