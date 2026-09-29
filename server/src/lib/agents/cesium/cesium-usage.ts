import type { AgentTokenUsage } from "../types.js";
import { asRecord } from "./cesium-coerce.js";

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function withOptional(usage: AgentTokenUsage, extra: Partial<AgentTokenUsage>): AgentTokenUsage {
  const out: AgentTokenUsage = { ...usage };
  for (const key of ["cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    const value = extra[key];
    if (value !== undefined && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * OpenAI-shaped usage: Chat Completions (`prompt_tokens`/`completion_tokens`)
 * and Responses / Realtime (`input_tokens`/`output_tokens`), including the
 * cached-token spellings compatible hosts use.
 */
export function usageFromOpenAi(value: unknown): AgentTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const input = count(usage.prompt_tokens) ?? count(usage.input_tokens);
  const output = count(usage.completion_tokens) ?? count(usage.output_tokens);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const inputDetails =
    asRecord(usage.prompt_tokens_details) ??
    asRecord(usage.input_tokens_details) ??
    asRecord(usage.input_token_details);
  const outputDetails =
    asRecord(usage.completion_tokens_details) ??
    asRecord(usage.output_tokens_details) ??
    asRecord(usage.output_token_details);
  return withOptional(
    { inputTokens: input, outputTokens: output },
    {
      cachedInputTokens:
        count(inputDetails?.cached_tokens) ??
        count(usage.prompt_cache_hit_tokens) ??
        count(usage.cached_tokens),
      reasoningTokens: count(outputDetails?.reasoning_tokens),
    }
  );
}

/** Anthropic reports uncached, cache-read and cache-write input separately. */
export function usageFromAnthropic(value: unknown): AgentTokenUsage | undefined {
  const usage = asRecord(value);
  const uncached = count(usage?.input_tokens);
  const output = count(usage?.output_tokens);
  if (!usage || uncached === undefined || output === undefined) {
    return undefined;
  }
  const cacheRead = count(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = count(usage.cache_creation_input_tokens) ?? 0;
  return withOptional(
    { inputTokens: uncached + cacheRead + cacheWrite, outputTokens: output },
    { cachedInputTokens: cacheRead, cacheWriteTokens: cacheWrite }
  );
}

/** Gemini `usageMetadata`; thinking tokens are billed as output. */
export function usageFromGoogle(value: unknown): AgentTokenUsage | undefined {
  const usage = asRecord(value);
  const input = count(usage?.promptTokenCount);
  if (!usage || input === undefined) {
    return undefined;
  }
  const thoughts = count(usage.thoughtsTokenCount) ?? 0;
  return withOptional(
    { inputTokens: input, outputTokens: (count(usage.candidatesTokenCount) ?? 0) + thoughts },
    { cachedInputTokens: count(usage.cachedContentTokenCount), reasoningTokens: thoughts }
  );
}

/** Tokens the next request starts from: this prompt plus the reply it carries forward. */
export function contextTokensAfterResponse(usage: AgentTokenUsage): number {
  return usage.inputTokens + Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0));
}

export function addTokenUsage(total: AgentTokenUsage | undefined, next: AgentTokenUsage): AgentTokenUsage {
  if (!total) {
    return { ...next };
  }
  return withOptional(
    {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
    },
    {
      cachedInputTokens: (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
      cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
      reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    }
  );
}
