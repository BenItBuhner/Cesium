import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCURSOR_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-oauth-coord-${Date.now()}-${randomUUID().slice(0, 8)}`
);

test("public origin prefers OPENCURSOR_OAUTH_PUBLIC_ORIGIN", async () => {
  const { resolveOAuthPublicOrigin } = await import("../src/lib/oauth/public-origin.js");
  const previous = process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN;
  process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN = "http://192.168.1.20:9100";
  try {
    assert.equal(
      resolveOAuthPublicOrigin({
        url: "http://localhost:9100/api/mcp/oauth/start",
        header: () => undefined,
      }),
      "http://192.168.1.20:9100"
    );
  } finally {
    if (previous == null) delete process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN;
    else process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN = previous;
  }
});

test("oauth sessions persist to disk and expose public status", async () => {
  const {
    createOAuthCoordinatorSession,
    getOAuthCoordinatorSession,
    publicOAuthSession,
    updateOAuthCoordinatorSession,
  } = await import("../src/lib/oauth/sessions.js");
  const created = await createOAuthCoordinatorSession({
    kind: "mcp",
    label: "Linear",
    payload: { serverId: "linear" },
  });
  const loaded = await getOAuthCoordinatorSession(created.id);
  assert.equal(loaded?.kind, "mcp");
  assert.equal(loaded?.status, "pending");
  await updateOAuthCoordinatorSession(created.id, { status: "complete" });
  const done = await getOAuthCoordinatorSession(created.id);
  assert.equal(done?.status, "complete");
  assert.equal(publicOAuthSession(done!).payload, undefined);
});

test("callback HTML posts message and cesium deep link", async () => {
  const { oauthCompletionHtml, buildOAuthDoneDeepLink } = await import(
    "../src/lib/oauth/callback-html.js"
  );
  const html = oauthCompletionHtml({
    title: "MCP connected",
    heading: "Connected",
    message: "Linear is authenticated.",
    postMessageType: "opencursor-mcp-oauth",
    sessionId: "sess-1",
    kind: "mcp",
    ok: true,
  });
  assert.match(html, /opencursor-mcp-oauth/);
  assert.match(html, /cesium:\/\/oauth\/done/);
  assert.match(html, /sess-1/);
  assert.equal(
    buildOAuthDoneDeepLink({ sessionId: "abc", ok: true, kind: "mcp" }),
    "cesium://oauth/done?session=abc&ok=1&kind=mcp"
  );
});

test("WWW-Authenticate and official registry mapping", async () => {
  const { parseWwwAuthenticate } = await import("../src/lib/mcp/oauth-discovery.js");
  const parsed = parseWwwAuthenticate(
    'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
  );
  assert.equal(parsed.resourceMetadata, "https://mcp.example.com/.well-known/oauth-protected-resource");

  const { mapOfficialMcpServerToPlugin } = await import(
    "../src/lib/plugins/official-registry.js"
  );
  const plugin = mapOfficialMcpServerToPlugin({
    server: {
      name: "io.github.example/exa",
      title: "Exa",
      description: "Web search",
      remotes: [{ type: "streamable-http", url: "https://mcp.exa.ai/mcp" }],
    },
  });
  assert.equal(plugin?.pluginId, "exa");
  assert.equal(plugin?.mcp[0]?.server?.remote?.url, "https://mcp.exa.ai/mcp");
});

test("dynamic client registration posts redirect_uris", async () => {
  const { registerOAuthClient } = await import("../src/lib/mcp/oauth-discovery.js");
  const http = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris?: string[] };
    assert.deepEqual(body.redirect_uris, ["https://app.example.com/api/mcp/oauth/callback"]);
    return new Response(JSON.stringify({ client_id: "dyn-client" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const registered = await registerOAuthClient({
    registrationUrl: "https://mcp.linear.app/register",
    redirectUri: "https://app.example.com/api/mcp/oauth/callback",
    http,
  });
  assert.equal(registered.clientId, "dyn-client");
});
