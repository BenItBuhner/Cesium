/**
 * Helpers for collapsing per-variant model ids (e.g. Cursor SDK
 * `model [reasoning=high]` entries) into a single display name. Shared by the
 * Models settings panel and the settings search index.
 */

const CURSOR_SDK_VARIANT_TOKENS = new Set([
  "auto",
  "default",
  "extra",
  "fast",
  "high",
  "large",
  "long",
  "low",
  "max",
  "medium",
  "normal",
  "short",
  "standard",
  "true",
  "false",
]);

export function stripCursorSdkModelParams(value: string): string {
  return value.replace(/\[[^\]]+\]$/g, "").trim();
}

function normalizeModelVariantToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function consumeSettingsModelVariantToken(words: string[]): boolean {
  const last = words.at(-1);
  if (!last) return false;
  const normalizedLast = normalizeModelVariantToken(last);
  if (normalizedLast === "true" || normalizedLast === "fast") {
    words.pop();
    return true;
  }
  if (normalizedLast === "false") {
    words.pop();
    if (normalizeModelVariantToken(words.at(-1) ?? "") === "fast") {
      words.pop();
    }
    return true;
  }
  if (/^\d+\s*[km]$/i.test(last)) {
    words.pop();
    return true;
  }
  const prev = normalizeModelVariantToken(words.at(-2) ?? "");
  if (prev === "extra" && normalizedLast === "high") {
    words.pop();
    words.pop();
    return true;
  }
  if (CURSOR_SDK_VARIANT_TOKENS.has(normalizedLast)) {
    words.pop();
    return true;
  }
  return false;
}

export function compactModelName(name: string, fallbackId: string): string {
  const base = (name.trim() || fallbackId.trim() || "Model")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim();
  const parts = base.split(/\s+/);
  while (parts.length > 1 && consumeSettingsModelVariantToken(parts)) {}
  return parts.join(" ") || base || fallbackId || "Model";
}
