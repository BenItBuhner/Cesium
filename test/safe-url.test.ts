import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tryParseUrl } from "../src/lib/safe-url.ts";
import { buildWorkspaceScopedUrl } from "../src/lib/workspace-windows.ts";

describe("safe-url", () => {
  test("tryParseUrl returns null for invalid input", () => {
    assert.equal(tryParseUrl(""), null);
    assert.equal(tryParseUrl("not a url"), null);
  });
});

describe("buildWorkspaceScopedUrl", () => {
  test("does not throw when desktop route is a packaged index.html path", () => {
    const built = buildWorkspaceScopedUrl(
      "null",
      "/C:/Users/benpr/AppData/Local/Programs/Cesium/resources/desktop-renderer/index.html",
      "ws-1",
      "win-1"
    );
    assert.ok(built.includes("workspaceId=ws-1"));
    assert.ok(built.includes("windowId=win-1"));
  });
});
