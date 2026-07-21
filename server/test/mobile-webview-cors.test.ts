import { describe, expect, test } from "bun:test";
import { createCesiumApp } from "../src/app.js";

describe("Android bundled workbench CORS", () => {
  test("allows the null origin emitted by file:// Android WebView assets", async () => {
    const response = await createCesiumApp().request("/health", {
      headers: { Origin: "null" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
