import type { ModelInfo } from "@/lib/types";

export type ModelBrandTag =
  | "openai"
  | "anthropic"
  | "cursor"
  | "google"
  | "xai"
  | "deepseek"
  | "meta"
  | "qwen"
  | "mistral"
  | "glm"
  | "minimax"
  | "kimi"
  | "arcee"
  | "hunyuan"
  | "stepfun"
  | "primeIntellect"
  | "nvidia"
  | "liquid"
  | "hermes"
  | "xiaomi";

export type ModelBrandIconResult =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "brand"; brand: ModelBrandTag };

export const MODEL_BRAND_ICON_FILES: Record<
  ModelBrandTag,
  { light: string; dark: string }
> = {
  openai: { light: "ChatGPT-Light.svg", dark: "ChatGPT-Dark.svg" },
  anthropic: { light: "Claude-Light.svg", dark: "Claude-Dark.svg" },
  cursor: { light: "Composer-Light.svg", dark: "Composer-Dark.svg" },
  google: { light: "Gemini-Light.svg", dark: "Gemini-Dark.svg" },
  xai: { light: "Grok-Light.svg", dark: "Grok-Dark.svg" },
  deepseek: { light: "DeepSeek-Light.svg", dark: "DeepSeek-Dark.svg" },
  meta: { light: "Meta-Light.svg", dark: "Meta-Dark.svg" },
  qwen: { light: "Qwen-Light.svg", dark: "Qwen-Dark.svg" },
  mistral: { light: "Mistral-Light.svg", dark: "Mistral-Dark.svg" },
  glm: { light: "GLM-Light.svg", dark: "GLM-Dark.svg" },
  minimax: { light: "Minimax-Light.svg", dark: "Minimax-Dark.svg" },
  kimi: { light: "Kimi-Light.svg", dark: "Kimi-Dark.svg" },
  arcee: { light: "Arcee-Light.svg", dark: "Arcee-Dark.svg" },
  hunyuan: { light: "Hunyuan-Light.svg", dark: "Hunyuan-Dark.svg" },
  stepfun: { light: "Stepfun-Light.svg", dark: "Stepfun-Dark.svg" },
  primeIntellect: {
    light: "Prime-Intellect-Light.svg",
    dark: "Prime-Intellect-Dark.svg",
  },
  nvidia: { light: "Nvidia-Light.svg", dark: "Nvidia-Dark.svg" },
  liquid: { light: "Liquid-Light.svg", dark: "Liquid-Dark.svg" },
  hermes: { light: "Hermes-Light.svg", dark: "Hermes-Dark.svg" },
  xiaomi: { light: "Xiaomi-Light.svg", dark: "Xiaomi-Dark.svg" },
};

export function isAutoModel(model: ModelInfo): boolean {
  return (
    (model.modelValue ?? model.id).toLowerCase() === "auto" ||
    model.name.toLowerCase() === "auto"
  );
}

export function modelIconHaystack(model: ModelInfo): string {
  const parts = [model.name, model.id, model.modelValue ?? ""].filter(Boolean);
  return parts.join("\n").toLowerCase();
}

type Needle =
  | { text: string; word?: boolean }
  /**
   * Hunyuan ships names like `Hy3`; `\bhy\b` misses those because digits are
   * word chars. Match `hy` only when followed by a digit (excludes `hybrid`).
   */
  | { hySeriesPrefix: true };

function escapeNeedleForWordBoundary(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Index of first match; `word: true` uses \\b boundaries (after case-folding). */
function needleMinIndex(haystack: string, needle: Needle): number {
  if ("hySeriesPrefix" in needle && needle.hySeriesPrefix) {
    const m = /\bhy(?=\d)/.exec(haystack);
    return m?.index ?? -1;
  }
  const { text, word } = needle as Extract<Needle, { text: string }>;
  if (!word) {
    const i = haystack.indexOf(text);
    return i;
  }
  const re = new RegExp(`\\b${escapeNeedleForWordBoundary(text)}\\b`);
  const m = re.exec(haystack);
  return m?.index ?? -1;
}

function ruleMinIndex(haystack: string, needles: readonly Needle[]): number {
  let min = Infinity;
  for (const n of needles) {
    const i = needleMinIndex(haystack, n);
    if (i !== -1 && i < min) {
      min = i;
    }
  }
  return min === Infinity ? -1 : min;
}

/**
 * Rules apply in **outer** order only for tie-breaks (same earliest index).
 * Winner is the brand whose *earliest* needle match appears first in the haystack.
 */
const BRAND_RULES: ReadonlyArray<{ tag: ModelBrandTag; needles: readonly Needle[] }> = [
  { tag: "openai", needles: [{ text: "gpt" }] },
  {
    tag: "anthropic",
    needles: [
      { text: "claude" },
      { text: "haiku" },
      { text: "sonnet" },
      { text: "opus" },
      { text: "mythos" },
    ],
  },
  { tag: "cursor", needles: [{ text: "composer" }] },
  { tag: "google", needles: [{ text: "gemini" }, { text: "gemma" }] },
  { tag: "xai", needles: [{ text: "grok" }] },
  { tag: "deepseek", needles: [{ text: "deepseek" }] },
  {
    tag: "meta",
    needles: [{ text: "muse spark" }, { text: "llama" }, { text: "muse" }],
  },
  {
    tag: "qwen",
    needles: [{ text: "qwen" }, { text: "qvq" }, { text: "qwq" }],
  },
  {
    tag: "mistral",
    needles: [
      { text: "mistral" },
      { text: "codestral" },
      { text: "devstral" },
      { text: "pixtral" },
      { text: "voxtrel" },
      { text: "ministral" },
      { text: "mixtral" },
      { text: "leanstral" },
      { text: "magistral" },
    ],
  },
  { tag: "glm", needles: [{ text: "glm" }, { text: "zai" }] },
  { tag: "minimax", needles: [{ text: "minimax" }] },
  { tag: "kimi", needles: [{ text: "kimi" }] },
  { tag: "arcee", needles: [{ text: "arcee" }, { text: "trinity" }] },
  {
    tag: "hunyuan",
    needles: [{ text: "hunyuan" }, { hySeriesPrefix: true }],
  },
  { tag: "stepfun", needles: [{ text: "stepfun" }, { text: "step" }] },
  { tag: "primeIntellect", needles: [{ text: "intellect" }] },
  { tag: "nvidia", needles: [{ text: "nvidia" }, { text: "nemotron" }] },
  { tag: "liquid", needles: [{ text: "lfm" }, { text: "liquid" }] },
  { tag: "hermes", needles: [{ text: "hermes" }] },
  { tag: "xiaomi", needles: [{ text: "xiaomi" }, { text: "mimo" }] },
];

function firstBrandInHaystack(haystack: string): ModelBrandTag | null {
  let bestIdx = Infinity;
  let bestTag: ModelBrandTag | null = null;
  let bestRuleOrder = Infinity;

  for (let ord = 0; ord < BRAND_RULES.length; ord++) {
    const { tag, needles } = BRAND_RULES[ord]!;
    const idx = ruleMinIndex(haystack, needles);
    if (idx === -1) {
      continue;
    }
    if (idx < bestIdx || (idx === bestIdx && ord < bestRuleOrder)) {
      bestIdx = idx;
      bestTag = tag;
      bestRuleOrder = ord;
    }
  }

  return bestTag;
}

export function resolveModelBrandIcon(model: ModelInfo): ModelBrandIconResult {
  if (isAutoModel(model)) {
    return { kind: "none" };
  }

  const haystack = modelIconHaystack(model);

  if (haystack.includes("efficiency") || haystack.includes("performance")) {
    return { kind: "none" };
  }

  const brand = firstBrandInHaystack(haystack);
  if (brand) {
    return { kind: "brand", brand };
  }

  return { kind: "default" };
}
