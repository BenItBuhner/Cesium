import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildMobileBootstrapScript,
  encodeMobileBridgeMessage,
  parseMobileBridgeMessage,
} from "../src/lib/mobile-bridge.ts";

describe("mobile bridge", () => {
  test("round-trips typed bridge messages", () => {
    const encoded = encodeMobileBridgeMessage({
      type: "focusedConversationChanged",
      workspaceId: "w1",
      conversationId: "c1",
      lastEventSeq: 42,
    });
    const parsed = parseMobileBridgeMessage<{
      type: string;
      workspaceId: string;
      conversationId: string;
      lastEventSeq: number;
    }>(encoded);
    assert.deepEqual(parsed, {
      type: "focusedConversationChanged",
      workspaceId: "w1",
      conversationId: "c1",
      lastEventSeq: 42,
    });
  });

  test("rejects malformed bridge payloads", () => {
    assert.equal(parseMobileBridgeMessage("{"), null);
    assert.equal(parseMobileBridgeMessage(JSON.stringify({ value: true })), null);
    assert.equal(parseMobileBridgeMessage(null), null);
  });

  test("bootstrap script embeds sanitized mobile server metadata", () => {
    const script = buildMobileBootstrapScript({
      baseUrl: "http://10.0.2.2:9100/",
      label: "Emulator",
      authToken: "secret",
      safeAreaTop: 24,
      systemColorScheme: "dark",
    });
    assert.match(script, /window\.cesiumMobile/);
    assert.match(script, /http:\/\/10\.0\.2\.2:9100/);
    assert.doesNotMatch(script, /http:\/\/10\.0\.2\.2:9100\//);
    assert.match(script, /nativeReady/);
    assert.match(script, /"safeAreaTop":24/);
    assert.match(script, /"systemColorScheme":"dark"/);
    assert.match(script, /opencursor-theme-config/);
    assert.match(script, /applyStartupTheme/);
    assert.doesNotMatch(script, /safeAreaTop":44/);
  });

  test("bootstrap script does not invent a minimum safe area", () => {
    const script = buildMobileBootstrapScript({
      baseUrl: "http://10.0.2.2:9100/",
      label: "Emulator",
    });
    assert.match(script, /"safeAreaTop":0/);
    assert.doesNotMatch(script, /--opencursor-mobile-safe-area-top:44px/);
  });
});
