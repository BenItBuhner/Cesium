import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolvePublicAssetUrlForRuntime } from "../src/lib/public-asset-url";

describe("publicAssetUrl", () => {
  test("anchors packaged file assets to the renderer bundle root", () => {
    const resolved = resolvePublicAssetUrlForRuntime("/model-icons/Claude-Light.svg", {
      protocol: "file:",
      locationHref: "file:///agent?workspaceId=abc",
      moduleUrl:
        "file:///C:/Users/benpr/AppData/Local/Programs/Cesium/resources/desktop-renderer/assets/index-abc123.js",
    });

    assert.equal(
      resolved,
      "file:///C:/Users/benpr/AppData/Local/Programs/Cesium/resources/desktop-renderer/model-icons/Claude-Light.svg"
    );
  });

  test("preserves escaped install paths", () => {
    const resolved = resolvePublicAssetUrlForRuntime("/agent-backend-icons/Cursor-Light.svg", {
      protocol: "file:",
      locationHref: "file:///agent",
      moduleUrl:
        "file:///C:/Users/benpr/AppData/Local/Programs/Cesium%20Preview/resources/desktop-renderer/assets/index-abc123.js",
    });

    assert.equal(
      resolved,
      "file:///C:/Users/benpr/AppData/Local/Programs/Cesium%20Preview/resources/desktop-renderer/agent-backend-icons/Cursor-Light.svg"
    );
  });

  test("keeps web and dev server public paths unchanged", () => {
    assert.equal(
      resolvePublicAssetUrlForRuntime("/model-icons/ChatGPT-Light.svg", {
        protocol: "http:",
        locationHref: "http://127.0.0.1:5173/agent",
        moduleUrl: "http://127.0.0.1:5173/src/lib/public-asset-url.ts",
      }),
      "/model-icons/ChatGPT-Light.svg"
    );
  });
});
