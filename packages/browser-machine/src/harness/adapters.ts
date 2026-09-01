/**
 * Streaming model adapters (browser fetch + SSE): OpenAI chat completions
 * (also used for OpenAI-compatible proxies), OpenAI Responses, and Anthropic
 * Messages. Reasoning deltas stream when providers expose them.
 */
import type { CesiumProviderKind } from "@cesium/core";

export type AdapterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type AdapterMessage =
  | { role: "system" | "user"; content: string | AdapterContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type AdapterToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AdapterToolCall = { id: string; name: string; argsJson: string };

export type AdapterResult = {
  text: string;
  toolCalls: AdapterToolCall[];
  stopReason: string | null;
};

export type AdapterCallbacks = {
  onTextDelta(text: string): void;
  onReasoningDelta(text: string): void;
};

export type AdapterRequest = {
  apiKind: CesiumProviderKind;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  messages: AdapterMessage[];
  tools: AdapterToolDefinition[];
  signal?: AbortSignal;
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * POST to a provider endpoint: direct first (works when the provider sends
 * CORS headers), then through the same-origin /api/inference-relay when the
 * direct call is blocked (no CORS, sandboxed network, etc.).
 */
async function providerFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (directError) {
    const canRelay =
      typeof location !== "undefined" &&
      (location.protocol === "http:" || location.protocol === "https:");
    if (!canRelay) throw directError;
    try {
      const headers = new Headers(init.headers);
      headers.set("x-cesium-upstream-url", url);
      return await fetch("/api/inference-relay", { ...init, headers });
    } catch {
      throw directError;
    }
  }
}

async function* sseEvents(
  response: Response
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (line === "") {
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
        }
        eventName = null;
        dataLines = [];
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // fall through
  }
  return text.slice(0, 400) || `HTTP ${response.status}`;
}

async function streamOpenAiChatCompletions(
  request: AdapterRequest,
  callbacks: AdapterCallbacks
): Promise<AdapterResult> {
  const response = await providerFetch(`${trimBase(request.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: request.modelId,
      messages: request.messages,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      stream: true,
    }),
    signal: request.signal ?? null,
  });
  if (!response.ok) {
    throw new Error(`Provider responded ${response.status}: ${await readErrorBody(response)}`);
  }
  let text = "";
  let stopReason: string | null = null;
  const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
  for await (const { data } of sseEvents(response)) {
    if (data === "[DONE]") break;
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) {
      text += delta.content;
      callbacks.onTextDelta(delta.content);
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) {
      callbacks.onReasoningDelta(reasoning);
    }
    for (const toolDelta of delta?.tool_calls ?? []) {
      const index = toolDelta.index ?? 0;
      const existing = toolCalls.get(index) ?? { id: "", name: "", argsJson: "" };
      if (toolDelta.id) existing.id = toolDelta.id;
      if (toolDelta.function?.name) existing.name += toolDelta.function.name;
      if (toolDelta.function?.arguments) existing.argsJson += toolDelta.function.arguments;
      toolCalls.set(index, existing);
    }
    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
    }
  }
  return {
    text,
    toolCalls: [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        argsJson: call.argsJson || "{}",
      })),
    stopReason,
  };
}

/** Convert chat-style messages into Responses API input items. */
function toResponsesInput(messages: AdapterMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        items.push({
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        items.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? { type: "input_text", text: part.text }
            : { type: "input_image", image_url: part.image_url.url }
        )
      : [{ type: "input_text", text: message.content }];
    items.push({ role: message.role, content });
  }
  return items;
}

async function streamOpenAiResponses(
  request: AdapterRequest,
  callbacks: AdapterCallbacks
): Promise<AdapterResult> {
  const systemMessage = request.messages.find(
    (message): message is Extract<AdapterMessage, { role: "system" | "user" }> =>
      message.role === "system"
  );
  const rest = request.messages.filter((message) => message.role !== "system");
  const response = await providerFetch(`${trimBase(request.baseUrl)}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: request.modelId,
      ...(systemMessage
        ? {
            instructions:
              typeof systemMessage.content === "string"
                ? systemMessage.content
                : systemMessage.content
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join("\n"),
          }
        : {}),
      input: toResponsesInput(rest),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }
        : {}),
      stream: true,
    }),
    signal: request.signal ?? null,
  });
  if (!response.ok) {
    throw new Error(`Provider responded ${response.status}: ${await readErrorBody(response)}`);
  }
  let text = "";
  let stopReason: string | null = null;
  const toolCalls: AdapterToolCall[] = [];
  const pendingCalls = new Map<string, { callId: string; name: string; argsJson: string }>();
  for await (const { data } of sseEvents(response)) {
    if (data === "[DONE]") break;
    let event: {
      type?: string;
      delta?: string;
      item?: {
        type?: string;
        id?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      };
      item_id?: string;
      response?: { status?: string };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          text += event.delta;
          callbacks.onTextDelta(event.delta);
        }
        break;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        if (event.delta) callbacks.onReasoningDelta(event.delta);
        break;
      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          pendingCalls.set(event.item.id ?? event.item.call_id ?? "", {
            callId: event.item.call_id ?? event.item.id ?? "",
            name: event.item.name ?? "",
            argsJson: event.item.arguments ?? "",
          });
        }
        break;
      case "response.function_call_arguments.delta": {
        const pending = pendingCalls.get(event.item_id ?? "");
        if (pending && event.delta) pending.argsJson += event.delta;
        break;
      }
      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          const pending = pendingCalls.get(event.item.id ?? event.item.call_id ?? "");
          toolCalls.push({
            id: event.item.call_id ?? pending?.callId ?? crypto.randomUUID(),
            name: event.item.name ?? pending?.name ?? "",
            argsJson: event.item.arguments ?? pending?.argsJson ?? "{}",
          });
        }
        break;
      case "response.completed":
        stopReason = event.response?.status ?? "completed";
        break;
      case "response.failed":
        throw new Error("Provider reported a failed response.");
      default:
        break;
    }
  }
  return { text, toolCalls, stopReason };
}

async function streamAnthropicMessages(
  request: AdapterRequest,
  callbacks: AdapterCallbacks
): Promise<AdapterResult> {
  const systemMessage = request.messages.find(
    (message): message is Extract<AdapterMessage, { role: "system" | "user" }> =>
      message.role === "system"
  );
  const conversation = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: message.content,
            },
          ],
        };
      }
      if (message.role === "assistant") {
        const blocks: unknown[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const toolCall of message.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || "{}") as unknown,
          });
        }
        return { role: "assistant" as const, content: blocks };
      }
      const content = Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: part.image_url.url.match(/^data:([^;]+);/)?.[1] ?? "image/png",
                    data: part.image_url.url.replace(/^data:[^,]+,/, ""),
                  },
                }
          )
        : [{ type: "text", text: message.content }];
      return { role: "user" as const, content };
    });

  const response = await providerFetch(`${trimBase(request.baseUrl) || "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(request.apiKey ? { "x-api-key": request.apiKey } : {}),
    },
    body: JSON.stringify({
      model: request.modelId,
      max_tokens: 16_000,
      ...(systemMessage
        ? {
            system:
              typeof systemMessage.content === "string"
                ? systemMessage.content
                : systemMessage.content
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join("\n"),
          }
        : {}),
      messages: conversation,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      stream: true,
    }),
    signal: request.signal ?? null,
  });
  if (!response.ok) {
    throw new Error(`Provider responded ${response.status}: ${await readErrorBody(response)}`);
  }
  let text = "";
  let stopReason: string | null = null;
  const toolCalls: AdapterToolCall[] = [];
  const blockTypes = new Map<number, string>();
  const blockTool = new Map<number, { id: string; name: string; argsJson: string }>();
  for await (const { data } of sseEvents(response)) {
    let event: {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        stop_reason?: string;
      };
    };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "content_block_start" && typeof event.index === "number") {
      blockTypes.set(event.index, event.content_block?.type ?? "text");
      if (event.content_block?.type === "tool_use") {
        blockTool.set(event.index, {
          id: event.content_block.id ?? crypto.randomUUID(),
          name: event.content_block.name ?? "",
          argsJson: "",
        });
      }
    } else if (event.type === "content_block_delta" && typeof event.index === "number") {
      if (event.delta?.type === "text_delta" && event.delta.text) {
        text += event.delta.text;
        callbacks.onTextDelta(event.delta.text);
      } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
        callbacks.onReasoningDelta(event.delta.thinking);
      } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
        const tool = blockTool.get(event.index);
        if (tool) tool.argsJson += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop" && typeof event.index === "number") {
      const tool = blockTool.get(event.index);
      if (tool) {
        toolCalls.push({ id: tool.id, name: tool.name, argsJson: tool.argsJson || "{}" });
        blockTool.delete(event.index);
      }
    } else if (event.type === "message_delta") {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    }
  }
  return { text, toolCalls, stopReason };
}

export async function streamModelTurn(
  request: AdapterRequest,
  callbacks: AdapterCallbacks
): Promise<AdapterResult> {
  switch (request.apiKind) {
    case "anthropic":
      return streamAnthropicMessages(request, callbacks);
    case "openai-responses":
      return streamOpenAiResponses(request, callbacks);
    case "openai-realtime":
      throw new Error("The realtime API is not supported on the browser machine.");
    case "google-genai":
      // Gemini's OpenAI-compat endpoint keeps this path simple for v1.
      return streamOpenAiChatCompletions(request, callbacks);
    case "openai-chat-completions":
    case "openai-compatible":
    default:
      return streamOpenAiChatCompletions(request, callbacks);
  }
}
