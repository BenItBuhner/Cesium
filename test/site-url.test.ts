import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DEFAULT_PRODUCTION_SITE_URL, getSiteUrl } from "../src/lib/site-url.ts";

const original = {
  site: process.env.NEXT_PUBLIC_SITE_URL,
  vercelUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  vercel: process.env.VERCEL,
  nodeEnv: process.env.NODE_ENV,
};

afterEach(() => {
  restore("NEXT_PUBLIC_SITE_URL", original.site);
  restore("VERCEL_PROJECT_PRODUCTION_URL", original.vercelUrl);
  restore("VERCEL", original.vercel);
  restore("NODE_ENV", original.nodeEnv);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("getSiteUrl", () => {
  test("prefers an explicit site URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://cesium.example.com/";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    assert.equal(getSiteUrl(), "https://cesium.example.com");
  });

  test("uses the Vercel production hostname next", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "open-cursor.vercel.app";
    assert.equal(getSiteUrl(), "https://open-cursor.vercel.app");
  });

  test("falls back to the custom domain in production builds", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.NODE_ENV = "production";
    assert.equal(getSiteUrl(), DEFAULT_PRODUCTION_SITE_URL);
    assert.equal(DEFAULT_PRODUCTION_SITE_URL, "https://cesium.techlitnow.com");
  });
});
