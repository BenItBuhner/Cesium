import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_AGENT_MINIMUM_PROVIDER_IDS,
  buildPiAgentOAuthCallbackUrl,
  getPiAgentSettingsResponse,
  piAgentOAuthSuccessHtml,
  providerLabelForId,
  startPiAgentOAuth,
} from "../src/lib/pi-agent-oauth.js";
import { SUBSCRIPTION_OAUTH_PROVIDER_IDS } from "../src/lib/subscription-oauth.js";

test("buildPiAgentOAuthCallbackUrl uses settings callback path", () => {
  const url = buildPiAgentOAuthCallbackUrl("https://app.example.com/");
  assert.equal(url, "https://app.example.com/api/settings/pi-agent/oauth/callback");
});

test("piAgentOAuthSuccessHtml posts message to opener", () => {
  const html = piAgentOAuthSuccessHtml("ChatGPT");
  assert.match(html, /opencursor-pi-agent-oauth/);
  assert.match(html, /ChatGPT/);
});

test("minimum Pi Agent provider ids are official subscription logins only", () => {
  assert.deepEqual([...PI_AGENT_MINIMUM_PROVIDER_IDS], [...SUBSCRIPTION_OAUTH_PROVIDER_IDS]);
  for (const providerId of ["openai-codex", "xai"]) {
    assert.ok(
      PI_AGENT_MINIMUM_PROVIDER_IDS.includes(
        providerId as (typeof PI_AGENT_MINIMUM_PROVIDER_IDS)[number]
      ),
      `missing provider ${providerId}`
    );
  }
  for (const blocked of ["anthropic", "github-copilot", "google-antigravity", "google-gemini-cli"]) {
    assert.equal(
      PI_AGENT_MINIMUM_PROVIDER_IDS.includes(
        blocked as (typeof PI_AGENT_MINIMUM_PROVIDER_IDS)[number]
      ),
      false,
      `blocked provider ${blocked} must not be offered`
    );
  }
});

test("providerLabelForId returns friendly labels", () => {
  assert.equal(providerLabelForId("openai-codex"), "ChatGPT (Codex subscription)");
  assert.equal(providerLabelForId("xai"), "SpaceXAI SuperGrok");
});

test("getPiAgentSettingsResponse lists official OAuth and hides unofficial Connect", async () => {
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
    assert.equal(provider.oauthSupported, true);
    assert.equal(typeof provider.modelCount, "number");
  }
  const openai = payload.providers.find((entry) => entry.id === "openai-codex");
  assert.equal(openai?.oauthSupported, true);
  const xai = payload.providers.find((entry) => entry.id === "xai");
  assert.equal(xai?.oauthSupported, true);
  const anthropic = payload.providers.find((entry) => entry.id === "anthropic");
  if (anthropic) {
    assert.equal(anthropic.oauthSupported, false);
  }
  const googleAntigravity = payload.providers.find((entry) => entry.id === "google-antigravity");
  if (googleAntigravity) {
    assert.equal(googleAntigravity.oauthSupported, false);
  }
});

test("startPiAgentOAuth rejects unofficial subscription providers", async () => {
  await assert.rejects(
    () => startPiAgentOAuth({ providerId: "anthropic", publicOrigin: "https://app.example.com" }),
    /Unsupported subscription OAuth provider/
  );
  await assert.rejects(
    () =>
      startPiAgentOAuth({
        providerId: "google-gemini-cli",
        publicOrigin: "https://app.example.com",
      }),
    /Unsupported subscription OAuth provider/
  );
});
