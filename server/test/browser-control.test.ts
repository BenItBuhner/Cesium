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
  normalizeBrowserMcpToolInvocation,
} from "../src/lib/mcp/builtin-browser-tools.js";
import {
  closeBrowserControlTab,
  completeBrowserControlCommand,
  listBrowserControlTabs,
  readBrowserControlCommands,
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

test("built-in browser MCP maps browser_unlock to browser_lock action=unlock", () => {
  assert.deepEqual(
    normalizeBrowserMcpToolInvocation({
      toolName: "browser_unlock",
      arguments: { tabId: "tab-1" },
    }),
    {
      toolName: "browser_lock",
      arguments: { tabId: "tab-1", action: "unlock" },
    }
  );
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

test("built-in browser MCP supports visible editor tabs when requested", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-visible";
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://www.bing.com",
      engine: "electron-native",
    },
  });
  const tab = listBrowserControlTabs(workspaceId)[0];
  assert.ok(tab);
  assert.equal(tab.engine, "electron-native");
  assert.equal(tab.debugSessionId, null);

  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_navigate",
    arguments: {
      tabId: tab.tabId,
      url: "https://www.bing.com/search?q=browser%20mcp",
    },
  });
  assert.equal(
    listBrowserControlTabs(workspaceId)[0]?.currentUrl,
    "https://www.bing.com/search?q=browser%20mcp"
  );

  const snapshotPromise = callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_snapshot",
    arguments: { tabId: tab.tabId },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshotCommands = readBrowserControlCommands(workspaceId, tab.tabId);
  assert.equal(snapshotCommands.commands[0]?.type, "snapshot");
  completeBrowserControlCommand({
    workspaceId,
    tabId: tab.tabId,
    seq: snapshotCommands.commands[0]!.seq,
    ok: true,
    result: {
      title: "Bing Search",
      url: "https://www.bing.com/search?q=browser%20mcp",
      visibleText: "Search results",
      elementRefs: [],
    },
  });
  const snapshot = await snapshotPromise;
  assert.match(snapshot, /Search results/);
});

test("opening an active browser tab clears focus from locked tabs", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-focus";
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://first.example",
      engine: "electron-native",
    },
  });
  const first = listBrowserControlTabs(workspaceId)[0];
  assert.ok(first);
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_lock",
    arguments: { tabId: first.tabId, action: "lock", reason: "agent test" },
  });
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://second.example",
      engine: "electron-native",
    },
  });
  const tabs = listBrowserControlTabs(workspaceId);
  assert.equal(tabs.find((tab) => tab.tabId === first.tabId)?.focused, false);
  assert.equal(tabs.find((tab) => tab.targetUrl === "https://second.example")?.focused, true);
});

test("browser click can target selectors through visible tab evaluation", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-selector";
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://example.com",
      engine: "electron-native",
    },
  });
  const tab = listBrowserControlTabs(workspaceId)[0];
  assert.ok(tab);

  const clickedPromise = callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_click",
    arguments: {
      tabId: tab.tabId,
      selector: "#submit",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commands = readBrowserControlCommands(workspaceId, tab.tabId);
  assert.equal(commands.commands[0]?.type, "evaluate");
  completeBrowserControlCommand({
    workspaceId,
    tabId: tab.tabId,
    seq: commands.commands[0]!.seq,
    ok: true,
    result: { ok: true, tag: "button" },
  });
  const clicked = await clickedPromise;
  assert.match(clicked, /"ok": true/);
  assert.match(clicked, /"#submit"/);
});

test("visible browser tabs accept queued input without server Chromium", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-input";
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://example.com",
      engine: "electron-native",
    },
  });
  const tab = listBrowserControlTabs(workspaceId)[0];
  assert.ok(tab);

  const clickedPromise = callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_click",
    arguments: {
      tabId: tab.tabId,
      x: 10,
      y: 20,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const clickCommands = readBrowserControlCommands(workspaceId, tab.tabId);
  assert.equal(clickCommands.commands[0]?.type, "input");
  completeBrowserControlCommand({
    workspaceId,
    tabId: tab.tabId,
    seq: clickCommands.commands[0]!.seq,
    ok: true,
  });
  const clicked = await clickedPromise;
  assert.match(clicked, /"ok": true/);
  assert.match(clicked, /verifiedPageEffect/);

  const typedPromise = callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_type",
    arguments: {
      tabId: tab.tabId,
      text: "hello",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const typeCommands = readBrowserControlCommands(
    workspaceId,
    tab.tabId,
    clickCommands.cursor
  );
  assert.equal(typeCommands.commands[0]?.type, "input");
  completeBrowserControlCommand({
    workspaceId,
    tabId: tab.tabId,
    seq: typeCommands.commands[0]!.seq,
    ok: true,
  });
  const typed = await typedPromise;
  assert.match(typed, /"ok": true/);
});

test("closing visible browser tabs clears queued commands", async () => {
  resetBrowserControlForTests();
  const workspaceId = "ws-close";
  await callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_tabs",
    arguments: {
      action: "open",
      url: "https://example.com",
      engine: "electron-native",
    },
  });
  const tab = listBrowserControlTabs(workspaceId)[0];
  assert.ok(tab);

  const clickedPromise = callBuiltInBrowserTool({
    workspaceId,
    toolName: "browser_click",
    arguments: {
      tabId: tab.tabId,
      x: 10,
      y: 20,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readBrowserControlCommands(workspaceId, tab.tabId).commands.length, 1);

  await closeBrowserControlTab(workspaceId, tab.tabId);
  const clicked = await clickedPromise;
  assert.match(clicked, /"ok": false/);
  assert.equal(listBrowserControlTabs(workspaceId).length, 0);
});
