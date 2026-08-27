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

  test("uses a non-vercel.app production hostname next", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.example.com";
    process.env.NODE_ENV = "production";
    assert.equal(getSiteUrl(), "https://app.example.com");
  });

  test("skips *.vercel.app in favor of the custom domain", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "open-cursor.vercel.app";
    process.env.NODE_ENV = "production";
    assert.equal(getSiteUrl(), DEFAULT_PRODUCTION_SITE_URL);
    assert.equal(DEFAULT_PRODUCTION_SITE_URL, "https://cesium.techlitnow.com");
  });
});
