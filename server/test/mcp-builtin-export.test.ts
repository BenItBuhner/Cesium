import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENCURSOR_DATA_DIR = await mkdtemp(
  path.join(os.tmpdir(), "cesium-builtin-export-data-")
);

const { exportBuiltInMcpServersForSdk } = await import(
  "../src/lib/agents/mcp-export-adapter.js"
);
const { builtinMcpHttpUrl, localMcpServerBaseUrl } = await import(
  "../src/lib/mcp/http-bridge-url.js"
);
const { setBuiltInBrowserMcpEnabled } = await import("../src/lib/mcp/server-store.js");

test("built-in browser MCP is exported to harness SDKs as a local HTTP server", async () => {
  const servers = await exportBuiltInMcpServersForSdk("ws-export");
  const browser = servers.browser;
  assert.ok(browser, "browser server should be exported by default");
  assert.equal(browser.type, "http");
  if (browser.type === "http") {
    assert.equal(browser.url, builtinMcpHttpUrl("ws-export", "browser"));
    assert.match(browser.url, /\/api\/workspaces\/ws-export\/mcp\/servers\/browser\/http$/);
  }
});

test("disabling the built-in browser MCP removes it from the harness export", async () => {
  await setBuiltInBrowserMcpEnabled("ws-export-disabled", false);
  const servers = await exportBuiltInMcpServersForSdk("ws-export-disabled");
  assert.equal(servers.browser, undefined);
  await setBuiltInBrowserMcpEnabled("ws-export-disabled", true);
  const restored = await exportBuiltInMcpServersForSdk("ws-export-disabled");
  assert.ok(restored.browser);
});

test("local MCP base URL honors PORT and OPENCURSOR_SERVER_URL", () => {
  const previousUrl = process.env.OPENCURSOR_SERVER_URL;
  const previousPort = process.env.PORT;
  try {
    delete process.env.OPENCURSOR_SERVER_URL;
    process.env.PORT = "9155";
    assert.equal(localMcpServerBaseUrl(), "http://127.0.0.1:9155");
    process.env.OPENCURSOR_SERVER_URL = "http://10.0.0.5:9100/";
    assert.equal(localMcpServerBaseUrl(), "http://10.0.0.5:9100");
  } finally {
    if (previousUrl == null) delete process.env.OPENCURSOR_SERVER_URL;
    else process.env.OPENCURSOR_SERVER_URL = previousUrl;
    if (previousPort == null) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});
