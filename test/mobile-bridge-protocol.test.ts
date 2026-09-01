import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  MOBILE_LEGACY_THEME_STORAGE_KEY,
  MOBILE_NATIVE_ROOT_CLASS,
  MOBILE_SAFE_AREA_TOP_VAR,
  MOBILE_THEME_CONFIG_STORAGE_KEY,
  buildMobileBootstrapScript,
  buildMobileFirstPaintThemeScript,
  encodeMobileBridgeMessage,
  normalizeMobileServerConfig,
  parseMobileBridgeMessage,
  type MobileWebToNativeMessage,
} from "../packages/core/src/mobile-bridge.ts";

test("bridge messages round-trip through encode/parse", () => {
  const message: MobileWebToNativeMessage = {
    type: "webReady",
    workspaceId: "workspace",
    focusedConversationId: "conversation",
    authToken: null,
    protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
  };
  const parsed = parseMobileBridgeMessage<MobileWebToNativeMessage>(
    encodeMobileBridgeMessage(message)
  );
  assert.deepEqual(parsed, message);
});

test("parse rejects non-protocol payloads", () => {
  assert.equal(parseMobileBridgeMessage("not json"), null);
  assert.equal(parseMobileBridgeMessage(""), null);
  assert.equal(parseMobileBridgeMessage(42), null);
  assert.equal(parseMobileBridgeMessage(JSON.stringify({ noType: true })), null);
});

test("server config normalization trims URLs and clamps the safe area", () => {
  const normalized = normalizeMobileServerConfig({
    baseUrl: "http://10.0.2.2:9100///",
    safeAreaTop: 23.4,
    systemColorScheme: "dark",
  });
  assert.equal(normalized.baseUrl, "http://10.0.2.2:9100");
  assert.equal(normalized.safeAreaTop, 24);
  assert.equal(normalized.systemColorScheme, "dark");
  assert.equal(normalized.authToken, null);
  assert.equal(normalized.runtime, null);

  const negative = normalizeMobileServerConfig({ baseUrl: "http://x", safeAreaTop: -4 });
  assert.equal(negative.safeAreaTop, 0);
});

test("bootstrap script carries host identity, protocol version, and the relay", () => {
  const script = buildMobileBootstrapScript({
    baseUrl: "http://10.0.2.2:9100",
    label: "This phone",
    safeAreaTop: 24,
    systemColorScheme: "dark",
  });
  assert.ok(script.includes(`protocolVersion: ${MOBILE_BRIDGE_PROTOCOL_VERSION}`));
  // The ready message is embedded as a JSON string literal (escaped quotes).
  assert.ok(script.includes("nativeReady"));
  assert.ok(script.includes("__CESIUM_MOBILE_SERVER__"));
  assert.ok(script.includes("__CESIUM_MOBILE_NATIVE_READY__"));
  assert.ok(script.includes(MOBILE_BRIDGE_MESSAGE_EVENT));
  assert.ok(script.includes(MOBILE_NATIVE_ROOT_CLASS));
  assert.ok(script.includes(MOBILE_SAFE_AREA_TOP_VAR));
  // The crash reporter is part of the single bootstrap now.
  assert.ok(script.includes("webRuntimeError"));
  // Polyfills and theming moved into the bundled workbench; the injected
  // bootstrap must stay minimal.
  assert.ok(!script.includes("replaceAll"));
  assert.ok(!script.includes("structuredClone"));
  assert.ok(!script.includes(MOBILE_THEME_CONFIG_STORAGE_KEY));
});

type BootstrapDomStub = {
  window: Record<string, unknown> & {
    dispatchedEvents: Array<{ type: string; detail: unknown }>;
    messageListeners: Array<(event: { data: unknown }) => void>;
  };
  document: Record<string, unknown>;
  rootClassList: Set<string>;
  rootStyleVars: Map<string, string>;
};

/**
 * Minimal DOM stand-in that runs the injected bootstrap the way the Android
 * WebView does at documentStart: no React, no workbench modules mounted.
 */
function createBootstrapDomStub(): BootstrapDomStub {
  const rootClassList = new Set<string>();
  const rootStyleVars = new Map<string, string>();
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const dispatchedEvents: Array<{ type: string; detail: unknown }> = [];

  const documentElement = {
    classList: {
      add: (name: string) => void rootClassList.add(name),
      toggle: (name: string, force?: boolean) => {
        if (force ?? !rootClassList.has(name)) {
          rootClassList.add(name);
          return true;
        }
        rootClassList.delete(name);
        return false;
      },
    },
    style: {
      setProperty: (name: string, value: string) => void rootStyleVars.set(name, value),
      colorScheme: "",
    },
  };

  const documentStub: Record<string, unknown> = {
    documentElement,
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") {
        messageListeners.push(listener);
      }
    },
  };

  const windowStub: BootstrapDomStub["window"] = {
    dispatchedEvents,
    messageListeners,
    location: {
      protocol: "https:",
      href: "https://workbench.test/agent",
      origin: "https://workbench.test",
    },
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") {
        messageListeners.push(listener);
      }
    },
    dispatchEvent: (event: { type: string; detail?: unknown }) => {
      dispatchedEvents.push({ type: event.type, detail: event.detail });
      return true;
    },
    open: () => null,
  };

  return { window: windowStub, document: documentStub, rootClassList, rootStyleVars };
}

test("bootstrap relay applies safe-area config with no workbench listener mounted", () => {
  // Regression: on cold start the bootstrap often embeds safeAreaTop 0 (the
  // native inset resolves asynchronously). The healing `nativeConfigChanged`
  // used to be relayed as a CustomEvent only - dropped whenever it raced
  // React hydration or the first-run account gate, leaving the top chrome
  // pinned under the status bar for the whole session.
  const script = buildMobileBootstrapScript({
    baseUrl: "http://10.0.2.2:9100",
    label: "This phone",
    safeAreaTop: 0,
    systemColorScheme: "dark",
  });
  const stub = createBootstrapDomStub();
  new Function("window", "document", script)(stub.window, stub.document);

  // Boot state: native root class applied, inset embedded as 0.
  assert.ok(stub.rootClassList.has(MOBILE_NATIVE_ROOT_CLASS));
  assert.equal(stub.rootStyleVars.get(MOBILE_SAFE_AREA_TOP_VAR), "0px");
  assert.ok(stub.window.messageListeners.length > 0);

  // Native heals with the real inset while nothing web-side listens yet.
  // The same relay is registered on window AND document (Chromium delivers
  // to one or the other depending on version); a real message fires it once.
  const healedServer = {
    baseUrl: "http://10.0.2.2:9100",
    label: "This phone",
    authToken: null,
    safeAreaTop: 47,
    systemColorScheme: "dark",
    runtime: null,
  };
  for (const listener of new Set(stub.window.messageListeners)) {
    listener({
      data: JSON.stringify({ type: "nativeConfigChanged", server: healedServer }),
    });
  }

  // The relay itself must apply the safe area and refresh the host globals.
  assert.equal(stub.rootStyleVars.get(MOBILE_SAFE_AREA_TOP_VAR), "47px");
  assert.deepEqual(stub.window.__CESIUM_MOBILE_SERVER__, healedServer);
  assert.deepEqual(
    (stub.window.cesiumMobile as { server?: unknown } | undefined)?.server,
    healedServer
  );
  // And still re-dispatch for React consumers that mount later.
  const relayed = stub.window.dispatchedEvents.filter(
    (event) => event.type === MOBILE_BRIDGE_MESSAGE_EVENT
  );
  assert.equal(relayed.length, 1);
  assert.deepEqual(relayed[0]?.detail, { type: "nativeConfigChanged", server: healedServer });
});

test("first-paint theme script honors both theme storage keys", () => {
  const script = buildMobileFirstPaintThemeScript();
  assert.ok(script.includes(MOBILE_THEME_CONFIG_STORAGE_KEY));
  assert.ok(script.includes(MOBILE_LEGACY_THEME_STORAGE_KEY));
  assert.ok(script.includes("prefers-color-scheme"));
  assert.ok(script.includes('classList.toggle("dark"'));
});
