import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCesiumApp } from "../src/app.js";

describe("Android bundled workbench CORS", () => {
  test("allows the null origin emitted by file:// Android WebView assets", async () => {
    const response = await createCesiumApp().request("/health", {
      headers: { Origin: "null" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "null");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  });

  test("allows the Vite renderer origins used for mobile development", async () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://10.0.2.2:5173",
    ]) {
      const response = await createCesiumApp().request("/health", {
        headers: { Origin: origin },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
  });
});
