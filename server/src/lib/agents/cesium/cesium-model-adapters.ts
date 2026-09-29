import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { CesiumProviderKind } from "../../cesium-agent-settings.js";
import { asRecord, asString, parseJsonArgs, tryParseJsonArgs } from "./cesium-coerce.js";
import {
  CESIUM_STREAM_IDLE_TIMEOUT_MS,
  CESIUM_SYSTEM_PROMPT,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./cesium-prompt.js";
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
  CesiumStopReason,
  CesiumToolRequest,
} from "./cesium-types.js";
import { usageFromAnthropic, usageFromGoogle, usageFromOpenAi } from "./cesium-usage.js";

/**
 * OAuth request shaping passed through from resolveCesiumAuth. `providerId`
 * selects protocol quirks (ChatGPT Codex backend, Anthropic OAuth betas,
 * Copilot editor headers); `headers` carries provider/model static headers.
 */
export type CesiumOAuthAdapterAuth = {
  providerId: string;
  headers?: Record<string, string>;
};

const ANTHROPIC_OAUTH_BETAS = "claude-code-20250219,oauth-2025-04-20";
const ANTHROPIC_OAUTH_SPOOF = "You are Claude Code, Anthropic's official CLI for Claude.";
const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

/** Collect system message text so provider-native system slots stay faithful. */
function systemPromptFromMessages(messages: CesiumHistoryMessage[]): string {
  const parts = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);
  return parts.join("\n\n");
}

function mergedHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>
): Record<string, string> {
  if (!extra) {
    return base;
  }
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    merged[key.toLowerCase()] = value;
  }
  return merged;
}

/** ChatGPT Codex account id travels inside the OAuth access token JWT. */
function extractChatGptAccountId(token: string): string {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) {
      throw new Error("Invalid token");
    }
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const auth = asRecord(payload["https://api.openai.com/auth"]);
    const accountId = asString(auth?.chatgpt_account_id);
    if (!accountId) {
      throw new Error("No account id in token");
    }
    return accountId;
  } catch {
    throw new Error(
      "Failed to extract the ChatGPT account id from the Codex OAuth token. Reconnect ChatGPT (Codex) in Settings → Agents → Cesium Agent."
    );
  }
}

function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() || CODEX_DEFAULT_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

/** Copilot expects X-Initiator to distinguish user turns from agent follow-ups. */
function copilotInitiator(messages: CesiumHistoryMessage[]): "user" | "agent" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

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

export class CesiumStreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    const idle = idleMs >= 1000 ? `${Math.round(idleMs / 1000)}s` : `${idleMs}ms`;
    super(`The provider sent no data for ${idle}, so the request timed out and was aborted.`);
    this.name = "CesiumStreamIdleTimeoutError";
  }
}

export function cesiumStreamIdleTimeoutMs(): number {
  const override = Number(process.env.CESIUM_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : CESIUM_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * Aborts with `signal` (turn cancel) or once no bytes arrived for the idle
 * timeout. `touch` restarts the idle clock; `release` detaches everything.
 */
function watchProviderRequest(signal: AbortSignal | undefined) {
  const controller = new AbortController();
  const idleMs = cesiumStreamIdleTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(signal?.reason);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new CesiumStreamIdleTimeoutError(idleMs)), idleMs);
    timer.unref?.();
  };
  const release = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
    touch();
  }
  /** The abort reason when this watch aborted the request, else the error as thrown. */
  const explain = (error: unknown): unknown =>
    controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason
      : error;
  return { signal: controller.signal, touch, release, explain };
}

/**
 * `fetch` for provider calls: aborts on the turn's signal and when the
 * response goes idle, whether waiting for headers or between body chunks.
 */
async function providerFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined
): Promise<Response> {
  const watch = watchProviderRequest(signal);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: watch.signal });
  } catch (error) {
    watch.release();
    throw watch.explain(error);
  }
  const source = response.body;
  if (!source) {
    watch.release();
    return response;
  }
  watch.touch();
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          watch.release();
          controller.close();
          return;
        }
        watch.touch();
        controller.enqueue(value);
      } catch (error) {
        watch.release();
        controller.error(watch.explain(error));
      }
    },
    async cancel(reason) {
      watch.release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const response = await providerFetch(url, init, signal);
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

/** A tool request from the model's argument text, flagged when that text is not JSON. */
function toolRequestFromArguments(id: string, name: string, rawArguments: unknown): CesiumToolRequest {
  const parsed = tryParseJsonArgs(rawArguments);
  const request = createCesiumToolRequest(id, name, parsed.args);
  return parsed.ok || typeof rawArguments !== "string"
    ? request
    : { ...request, unparsedArgumentChars: rawArguments.length };
}

function chatStopReason(value: unknown): CesiumStopReason | undefined {
  switch (value) {
    case undefined:
    case null:
      return undefined;
    case "length":
      return "length";
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "other";
  }
}

/** Responses API: `incomplete` with `max_output_tokens` is the truncation case. */
function responsesStopReason(response: Record<string, unknown> | null): CesiumStopReason | undefined {
  if (!response) {
    return undefined;
  }
  if (response.status === "incomplete") {
    return asRecord(response.incomplete_details)?.reason === "max_output_tokens" ? "length" : "other";
  }
  return response.status === "completed" ? "stop" : undefined;
}

function anthropicStopReason(value: unknown): CesiumStopReason | undefined {
  switch (value) {
    case undefined:
    case null:
      return undefined;
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "other";
  }
}

function googleStopReason(value: unknown): CesiumStopReason | undefined {
  switch (value) {
    case undefined:
    case null:
    case "FINISH_REASON_UNSPECIFIED":
      return undefined;
    case "MAX_TOKENS":
      return "length";
    case "STOP":
      return "stop";
    default:
      return "other";
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
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

/**
 * OpenAI routes requests with the same key to the same prompt cache. Only the
 * first-party API gets it: strict OpenAI-compatible hosts reject unknown fields.
 */
function openAiPromptCacheKey(
  providerId: string,
  promptCacheKey: string | undefined
): Record<string, string> {
  return promptCacheKey && providerId === "openai" ? { prompt_cache_key: promptCacheKey } : {};
}

function openAiChatRequestBody(
  input: {
    model: string;
    providerId?: string;
    messages: CesiumHistoryMessage[];
    tools?: import("./cesium-tools.js").CesiumToolDefinition[];
    promptCacheKey?: string;
    maxOutputTokens?: number;
  },
  stream: boolean,
  streamUsage = false
): Record<string, unknown> {
  const tools =
    input.tools && input.tools.length === 0 ? undefined : openAiTools(input.tools);
  return {
    model: input.model,
    messages: openAiMessages(input.messages),
    ...(tools ? { tools, tool_choice: "auto" as const } : {}),
    max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...openAiPromptCacheKey(input.providerId ?? "", input.promptCacheKey),
    ...(stream ? { stream: true } : {}),
    ...(stream && streamUsage ? { stream_options: { include_usage: true } } : {}),
  };
}

/**
 * Streams only report usage when asked with `stream_options`. A host that
 * rejects the field is remembered and asked without it from then on.
 */
const hostsRejectingStreamUsage = new Set<string>(["mistral"]);

function rejectsStreamUsage(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /stream_options|include_usage/i.test(body);
}

function openAiChatResultFromPayload(payload: unknown): CesiumAdapterResult {
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    text: asString(message?.content) ?? "",
    reasoning: asString(message?.reasoning) ?? asString(message?.reasoning_content),
    toolRequests: toolCalls.flatMap((toolCall): CesiumToolRequest[] => {
      const record = asRecord(toolCall);
      const fn = asRecord(record?.function);
      const name = asString(fn?.name);
      if (!record || !name) {
        return [];
      }
      return [toolRequestFromArguments(asString(record.id) ?? randomUUID(), name, fn?.arguments)];
    }),
    usage: usageFromOpenAi(root?.usage),
    stopReason: chatStopReason(choice?.finish_reason),
    raw: payload,
  };
}

async function fetchOpenAiChat(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  oauth?: CesiumOAuthAdapterAuth;
  promptCacheKey?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  stream: boolean;
  streamUsage?: boolean;
}): Promise<Response> {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
  let headers = mergedHeaders(
    {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    input.oauth?.headers
  );
  if (input.oauth?.providerId === "github-copilot") {
    headers = mergedHeaders(headers, {
      "X-Initiator": copilotInitiator(input.messages),
      "Openai-Intent": "conversation-edits",
    });
  }
  return providerFetch(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(openAiChatRequestBody(input, input.stream, input.streamUsage)),
    },
    input.signal
  );
}

type ChatToolCallDelta = {
  id?: string;
  name?: string;
  arguments: string;
};

function appendOpenAiChatToolCallDeltas(
  value: unknown,
  pending: Map<number, ChatToolCallDelta>
): void {
  const toolCalls = Array.isArray(value) ? value : [];
  for (const rawToolCall of toolCalls) {
    const toolCall = asRecord(rawToolCall);
    if (!toolCall) {
      continue;
    }
    const rawIndex = toolCall.index;
    const index =
      typeof rawIndex === "number" && Number.isInteger(rawIndex)
        ? rawIndex
        : pending.size;
    const current = pending.get(index) ?? { arguments: "" };
    if (typeof toolCall.id === "string" && toolCall.id) {
      current.id = toolCall.id;
    }
    const fn = asRecord(toolCall.function);
    if (typeof fn?.name === "string" && fn.name) {
      current.name = current.name ?? fn.name;
    }
    if (typeof fn?.arguments === "string") {
      current.arguments += fn.arguments;
    }
    pending.set(index, current);
  }
}

function completeOpenAiChatToolCalls(
  pending: Map<number, ChatToolCallDelta>
): CesiumToolRequest[] {
  return [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]): CesiumToolRequest[] => {
      if (!call.name) {
        return [];
      }
      return [toolRequestFromArguments(call.id ?? randomUUID(), call.name, call.arguments)];
    });
}

function chatDeltaText(delta: Record<string, unknown>, key: string): string | undefined {
  const value = delta[key];
  return typeof value === "string" ? value : undefined;
}

function chatDeltaReasoning(delta: Record<string, unknown>): string | undefined {
  return (
    chatDeltaText(delta, "reasoning") ??
    chatDeltaText(delta, "reasoning_content") ??
    chatDeltaText(delta, "reasoning_text")
  );
}

function* parseSseFrame(frame: string): Generator<unknown | "[DONE]"> {
  const dataLines = frame
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  if (dataLines.length === 0) {
    return;
  }
  const data = dataLines.join("\n").trim();
  if (!data) {
    return;
  }
  if (data === "[DONE]") {
    yield "[DONE]";
    return;
  }
  yield parseJsonArgs(data);
}

async function* readSseJsonEvents(response: Response): AsyncGenerator<unknown | "[DONE]"> {
  if (!response.body) {
    return;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      yield* parseSseFrame(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* parseSseFrame(buffer);
  }
}

async function* streamOpenAiChat(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  oauth?: CesiumOAuthAdapterAuth;
  promptCacheKey?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<CesiumAdapterStreamEvent> {
  const host = `${input.providerId}|${input.baseUrl ?? ""}`;
  const askUsage = !hostsRejectingStreamUsage.has(input.providerId) && !hostsRejectingStreamUsage.has(host);
  let response = await fetchOpenAiChat({ ...input, stream: true, streamUsage: askUsage });
  if (!response.ok) {
    let text = await response.text();
    if (askUsage && rejectsStreamUsage(response.status, text)) {
      hostsRejectingStreamUsage.add(host);
      response = await fetchOpenAiChat({ ...input, stream: true });
      text = response.ok ? "" : await response.text();
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
    }
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !response.body ||
    contentType.includes("application/json") ||
    contentType.includes("text/json")
  ) {
    yield* streamStaticResult(openAiChatResultFromPayload(await readJsonResponse(response)));
    return;
  }

  const pendingToolCalls = new Map<number, ChatToolCallDelta>();
  let stopReason: CesiumStopReason | undefined;
  for await (const event of readSseJsonEvents(response)) {
    if (event === "[DONE]") {
      break;
    }
    yield { kind: "raw", raw: event };
    const root = asRecord(event);
    const usage = usageFromOpenAi(root?.usage);
    if (usage) {
      yield { kind: "usage", usage, raw: event };
    }
    const choices = Array.isArray(root?.choices) ? root.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      stopReason = chatStopReason(choice?.finish_reason) ?? stopReason;
      const delta = asRecord(choice?.delta);
      if (!delta) {
        continue;
      }
      const content = chatDeltaText(delta, "content");
      if (content !== undefined) {
        yield { kind: "text_delta", text: content, raw: event };
      }
      const reasoning = chatDeltaReasoning(delta);
      if (reasoning !== undefined) {
        yield { kind: "reasoning_delta", text: reasoning, raw: event };
      }
      appendOpenAiChatToolCallDeltas(delta.tool_calls, pendingToolCalls);
    }
  }

  for (const request of completeOpenAiChatToolCalls(pendingToolCalls)) {
    yield { kind: "tool_request", request };
  }
  yield { kind: "done", ...(stopReason ? { stopReason } : {}) };
}

/**
 * Responses API input items. Tool traffic maps onto native
 * `function_call` / `function_call_output` items (the Responses API has no
 * "tool" message role), which the ChatGPT Codex backend also requires.
 */
function openAiResponsesInput(
  messages: CesiumHistoryMessage[],
  options: { includeSystem: boolean }
): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (options.includeSystem) {
        items.push({ role: "developer", content: message.content });
      }
      continue;
    }
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? message.name ?? randomUUID(),
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content.trim()) {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    if (message.role === "user" && message.images?.length) {
      items.push({
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
      });
      continue;
    }
    items.push({ role: message.role, content: message.content });
  }
  return items;
}

async function* streamOpenAiResponses(input: {
  apiKey: string;
  baseUrl?: string;
  providerId: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  oauth?: CesiumOAuthAdapterAuth;
  promptCacheKey?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): AsyncGenerator<CesiumAdapterStreamEvent> {
  const isCodex = input.oauth?.providerId === "openai-codex";
  const tools = optionalProviderTools(input.tools, responseTools);
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  if (isCodex) {
    // ChatGPT subscription backend: system prompt travels in `instructions`,
    // storage must be disabled, and the account id header is mandatory.
    url = resolveCodexResponsesUrl(input.baseUrl);
    headers = mergedHeaders(
      {
        authorization: `Bearer ${input.apiKey}`,
        "chatgpt-account-id": extractChatGptAccountId(input.apiKey),
        originator: "pi",
        "openai-beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
        session_id: input.promptCacheKey ?? randomUUID(),
      },
      input.oauth?.headers
    );
    body = {
      model: input.model,
      instructions: systemPromptFromMessages(input.messages) || "You are a helpful assistant.",
      input: openAiResponsesInput(input.messages, { includeSystem: false }),
      ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      ...(input.promptCacheKey ? { prompt_cache_key: input.promptCacheKey } : {}),
    };
  } else {
    const baseUrl = resolveOpenAiCompatibleBaseUrl(input.baseUrl, input.providerId);
    url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    headers = mergedHeaders(
      {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      input.oauth?.headers
    );
    body = {
      model: input.model,
      input: openAiResponsesInput(input.messages, { includeSystem: true }),
      ...(tools ? { tools } : {}),
      max_output_tokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...openAiPromptCacheKey(input.providerId, input.promptCacheKey),
      stream: true,
    };
  }
  const response = await providerFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    input.signal
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
  }
  if (response.body) {
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let stopReason: CesiumStopReason | undefined;
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
          if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.done"
          ) {
            const usage = usageFromOpenAi(asRecord(event.response)?.usage);
            if (usage) {
              yield { kind: "usage", usage, raw: event };
            }
            stopReason = responsesStopReason(asRecord(event.response)) ?? stopReason;
          }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            yield { kind: "text_delta", text: event.delta, raw: event };
          }
          // `output_item.added` announces the call with empty arguments; only the
          // finished item carries them.
          const item = asRecord(event.item);
          if (event.type === "response.output_item.done" && item?.type === "function_call") {
            const name = asString(item.name);
            if (name) {
              yield {
                kind: "tool_request",
                request: toolRequestFromArguments(
                  asString(item.call_id) ?? asString(item.id) ?? randomUUID(),
                  name,
                  item.arguments
                ),
                raw: event,
              };
            }
          }
        }
      }
    }
    yield { kind: "done", ...(stopReason ? { stopReason } : {}) };
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
          toolRequestFromArguments(asString(out.call_id) ?? asString(out.id) ?? randomUUID(), name, out.arguments)
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
  const usage = usageFromOpenAi(record?.usage);
  if (usage) {
    yield { kind: "usage", usage, raw: payload };
  }
  const stopReason = responsesStopReason(record);
  yield { kind: "done", ...(stopReason ? { stopReason } : {}), raw: payload };
}

async function* streamOpenAiRealtime(input: {
  apiKey: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  signal?: AbortSignal;
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
  const watch = watchProviderRequest(input.signal);
  const onWatchAbort = () => {
    push({ kind: "error", error: watch.explain(new Error("Realtime request aborted.")) as Error });
    ws.terminate();
  };
  if (watch.signal.aborted) {
    onWatchAbort();
  } else {
    watch.signal.addEventListener("abort", onWatchAbort, { once: true });
  }
  ws.on("open", () => {
    watch.touch();
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
    watch.touch();
    const event = parseJsonArgs(data.toString());
    push({ kind: "event", event: { kind: "raw", raw: event } });
    if (event.type === "response.text.delta" && typeof event.delta === "string") {
      push({ kind: "event", event: { kind: "text_delta", text: event.delta, raw: event } });
    }
    if (event.type === "response.done") {
      const response = asRecord(event.response);
      const usage = usageFromOpenAi(response?.usage);
      if (usage) {
        push({ kind: "event", event: { kind: "usage", usage, raw: event } });
      }
      completed = true;
      const truncated =
        response?.status === "incomplete" &&
        asRecord(response.status_details)?.reason === "max_output_tokens";
      push({
        kind: "event",
        event: { kind: "done", ...(truncated ? { stopReason: "length" as const } : {}), raw: event },
      });
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
    watch.signal.removeEventListener("abort", onWatchAbort);
    watch.release();
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

function anthropicMessagesUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

/**
 * Anthropic caches only up to explicit breakpoints: mark the system prompt,
 * the last tool schema, and the newest message so each turn reuses the
 * previous turn's prefix instead of re-billing it in full.
 */
function withAnthropicCacheBreakpoints(body: {
  system: string | Array<Record<string, unknown>>;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<Record<string, unknown>>;
}): typeof body {
  const ephemeral = { type: "ephemeral" };
  const systemBlocks =
    typeof body.system === "string" ? [{ type: "text", text: body.system }] : [...body.system];
  const lastSystem = systemBlocks.length - 1;
  if (lastSystem >= 0) {
    systemBlocks[lastSystem] = { ...systemBlocks[lastSystem], cache_control: ephemeral };
  }
  const tools = body.tools?.map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: ephemeral } : tool
  );
  const messages = body.messages.map((message, index, all) => {
    if (index !== all.length - 1) {
      return message;
    }
    const blocks: Array<Record<string, unknown>> =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? [...(message.content as Array<Record<string, unknown>>)]
          : [];
    const lastBlock = blocks.length - 1;
    if (lastBlock < 0) {
      return message;
    }
    blocks[lastBlock] = { ...blocks[lastBlock], cache_control: ephemeral };
    return { ...message, content: blocks };
  });
  return { system: systemBlocks, messages, ...(tools ? { tools } : {}) };
}

async function runAnthropic(input: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  oauth?: CesiumOAuthAdapterAuth;
  promptCacheKey?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<CesiumAdapterResult> {
  const tools = optionalProviderTools(input.tools, anthropicTools);
  const isAnthropicOAuth = input.oauth?.providerId === "anthropic";
  const isCopilot = input.oauth?.providerId === "github-copilot";
  let headers: Record<string, string>;
  if (isAnthropicOAuth) {
    // Claude Pro/Max subscription tokens require Bearer auth, the OAuth beta
    // flags, and the Claude Code identity as the first system block.
    headers = mergedHeaders(
      {
        authorization: `Bearer ${input.apiKey}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_OAUTH_BETAS,
        "content-type": "application/json",
      },
      input.oauth?.headers
    );
  } else if (isCopilot) {
    headers = mergedHeaders(
      {
        authorization: `Bearer ${input.apiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "X-Initiator": copilotInitiator(input.messages),
      },
      input.oauth?.headers
    );
  } else {
    headers = mergedHeaders(
      {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      input.oauth?.headers
    );
  }
  const systemPrompt = systemPromptFromMessages(input.messages) || CESIUM_SYSTEM_PROMPT;
  const system = isAnthropicOAuth
    ? [
        { type: "text", text: ANTHROPIC_OAUTH_SPOOF },
        { type: "text", text: systemPrompt },
      ]
    : systemPrompt;
  const promptParts = {
    system,
    messages: anthropicMessages(input.messages),
    ...(tools ? { tools: tools as Array<Record<string, unknown>> } : {}),
  };
  const payload = await fetchJson(anthropicMessagesUrl(input.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(input.promptCacheKey && !isCopilot
        ? withAnthropicCacheBreakpoints(promptParts)
        : promptParts),
    }),
  }, input.signal);
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
  return {
    text: text.join(""),
    toolRequests,
    usage: usageFromAnthropic(root?.usage),
    stopReason: anthropicStopReason(root?.stop_reason),
    raw: payload,
  };
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
  baseUrl?: string;
  model: string;
  messages: CesiumHistoryMessage[];
  tools?: import("./cesium-tools.js").CesiumToolDefinition[];
  oauth?: CesiumOAuthAdapterAuth;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<CesiumAdapterResult> {
  const base = (input.baseUrl?.trim() || "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    ""
  );
  const apiRoot = /\/v\d+(beta)?$/i.test(base) ? base : `${base}/v1beta`;
  const endpoint = `${apiRoot}/models/${encodeURIComponent(input.model)}:generateContent`;
  // OAuth accounts (Pi Google provider packages) authenticate via Bearer;
  // plain API keys keep the ?key= query parameter.
  const url = input.oauth ? endpoint : `${endpoint}?key=${encodeURIComponent(input.apiKey)}`;
  const headers = mergedHeaders(
    {
      "content-type": "application/json",
      ...(input.oauth ? { authorization: `Bearer ${input.apiKey}` } : {}),
    },
    input.oauth?.headers
  );
  const tools = optionalProviderTools(input.tools, googleTools);
  const payload = await fetchJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: googleContents(input.messages),
      systemInstruction: {
        parts: [{ text: systemPromptFromMessages(input.messages) || CESIUM_SYSTEM_PROMPT }],
      },
      ...(tools ? { tools } : {}),
      generationConfig: {
        maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    }),
  }, input.signal);
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
  return {
    text: text.join(""),
    toolRequests,
    usage: usageFromGoogle(root?.usageMetadata),
    stopReason: googleStopReason(candidate?.finishReason),
    raw: payload,
  };
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
  /** Present when the request is backed by an OAuth subscription account. */
  oauth?: CesiumOAuthAdapterAuth;
  /** Stable per-conversation key so providers route every turn to the same prompt cache. */
  promptCacheKey?: string;
  /** Output-token cap for the reply; defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /** Aborts the in-flight provider request (turn cancel). */
  signal?: AbortSignal;
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
  if (result.usage) {
    yield { kind: "usage", usage: result.usage, raw: result.raw };
  }
  yield { kind: "done", ...(result.stopReason ? { stopReason: result.stopReason } : {}), raw: result.raw };
}

/** Whether the request honours `maxOutputTokens`; Realtime and the ChatGPT Codex backend have no such field. */
export function adapterHonorsMaxOutputTokens(input: Pick<RunAdapterInput, "apiKind" | "oauth">): boolean {
  switch (input.apiKind) {
    case "openai-realtime":
      return false;
    case "openai-chat-completions":
    case "openai-compatible":
    case "anthropic":
    case "google-genai":
      return true;
    default:
      return input.oauth?.providerId !== "openai-codex";
  }
}

export async function* streamAdapter(
  input: RunAdapterInput
): AsyncGenerator<CesiumAdapterStreamEvent> {
  const model = modelPart(input.modelId);
  const providerId = providerPart(input.modelId);
  switch (input.apiKind) {
    case "openai-chat-completions":
    case "openai-compatible":
      yield* streamOpenAiChat({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        providerId,
        model,
        messages: input.messages,
        tools: input.tools,
        oauth: input.oauth,
        promptCacheKey: input.promptCacheKey,
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
      });
      return;
    case "openai-realtime":
      yield* streamOpenAiRealtime({
        apiKey: input.apiKey,
        model,
        messages: input.messages,
        tools: input.tools,
        signal: input.signal,
      });
      return;
    case "anthropic":
      yield* streamStaticResult(
        await runAnthropic({
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          model,
          messages: input.messages,
          tools: input.tools,
          oauth: input.oauth,
          promptCacheKey: input.promptCacheKey,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
        })
      );
      return;
    case "google-genai":
      yield* streamStaticResult(
        await runGoogle({
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          model,
          messages: input.messages,
          tools: input.tools,
          oauth: input.oauth,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
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
        oauth: input.oauth,
        promptCacheKey: input.promptCacheKey,
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
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
  let usage: CesiumAdapterResult["usage"];
  let stopReason: CesiumStopReason | undefined;
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
      case "usage":
        usage = event.usage;
        break;
      case "done":
        stopReason = event.stopReason ?? stopReason;
        break;
      case "raw":
        break;
    }
  }
  return {
    text: textParts.join(""),
    reasoning: reasoningParts.join("") || undefined,
    toolRequests,
    ...(usage ? { usage } : {}),
    ...(stopReason ? { stopReason } : {}),
    raw: rawEvents.length > 1 ? rawEvents : finalRaw,
  };
}
