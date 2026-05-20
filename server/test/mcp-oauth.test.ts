import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpOAuthCallbackUrl,
  oauthSuccessHtml,
} from "../src/lib/mcp/oauth.js";

test("buildMcpOAuthCallbackUrl uses global callback path", () => {
  const url = buildMcpOAuthCallbackUrl("https://app.example.com/");
  assert.equal(url, "https://app.example.com/api/mcp/oauth/callback");
});

test("oauthSuccessHtml posts message to opener", () => {
  const html = oauthSuccessHtml("Context7");
  assert.match(html, /opencursor-mcp-oauth/);
  assert.match(html, /Context7/);
});
