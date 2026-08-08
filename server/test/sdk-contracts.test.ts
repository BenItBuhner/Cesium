import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CESIUM_PROTOCOL_VERSION,
  CESIUM_SDK_OPERATIONS,
} from "@cesium/contracts";
import { CesiumClient } from "@cesium/sdk";
import { createCesiumApp } from "../src/app.js";

describe("public SDK contract", () => {
  test("every declared HTTP operation has a matching Hono route", () => {
    const app = createCesiumApp();
    const registered = new Set(
      app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`)
    );
    const operationIds = new Set<string>();

    for (const operation of CESIUM_SDK_OPERATIONS) {
      assert.equal(
        operationIds.has(operation.id),
        false,
        `Duplicate SDK operation id: ${operation.id}`
      );
      operationIds.add(operation.id);
      assert.equal(
        registered.has(`${operation.method} ${operation.path}`),
        true,
        `Missing server route for SDK operation ${operation.id}: ${operation.method} ${operation.path}`
      );
    }
  });

  test("serves metadata through the standalone SDK transport", async () => {
    const app = createCesiumApp();
    const client = new CesiumClient({
      baseUrl: "http://cesium.test",
      fetch: (input, init) => app.request(input, init),
    });

    const metadata = await client.system.assertCompatible();
    assert.equal(metadata.name, "cesium");
    assert.equal(metadata.protocolVersion, CESIUM_PROTOCOL_VERSION);
    assert.ok(metadata.capabilities.includes("agents.conversations"));
    assert.ok(metadata.capabilities.includes("cloud-agents"));
  });

  test("allows and exposes optimistic-concurrency headers cross-origin", async () => {
    const app = createCesiumApp();
    const response = await app.request("/api/meta", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "If-Match, If-None-Match",
      },
    });

    assert.equal(response.status, 204);
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    const exposed = response.headers.get("access-control-expose-headers") ?? "";
    assert.match(allowed.toLowerCase(), /if-match/);
    assert.match(allowed.toLowerCase(), /if-none-match/);
    assert.match(exposed.toLowerCase(), /etag/);
    assert.match(exposed.toLowerCase(), /x-cesium-protocol-version/);
  });
});
