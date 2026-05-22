import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BROWSER_ENGINE_CAPABILITIES,
  REMOTE_BROWSER_EVENT_POLL_INTERVAL_MS,
  REMOTE_BROWSER_HOVER_REFRESH_DELAY_MS,
  REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS,
  REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS,
  REMOTE_BROWSER_POINTER_MOVE_THROTTLE_MS,
  type BrowserEngineKind,
} from "../src/lib/browser-engine.ts";
import { createDefaultGlobalSettings } from "../src/lib/global-settings.ts";
import {
  createInitialEditorState,
  editorPanelReducer,
} from "../src/components/editor/editor-panel-state.ts";

describe("browser engine capabilities", () => {
  test("documents fidelity differences between engines", () => {
    assert.equal(BROWSER_ENGINE_CAPABILITIES["electron-native"].nativeView, true);
    assert.equal(BROWSER_ENGINE_CAPABILITIES["electron-native"].realNetworkStack, true);
    assert.equal(BROWSER_ENGINE_CAPABILITIES["server-chromium"].fullDevtools, true);
    assert.equal(BROWSER_ENGINE_CAPABILITIES.proxy.realNetworkStack, false);
  });
});

describe("new browser beta flag", () => {
  test("keeps the legacy proxy browser as the default", () => {
    const settings = createDefaultGlobalSettings();
    assert.equal(settings.agents.newBrowser, false);
  });
});

describe("browser tab engine metadata", () => {
  test("opens with proxy fallback and can promote to native/remote engines", () => {
    let state = createInitialEditorState([]);
    state = editorPanelReducer(state, {
      type: "OPEN_BROWSER_TAB",
      url: "localhost:3000",
    });
    const tab = state.leftTabs[0];
    assert.ok(tab?.browser);
    assert.equal(tab.browser.targetUrl, "http://localhost:3000/");
    assert.equal(tab.browser.engine, "proxy");

    const nativeEngine: BrowserEngineKind = "electron-native";
    state = editorPanelReducer(state, {
      type: "UPDATE_BROWSER_TAB_META",
      tabId: tab.id,
      engine: nativeEngine,
      nativeSessionId: "nb-test",
    });
    assert.equal(state.leftTabs[0]?.browser?.engine, "electron-native");
    assert.equal(state.leftTabs[0]?.browser?.nativeSessionId, "nb-test");

    state = editorPanelReducer(state, {
      type: "UPDATE_BROWSER_TAB_META",
      tabId: tab.id,
      engine: "server-chromium",
      debugSessionId: "bd-test",
      devtoolsPath: "/browser-debug/bd-test/devtools/devtools_app.html",
    });
    assert.equal(state.leftTabs[0]?.browser?.engine, "server-chromium");
    assert.equal(state.leftTabs[0]?.browser?.debugSessionId, "bd-test");
  });

  test("stores browser-control ids, locks, and viewport metadata", () => {
    let state = createInitialEditorState([]);
    state = editorPanelReducer(state, {
      type: "OPEN_BROWSER_TAB",
      tabId: "browser:test",
      url: "https://example.com",
      group: "right",
      engine: "server-chromium",
      controlSessionId: "bc-test",
      lockState: { locked: true, lockVersion: 1, lockReason: "agent test" },
      viewport: { preset: "mobile", width: 390, height: 844, deviceScaleFactor: 3 },
    });
    assert.equal(state.rightTabs[0]?.id, "browser:test");
    assert.equal(state.rightTabs[0]?.browser?.controlSessionId, "bc-test");
    assert.equal(state.rightTabs[0]?.browser?.lockState?.locked, true);
    assert.equal(state.rightTabs[0]?.browser?.viewport?.preset, "mobile");

    state = editorPanelReducer(state, {
      type: "UPDATE_BROWSER_TAB_META",
      tabId: "browser:test",
      lockState: { locked: false, lockVersion: 2, userUnlockedAt: 123 },
      viewport: { preset: "desktop", width: 1440, height: 900 },
    });
    assert.equal(state.rightTabs[0]?.browser?.lockState?.locked, false);
    assert.equal(state.rightTabs[0]?.browser?.lockState?.userUnlockedAt, 123);
    assert.equal(state.rightTabs[0]?.browser?.viewport?.width, 1440);
  });
});

describe("new browser interaction timing", () => {
  test("keeps hover/input refreshes responsive without constant screenshot polling", () => {
    assert.equal(REMOTE_BROWSER_POINTER_MOVE_THROTTLE_MS <= 100, true);
    assert.equal(REMOTE_BROWSER_HOVER_REFRESH_DELAY_MS <= 120, true);
    assert.equal(REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS <= 120, true);
    assert.equal(REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS <= 300, true);
    assert.equal(REMOTE_BROWSER_EVENT_POLL_INTERVAL_MS >= 1000, true);
  });
});

