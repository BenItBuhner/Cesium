import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractServerErrorMessage } from "../packages/client/src/server-api.ts";

/**
 * Error bodies from a misconfigured "server" (most commonly a hosted web
 * deployment answering with its own Next.js HTML) must never reach the UI
 * verbatim — regression coverage for the raw-HTML "Workspace error" toast.
 */

const HTML_DOCUMENT =
  '<!DOCTYPE html><!--fldDWFBpAYBgjHf4Ju1Bb--><html lang="en"><head><meta charSet="utf-8"/>' +
  '<script src="/_next/static/chunks/82abf2d65f5428ae.js" async=""></script></head><body></body></html>';

describe("extractServerErrorMessage", () => {
  test("replaces HTML documents with a friendly wrong-server message", () => {
    const message = extractServerErrorMessage(HTML_DOCUMENT, 404);
    assert.ok(message.includes("did not respond like a Cesium engine"));
    assert.ok(message.includes("404"));
    assert.ok(!message.includes("<"), "must not leak markup");
  });

  test("replaces any markup-leading body, not just full documents", () => {
    const message = extractServerErrorMessage("<html><body>Bad gateway</body></html>", 502);
    assert.ok(message.includes("did not respond like a Cesium engine"));
  });

  test("extracts JSON error and message fields", () => {
    assert.equal(extractServerErrorMessage('{"error":"Workspace not found"}', 404), "Workspace not found");
    assert.equal(extractServerErrorMessage('{"message":"Rate limited"}', 429), "Rate limited");
  });

  test("passes through plain-text errors", () => {
    assert.equal(extractServerErrorMessage("Engine restarting", 503), "Engine restarting");
  });

  test("falls back on empty bodies, honoring custom fallbacks", () => {
    assert.equal(extractServerErrorMessage("", 500), "Request failed with status 500");
    assert.equal(extractServerErrorMessage("  ", 500, "Migration failed"), "Migration failed");
  });

  test("caps very long plain-text bodies", () => {
    const message = extractServerErrorMessage("x".repeat(5000), 500);
    assert.ok(message.length <= 301);
    assert.ok(message.endsWith("…"));
  });
});
