/**
 * Normalize API-style model ids and slug-like names into clean display labels.
 *
 * Examples:
 * - "opus-5" → "Opus 5"
 * - "claude-sonnet-4-5-20250929" → "Claude Sonnet 4.5"
 * - "gpt-4o" → "GPT 4o"
 * - "kimi-k2.7-code" → "Kimi K2.7 Code"
 * - "Anthropic/claude-opus-4-5" → "Anthropic/Claude Opus 4.5"
 */

const MODEL_DISPLAY_ACRONYMS = new Set([
  "ai",
  "api",
  "asr",
  "awq",
  "bf16",
  "cli",
  "cpu",
  "cuda",
  "dpo",
  "fp8",
  "fp16",
  "gguf",
  "glm",
  "gpt",
  "gpu",
  "http",
  "https",
  "json",
  "llm",
  "lora",
  "mlx",
  "moe",
  "nli",
  "npu",
  "ocr",
  "oss",
  "pdf",
  "peft",
  "qa",
  "rag",
  "rl",
  "rlhf",
  "sdk",
  "sft",
  "sql",
  "stt",
  "tpu",
  "tts",
  "ui",
  "vl",
  "vlm",
  "xml",
  "yaml",
]);

/** Well-known provider id → display label overrides. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  togetherai: "Together AI",
  "fireworks-ai": "Fireworks AI",
  fireworks: "Fireworks",
  anthropic: "Anthropic",
  google: "Google",
  gemini: "Google",
  xai: "xAI",
  "x-ai": "xAI",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  moonshot: "Moonshot AI",
  zai: "Z.AI",
  "z-ai": "Z.AI",
  zhipuai: "Zhipu AI",
  crofai: "CrofAI",
  techlit: "Techlit",
  nvidia: "Nvidia",
  cerebras: "Cerebras",
  cohere: "Cohere",
  perplexity: "Perplexity",
  huggingface: "Hugging Face",
  "hf-inference": "Hugging Face",
};

const SLUG_LIKE = /^[a-z0-9]+(?:[._:-][a-z0-9]+)+$/i;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Strip trailing date / snapshot stamps common in provider API ids.
 * Anthropic: -20250929 · Cohere: -08-2024 · ISO: -2025-11-01 · short: -latest
 */
function stripModelIdDateSuffixes(value: string): string {
  let current = value.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = current;
    current = current
      .replace(/-latest$/i, "")
      .replace(/-\d{8}$/u, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/u, "")
      .replace(/-\d{2}-\d{4}$/u, "")
      .replace(/-\d{4}-\d{2}$/u, "");
    if (current === before) {
      break;
    }
  }
  return current;
}

function splitProviderModel(value: string): { provider: string | null; model: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { provider: null, model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

/**
 * Join Anthropic-style major-minor pairs embedded in slugs: sonnet-4-5 → sonnet-4.5
 */
function joinVersionPairs(raw: string): string {
  return raw.replace(/(\d{1,2})[-_](\d{1,2})(?=$|[-_.])/g, "$1.$2");
}

function titleCaseToken(token: string): string {
  if (!token) {
    return token;
  }
  const lower = token.toLowerCase();
  if (lower === "deepseek") {
    return "DeepSeek";
  }
  if (lower === "openai") {
    return "OpenAI";
  }
  if (lower === "openrouter") {
    return "OpenRouter";
  }
  if (MODEL_DISPLAY_ACRONYMS.has(lower)) {
    return lower.toUpperCase();
  }
  // Size / quant tokens: 70b, 8x7b, a12b, 120b
  if (/^\d+[bm]$/i.test(token) || /^\d+x\d+[bm]$/i.test(token) || /^a\d+[bm]$/i.test(token)) {
    return token.toUpperCase();
  }
  // Leading "o" reasoning models: o3, o4mini
  if (/^o\d+[a-z0-9]*$/i.test(token)) {
    return `o${token.slice(1)}`;
  }
  if (/^v\d/i.test(token)) {
    return `V${token.slice(1)}`;
  }
  if (/^k\d/i.test(token)) {
    return `K${token.slice(1)}`;
  }
  // Keep dotted / alphanumeric versions like 4.5, 4o, 2.5
  if (/^\d/.test(token)) {
    return token;
  }
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function modelLeafId(model: string): string {
  let leaf = model.includes(":") ? model.slice(model.lastIndexOf(":") + 1) : model;
  // Deep provider paths: accounts/fireworks/routers/glm-5p2-fast
  if (leaf.includes("/")) {
    leaf = leaf.slice(leaf.lastIndexOf("/") + 1);
  }
  return leaf;
}

function tokenizeModelSlug(slug: string): string[] {
  const prepared = joinVersionPairs(
    stripModelIdDateSuffixes(slug.trim())
      // Fireworks-style 5p2 → 5.2
      .replace(/(\d)p(\d)/gi, "$1.$2")
  );
  // Split on separators but keep dotted version tokens intact (4.5, 2.5, k2.7).
  return prepared
    .split(/[\s/_:-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function looksLikeModelSlug(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    return false;
  }
  if (trimmed.includes("/")) {
    const { provider, model } = splitProviderModel(trimmed);
    return Boolean(provider && looksLikeModelSlug(modelLeafId(model)));
  }
  return SLUG_LIKE.test(trimmed) || /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(trimmed);
}

/**
 * Light polish for names that are already mostly human-readable.
 * Converts "GLM-5.2" → "GLM 5.2" while preserving phrases like "Claude Sonnet 4.5 (latest)".
 */
export function polishModelDisplayName(name: string): string {
  let value = collapseWhitespace(name);
  if (!value) {
    return value;
  }
  value = value.replace(
    /\b([A-Za-z]{2,})-(\d+[A-Za-z0-9.]*)\b/g,
    (_, brand: string, version: string) => `${titleCaseToken(brand)} ${version}`
  );
  return collapseWhitespace(value);
}

function formatProviderDisplayName(provider: string): string {
  const trimmed = provider.trim();
  if (!trimmed) {
    return "Provider";
  }
  const known = PROVIDER_DISPLAY_NAMES[trimmed.toLowerCase()];
  if (known) {
    return known;
  }
  if (!looksLikeModelSlug(trimmed) && /\s|[A-Z]/.test(trimmed)) {
    return polishModelDisplayName(trimmed);
  }
  return tokenizeModelSlug(trimmed).map(titleCaseToken).join(" ");
}

/** Public alias for provider id → display label. */
export function formatProviderDisplayLabel(providerId: string): string {
  return formatProviderDisplayName(providerId);
}

/** Format a single model id or slug into a spaced display label. */
export function formatModelDisplayName(raw: string): string {
  const trimmed = collapseWhitespace(raw);
  if (!trimmed) {
    return "Model";
  }

  const { provider, model } = splitProviderModel(trimmed);
  const leaf = modelLeafId(model);
  const formattedModel = tokenizeModelSlug(leaf).map(titleCaseToken).join(" ");

  if (!provider) {
    return polishModelDisplayName(formattedModel || leaf);
  }

  return `${formatProviderDisplayName(provider)}/${polishModelDisplayName(formattedModel || leaf)}`;
}

export type ResolveModelDisplayNameOptions = {
  /**
   * When true, keep an explicit name even if it looks slug-like
   * (user typed it manually for a custom provider model).
   */
  preferExplicitName?: boolean;
};

/**
 * Memoized: this normalizer is regex-heavy and gets called for every catalog
 * model whenever composer state derives (which under many concurrent agents
 * is several times per second), always with the same handful of
 * (name, modelId) inputs. Bounded; resets on overflow.
 */
// Sized to hold a full provider catalog (incl. variant expansions); an
// undersized cache clears mid-pass and thrashes.
const displayNameCache = new Map<string, string>();
const MAX_DISPLAY_NAME_CACHE = 32_768;

/**
 * Prefer a human display name when present; otherwise normalize from the API id.
 * If `name` equals the id / leaf id and looks like a slug, normalize it.
 */
export function resolveModelDisplayName(
  name: string | null | undefined,
  modelId: string,
  options?: ResolveModelDisplayNameOptions
): string {
  const cacheKey = `${name ?? ""}\u0000${modelId}\u0000${options?.preferExplicitName ? 1 : 0}`;
  const cached = displayNameCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const result = resolveModelDisplayNameUncached(name, modelId, options);
  if (displayNameCache.size >= MAX_DISPLAY_NAME_CACHE) {
    displayNameCache.clear();
  }
  displayNameCache.set(cacheKey, result);
  return result;
}

function resolveModelDisplayNameUncached(
  name: string | null | undefined,
  modelId: string,
  options?: ResolveModelDisplayNameOptions
): string {
  const id = collapseWhitespace(modelId);
  const leaf = modelLeafId(splitProviderModel(id).model);
  const trimmedName = collapseWhitespace(name ?? "");

  if (!trimmedName) {
    return formatModelDisplayName(id || leaf || "Model");
  }

  const sameAsId =
    trimmedName.toLowerCase() === id.toLowerCase() ||
    trimmedName.toLowerCase() === leaf.toLowerCase();

  if (options?.preferExplicitName && !sameAsId) {
    return polishModelDisplayName(trimmedName);
  }

  if (!sameAsId && !looksLikeModelSlug(trimmedName)) {
    return polishModelDisplayName(trimmedName);
  }

  // Catalog labels often arrive as Provider/raw-or-human — normalize each side.
  if (trimmedName.includes("/")) {
    const { provider, model } = splitProviderModel(trimmedName);
    const providerLabel = formatProviderDisplayName(provider ?? "");
    const modelLabel =
      !looksLikeModelSlug(model) && model.toLowerCase() !== leaf.toLowerCase()
        ? polishModelDisplayName(model)
        : formatModelDisplayName(leaf || model);
    return `${providerLabel}/${modelLabel}`;
  }

  return formatModelDisplayName(sameAsId ? id || trimmedName : trimmedName);
}

/** Build `Provider/Model` catalog labels with normalized model segments. */
export function formatCatalogModelLabel(
  providerName: string,
  modelName: string | null | undefined,
  modelId: string
): string {
  const provider = polishModelDisplayName(providerName.trim() || "Provider");
  const leafId = modelLeafId(splitProviderModel(modelId).model) || modelId;
  const model = resolveModelDisplayName(modelName, leafId);
  if (model.includes("/")) {
    const split = splitProviderModel(model);
    return `${provider}/${split.model}`;
  }
  return `${provider}/${model}`;
}
