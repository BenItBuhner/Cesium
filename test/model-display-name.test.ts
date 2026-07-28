import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCatalogModelLabel,
  formatModelDisplayName,
  looksLikeModelSlug,
  polishModelDisplayName,
  resolveModelDisplayName,
} from "@cesium/core";

test("formatModelDisplayName normalizes common API slugs", () => {
  assert.equal(formatModelDisplayName("opus-5"), "Opus 5");
  assert.equal(formatModelDisplayName("claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5");
  assert.equal(formatModelDisplayName("claude-opus-4-5-20251101"), "Claude Opus 4.5");
  assert.equal(formatModelDisplayName("gpt-4o"), "GPT 4o");
  assert.equal(formatModelDisplayName("gpt-5.2-pro"), "GPT 5.2 Pro");
  assert.equal(formatModelDisplayName("gemini-2.5-pro"), "Gemini 2.5 Pro");
  assert.equal(formatModelDisplayName("kimi-k2.7-code"), "Kimi K2.7 Code");
  assert.equal(formatModelDisplayName("glm-5.2"), "GLM 5.2");
  assert.equal(formatModelDisplayName("llama-3.3-70b-versatile"), "Llama 3.3 70B Versatile");
  assert.equal(
    formatModelDisplayName("anthropic/claude-opus-4-5"),
    "Anthropic/Claude Opus 4.5"
  );
});

test("looksLikeModelSlug detects dashed lowercase ids", () => {
  assert.equal(looksLikeModelSlug("claude-opus-4-5"), true);
  assert.equal(looksLikeModelSlug("Claude Opus 4.5"), false);
  assert.equal(looksLikeModelSlug("GPT-4o"), true);
  assert.equal(looksLikeModelSlug("My Custom Model"), false);
});

test("resolveModelDisplayName prefers explicit human names", () => {
  assert.equal(
    resolveModelDisplayName("My Cool Model", "cool-model-1", { preferExplicitName: true }),
    "My Cool Model"
  );
  assert.equal(resolveModelDisplayName("claude-opus-4-5", "claude-opus-4-5"), "Claude Opus 4.5");
  assert.equal(
    resolveModelDisplayName("Anthropic/Claude Sonnet 4.5", "anthropic/claude-sonnet-4-5-20250929"),
    "Anthropic/Claude Sonnet 4.5"
  );
  assert.equal(
    resolveModelDisplayName(undefined, "openai/gpt-4o"),
    "OpenAI/GPT 4o"
  );
});

test("formatCatalogModelLabel builds Provider/Model labels", () => {
  assert.equal(
    formatCatalogModelLabel("Anthropic", "claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5-20250929"),
    "Anthropic/Claude Sonnet 4.5"
  );
  assert.equal(
    formatCatalogModelLabel("OpenAI", "GPT-4o", "openai/gpt-4o"),
    "OpenAI/GPT 4o"
  );
  assert.equal(
    polishModelDisplayName("GLM-5.2"),
    "GLM 5.2"
  );
});
