/**
 * Minimal OpenAI-compatible chat client for compaction benchmarks.
 *
 * Talks directly to the Model-Proxy (default https://infer.techlitnow.com/v1).
 * Credentials come from env: BENCH_API_KEY, CESIUM_API_KEY, or OPENAI_API_KEY.
 */

export type BenchChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type BenchCaller = (input: {
  system: string;
  user: string;
}) => Promise<string>;

const DEFAULT_BASE_URL = "https://infer.techlitnow.com/v1";

export function benchBaseUrl(): string {
  return (
    process.env.BENCH_BASE_URL?.trim() ||
    process.env.CESIUM_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

export function benchApiKey(): string {
  const key =
    process.env.BENCH_API_KEY?.trim() ||
    process.env.CESIUM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "No API key for the bench Model-Proxy. Set BENCH_API_KEY, CESIUM_API_KEY, or OPENAI_API_KEY."
    );
  }
  return key;
}

let requestCount = 0;
let totalPromptChars = 0;
let totalCompletionChars = 0;

export function benchModelUsage(): {
  requests: number;
  promptChars: number;
  completionChars: number;
} {
  return {
    requests: requestCount,
    promptChars: totalPromptChars,
    completionChars: totalCompletionChars,
  };
}

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000];

export async function benchChat(input: {
  model: string;
  messages: BenchChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const url = `${benchBaseUrl()}/chat/completions`;
  // Reasoning models (e.g. turbo, kimi-k3) burn output budget on hidden
  // reasoning before emitting content — keep generous headroom, and escalate
  // when a response is cut off (finish_reason=length with empty content).
  let maxTokens = input.maxTokens ?? 16_384;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const body = JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: maxTokens,
      temperature: input.temperature ?? 0,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 240_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${benchApiKey()}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const retriable = response.status === 429 || response.status >= 500;
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
        if (!retriable) {
          throw error;
        }
        lastError = error;
      } else {
        const payload = (await response.json()) as {
          choices?: Array<{
            finish_reason?: string;
            message?: { content?: string | null };
          }>;
        };
        const choice = payload.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content === "string" && content.trim().length > 0) {
          requestCount += 1;
          totalPromptChars += body.length;
          totalCompletionChars += content.length;
          return content;
        }
        if (choice?.finish_reason === "length" && maxTokens < 65_536) {
          // The model spent the whole budget on hidden reasoning; escalate.
          maxTokens = Math.min(65_536, maxTokens * 2);
          lastError = new Error("Completion cut off by max_tokens (reasoning overflow)");
        } else {
          throw new Error(
            `Malformed completion payload: ${JSON.stringify(payload).slice(0, 400)}`
          );
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error("Request timed out");
      } else if (
        error instanceof Error &&
        (error.message.startsWith("HTTP 4") || error.message.startsWith("Malformed"))
      ) {
        throw error;
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new Error(
    `benchChat failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export function makeBenchCaller(model: string): BenchCaller {
  return async ({ system, user }) =>
    benchChat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
}
