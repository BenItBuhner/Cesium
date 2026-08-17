import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  buildWorkspaceWindowUrl,
  normalizeWorkspaceScopedRoute,
} from "../src/lib/workspace-windows.ts";
import {
  consumeDefaultShellViewOnNextLaunch,
  requestDefaultShellViewOnNextLaunch,
} from "../src/lib/workbench-view.ts";

type FakeWindow = {
  location: {
    protocol: string;
    pathname: string;
    href: string;
    search: string;
    hash: string;
  };
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  cesiumDesktop?: { isElectron?: boolean };
};

function makeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

function stubWindow(overrides: Partial<FakeWindow["location"]> & { isElectron?: boolean }) {
  const location = {
    protocol: overrides.protocol ?? "https:",
    pathname: overrides.pathname ?? "/agent",
    href: overrides.href ?? "https://example.test/agent",
    search: overrides.search ?? "",
    hash: overrides.hash ?? "",
  };
  const win: FakeWindow = { location, localStorage: makeLocalStorage() };
  if (overrides.isElectron) {
    win.cesiumDesktop = { isElectron: true };
  }
  (globalThis as { window?: unknown }).window = win;
  return win;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const MOBILE_BUNDLE_PATH = "/android_asset/workbench/index.html";
const MOBILE_BUNDLE_URL = `file://${MOBILE_BUNDLE_PATH}`;

describe("workspace routes on file:// renderers", () => {
  test("http(s) documents normalize to the /agent route", () => {
    stubWindow({ protocol: "https:", pathname: "/somewhere" });
    assert.equal(normalizeWorkspaceScopedRoute("/somewhere"), "/agent");
  });

  test("the Android WebView bundle keeps its on-disk path (no /agent rewrite)", () => {
    // Regression: this used to return "/agent" because only Electron was
    // treated as a file renderer. history.replaceState then recorded
    // file:///agent, and window.location.reload() died with
    // net::ERR_FILE_NOT_FOUND.
    stubWindow({
      protocol: "file:",
      pathname: MOBILE_BUNDLE_PATH,
      href: MOBILE_BUNDLE_URL,
    });
    assert.equal(normalizeWorkspaceScopedRoute(MOBILE_BUNDLE_PATH), MOBILE_BUNDLE_PATH);
    assert.equal(normalizeWorkspaceScopedRoute(null), MOBILE_BUNDLE_PATH);
  });

  test("Electron file documents keep their current path too", () => {
    stubWindow({
      protocol: "file:",
      pathname: "/opt/app/resources/index.html",
      href: "file:///opt/app/resources/index.html",
      isElectron: true,
    });
    assert.equal(
      normalizeWorkspaceScopedRoute("/opt/app/resources/index.html"),
      "/opt/app/resources/index.html"
    );
  });

  test("window URLs built on the mobile bundle point at the real file", () => {
    stubWindow({
      protocol: "file:",
      pathname: MOBILE_BUNDLE_PATH,
      href: MOBILE_BUNDLE_URL,
    });
    const url = buildWorkspaceWindowUrl("null", "ws-1", "win-1");
    assert.ok(
      url.startsWith(`${MOBILE_BUNDLE_URL}?`),
      `expected the bundle URL to be preserved, got ${url}`
    );
    assert.match(url, /workspaceId=ws-1/);
    assert.match(url, /windowId=win-1/);
  });
});

describe("default shell view recovery marker", () => {
  test("round-trips through localStorage and is consumed exactly once", () => {
    stubWindow({ protocol: "file:", pathname: MOBILE_BUNDLE_PATH, href: MOBILE_BUNDLE_URL });
    assert.equal(consumeDefaultShellViewOnNextLaunch(), false);
    requestDefaultShellViewOnNextLaunch();
    assert.equal(consumeDefaultShellViewOnNextLaunch(), true);
    // One-shot: the marker must not survive its first consumption.
    assert.equal(consumeDefaultShellViewOnNextLaunch(), false);
  });

  test("is inert when window/storage is unavailable", () => {
    assert.equal(consumeDefaultShellViewOnNextLaunch(), false);
    assert.doesNotThrow(() => requestDefaultShellViewOnNextLaunch());
  });
});
