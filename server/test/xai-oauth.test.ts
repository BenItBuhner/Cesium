import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessTokenIsExpiring,
  credentialsFromTokenResponse,
  credentialsNeedRefresh,
  pollXaiDeviceCodeToken,
  refreshXaiAccessToken,
  requestXaiDeviceCode,
  type XaiDeviceCodeResponse,
  type XaiOAuthHttp,
} from "../src/lib/xai-oauth.js";
import {
  isBlockedSubscriptionOAuthProviderId,
  isSubscriptionOAuthProviderId,
  SUBSCRIPTION_OAUTH_PROVIDER_IDS,
} from "../src/lib/subscription-oauth.js";
import { startCesiumOAuth, resolveCesiumOAuthRequestAuth } from "../src/lib/cesium-oauth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("subscription allowlist is OpenAI Codex and SpaceXAI only", () => {
  assert.deepEqual([...SUBSCRIPTION_OAUTH_PROVIDER_IDS], ["openai-codex", "xai"]);
  assert.equal(isSubscriptionOAuthProviderId("openai-codex"), true);
  assert.equal(isSubscriptionOAuthProviderId("xai"), true);
  assert.equal(isSubscriptionOAuthProviderId("anthropic"), false);
  assert.equal(isBlockedSubscriptionOAuthProviderId("anthropic"), true);
  assert.equal(isBlockedSubscriptionOAuthProviderId("github-copilot"), true);
  assert.equal(isBlockedSubscriptionOAuthProviderId("google-antigravity"), true);
  assert.equal(isBlockedSubscriptionOAuthProviderId("google-gemini-cli"), true);
  assert.equal(isBlockedSubscriptionOAuthProviderId("xai"), false);
});

test("requestXaiDeviceCode posts the public Grok-CLI client and cesium referrer", async () => {
  const seen: Array<{ url: string; body: string }> = [];
  const http: XaiOAuthHttp = {
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        body: String(init?.body ?? ""),
      });
      return jsonResponse({
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/device",
        verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
        expires_in: 300,
        interval: 5,
      });
    },
  };
  const device = await requestXaiDeviceCode(http);
  assert.equal(device.user_code, "ABCD-EFGH");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://auth.x.ai/oauth2/device/code");
  assert.match(seen[0]?.body ?? "", /client_id=b1a00492-073a-47ea-816f-4c329264a828/);
  assert.match(seen[0]?.body ?? "", /referrer=cesium/);
  assert.match(seen[0]?.body ?? "", /grok-cli%3Aaccess/);
});

test("pollXaiDeviceCodeToken waits through authorization_pending then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const http: XaiOAuthHttp = {
    now: (() => {
      let t = 0;
      return () => t;
    })(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: "authorization_pending" }, 400);
      }
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
      });
    },
  };
  const device: XaiDeviceCodeResponse = {
    device_code: "dev-1",
    user_code: "CODE",
    verification_uri: "https://accounts.x.ai/device",
    interval: 2,
    expires_in: 60,
  };
  const tokens = await pollXaiDeviceCodeToken(device, http);
  assert.equal(tokens.access_token, "access-1");
  assert.equal(calls, 2);
  assert.ok(sleeps.length >= 1);
});

test("refreshXaiAccessToken posts refresh_token grant", async () => {
  let body = "";
  const http: XaiOAuthHttp = {
    fetch: async (_input, init) => {
      body = String(init?.body ?? "");
      return jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 1800,
      });
    },
  };
  const tokens = await refreshXaiAccessToken("refresh-1", http);
  assert.equal(tokens.access_token, "access-2");
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=refresh-1/);
});

test("credentialsFromTokenResponse keeps previous refresh when rotated token omitted", () => {
  const creds = credentialsFromTokenResponse(
    { access_token: "a", expires_in: 10 },
    "old-refresh",
    1_000
  );
  assert.equal(creds.access, "a");
  assert.equal(creds.refresh, "old-refresh");
  assert.equal(creds.expires, 11_000);
});

test("accessTokenIsExpiring reads JWT exp without verifying the signature", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  assert.equal(accessTokenIsExpiring(token, 0, 1_700_000_000_000), true);
  assert.equal(accessTokenIsExpiring(token, 0, 1_600_000_000_000), false);
  assert.equal(accessTokenIsExpiring("opaque-token"), false);
});

test("credentialsNeedRefresh uses stored expiry skew", () => {
  assert.equal(
    credentialsNeedRefresh(
      {
        schemaVersion: 1,
        access: "opaque",
        refresh: "r",
        expires: 1_000,
        updatedAt: 0,
      },
      900
    ),
    true
  );
  assert.equal(
    credentialsNeedRefresh(
      {
        schemaVersion: 1,
        access: "opaque",
        refresh: "r",
        expires: 1_000_000,
        updatedAt: 0,
      },
      1_000
    ),
    false
  );
});

test("startCesiumOAuth rejects unofficial providers", async () => {
  await assert.rejects(
    () => startCesiumOAuth({ providerId: "anthropic", publicOrigin: "https://app.example.com" }),
    /Unsupported subscription OAuth provider/
  );
});

test("resolveCesiumOAuthRequestAuth ignores unofficial leftover credentials", async () => {
  const auth = await resolveCesiumOAuthRequestAuth({
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet-4",
  });
  assert.equal(auth, null);
});
