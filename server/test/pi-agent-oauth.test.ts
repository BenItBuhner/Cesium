import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_AGENT_MINIMUM_PROVIDER_IDS,
  buildPiAgentOAuthCallbackUrl,
  getPiAgentSettingsResponse,
  piAgentOAuthSuccessHtml,
  providerLabelForId,
} from "../src/lib/pi-agent-oauth.js";

test("buildPiAgentOAuthCallbackUrl uses settings callback path", () => {
  const url = buildPiAgentOAuthCallbackUrl("https://app.example.com/");
  assert.equal(url, "https://app.example.com/api/settings/pi-agent/oauth/callback");
});

test("piAgentOAuthSuccessHtml posts message to opener", () => {
  const html = piAgentOAuthSuccessHtml("Anthropic");
  assert.match(html, /opencursor-pi-agent-oauth/);
  assert.match(html, /Anthropic/);
});

test("minimum Pi Agent provider ids include required OAuth providers", () => {
  for (const providerId of [
    "openai-codex",
    "anthropic",
    "github-copilot",
    "google-antigravity",
    "google-gemini-cli",
  ]) {
    assert.ok(
      PI_AGENT_MINIMUM_PROVIDER_IDS.includes(
        providerId as (typeof PI_AGENT_MINIMUM_PROVIDER_IDS)[number]
      ),
      `missing provider ${providerId}`
    );
  }
});

test("providerLabelForId returns friendly labels", () => {
  assert.equal(providerLabelForId("anthropic"), "Anthropic (Claude Pro/Max)");
  assert.equal(providerLabelForId("google-gemini-cli"), "Google Gemini CLI");
});

test("getPiAgentSettingsResponse lists minimum providers with oauth flags", async () => {
  const payload = await getPiAgentSettingsResponse();
  assert.ok(Array.isArray(payload.providers));
  assert.ok(payload.settings);
  assert.ok(payload.home);
  assert.ok(payload.home.agentDir);
  assert.ok(payload.home.nativeAgentDir);
  assert.ok(payload.home.isolatedAgentDir);
  assert.ok(payload.settings.agentHome === "native" || payload.settings.agentHome === "isolated");
  for (const providerId of PI_AGENT_MINIMUM_PROVIDER_IDS) {
    const provider = payload.providers.find((entry) => entry.id === providerId);
    assert.ok(provider, `expected provider entry for ${providerId}`);
    assert.equal(typeof provider.oauthSupported, "boolean");
    assert.equal(typeof provider.modelCount, "number");
  }
  const anthropic = payload.providers.find((entry) => entry.id === "anthropic");
  assert.equal(anthropic?.oauthSupported, true);
  const googleAntigravity = payload.providers.find((entry) => entry.id === "google-antigravity");
  assert.equal(googleAntigravity?.oauthSupported, false);
});
