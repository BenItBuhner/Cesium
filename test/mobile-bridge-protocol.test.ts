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
  assert.ok(script.includes('"nativeReady"'));
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

test("first-paint theme script honors both theme storage keys", () => {
  const script = buildMobileFirstPaintThemeScript();
  assert.ok(script.includes(MOBILE_THEME_CONFIG_STORAGE_KEY));
  assert.ok(script.includes(MOBILE_LEGACY_THEME_STORAGE_KEY));
  assert.ok(script.includes("prefers-color-scheme"));
  assert.ok(script.includes('classList.toggle("dark"'));
});
