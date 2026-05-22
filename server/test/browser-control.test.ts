import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserControlCapabilitiesForEngine,
  normalizeBrowserControlViewport,
} from "../src/lib/browser-control/capabilities.js";
import {
  BROWSER_MCP_SERVER_ID,
  BROWSER_MCP_TOOLS,
  callBuiltInBrowserTool,
} from "../src/lib/mcp/builtin-browser-tools.js";
import {
  listBrowserControlTabs,
  resetBrowserControlForTests,
} from "../src/lib/browser-control/service.js";

test("browser-control capabilities are explicit per engine", () => {
  assert.equal(browserControlCapabilitiesForEngine("proxy").navigation, true);
  assert.equal(browserControlCapabilitiesForEngine("proxy").jsEvaluate, false);
  assert.equal(browserControlCapabilitiesForEngine("server-chromium").screenshot, true);
  assert.equal(browserControlCapabilitiesForEngine("server-chromium").viewportEmulation, true);
});

test("browser-control viewport presets and custom values normalize safely", () => {
  assert.equal(normalizeBrowserControlViewport({ preset: "mobile" }).width, 390);
  const custom = normalizeBrowserControlViewport({
    preset: "custom",
    width: 10_000,
    height: 1,
  });
  assert.equal(custom.width, 2400);
  assert.equal(custom.height, 64);
});

test("built-in browser MCP server exposes expected tools", () => {
  assert.equal(BROWSER_MCP_SERVER_ID, "browser");
  const names = new Set(BROWSER_MCP_TOOLS.map((tool) => tool.name));
  assert.equal(names.has("browser_tabs"), true);
  assert.equal(names.has("browser_lock"), true);
  assert.equal(names.has("browser_snapshot"), true);
  assert.equal(names.has("browser_screenshot"), true);
  assert.equal(names.has("browser_viewport"), true);
});

test("built-in browser MCP can list and manage proxy tabs without launching Chromium", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-test";
  const opened = await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://example.com",
      engine: "proxy",
      group: "right",
    },
  });
  assert.match(opened, /browser:/);
  const tab = listBrowserControlTabs(workspaceId)[0];
  assert.ok(tab);
  assert.equal(tab.engine, "proxy");

  const locked = await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_lock",
    arguments: { tabId: tab.tabId, action: "lock", reason: "test" },
  });
  assert.match(locked, /lockVersion/);
  assert.equal(listBrowserControlTabs(workspaceId)[0]?.lockState.locked, true);
});
