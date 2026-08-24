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

  test("preserves the Android origin when ALLOWED_ORIGINS replaces browser defaults", async () => {
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    const previousAndroidOrigin = process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN;
    process.env.ALLOWED_ORIGINS = "https://workbench.example";
    delete process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN;
    try {
      const mobileResponse = await createCesiumApp().request("/api/agents/imports/sources", {
        headers: { Origin: "null" },
      });
      assert.equal(mobileResponse.status, 200);
      assert.equal(mobileResponse.headers.get("access-control-allow-origin"), "null");

      const browserResponse = await createCesiumApp().request("/health", {
        headers: { Origin: "https://workbench.example" },
      });
      assert.equal(
        browserResponse.headers.get("access-control-allow-origin"),
        "https://workbench.example"
      );
    } finally {
      if (previousAllowedOrigins === undefined) {
        delete process.env.ALLOWED_ORIGINS;
      } else {
        process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
      }
      if (previousAndroidOrigin === undefined) {
        delete process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN;
      } else {
        process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN = previousAndroidOrigin;
      }
    }
  });

  test("can explicitly disable the opaque Android file origin", async () => {
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    const previousAndroidOrigin = process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN;
    process.env.ALLOWED_ORIGINS = "https://workbench.example";
    process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN = "0";
    try {
      const response = await createCesiumApp().request("/health", {
        headers: { Origin: "null" },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    } finally {
      if (previousAllowedOrigins === undefined) {
        delete process.env.ALLOWED_ORIGINS;
      } else {
        process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
      }
      if (previousAndroidOrigin === undefined) {
        delete process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN;
      } else {
        process.env.OPENCURSOR_ALLOW_ANDROID_FILE_ORIGIN = previousAndroidOrigin;
      }
    }
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
