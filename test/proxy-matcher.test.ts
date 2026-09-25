import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * On Vercel the Next.js 16 proxy is a Node.js Routing Middleware billed as a
 * full Fluid function invocation for every matched request. These cases pin
 * down which paths reach it: the engine machine routes and static files must
 * stay out (they are public and never call Clerk's `auth()`), everything the
 * sign-in gate protects must stay in. The matcher is compiled with Next's own
 * build-time helper so the assertions reflect real routing, not a reading of
 * the regex.
 */

const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require(
  "next/dist/build/analysis/get-page-static-info.js"
) as {
  getMiddlewareMatchers: (
    matchers: string[],
    nextConfig: Record<string, unknown>
  ) => Array<{ regexp: string; originalSource: string }>;
};

function loadProxyMatchers(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../src/proxy.ts", import.meta.url)),
    "utf8"
  );
  const block = source.match(/matcher:\s*\[([\s\S]*?)\n\s*\],/);
  assert.ok(block, "src/proxy.ts must export a literal config.matcher array");
  // The array holds only string literals and comments; evaluating it keeps
  // the escaping identical to what Next sees.
  const matchers = new Function(`return [${block[1]}];`)() as unknown;
  assert.ok(Array.isArray(matchers) && matchers.every((m) => typeof m === "string"));
  return matchers as string[];
}

const compiled = getMiddlewareMatchers(loadProxyMatchers(), {}).map(
  (matcher) => new RegExp(matcher.regexp)
);

function reachesProxy(path: string): boolean {
  return compiled.some((regexp) => regexp.test(path));
}

describe("proxy matcher", () => {
  test("compiles with Next's matcher parser", () => {
    assert.equal(compiled.length, 3);
  });

  test("gated pages and browser API routes still run through the proxy", () => {
    for (const path of [
      "/",
      "/agent",
      "/agent.rsc",
      "/download",
      "/setup",
      "/workspace",
      "/connect/abcdefghjkmnpqrstuvwxyz234",
      "/auth/native-return",
      "/sign-in",
      "/api/inference-relay",
      "/api/git-proxy/github.com/owner/repo/info/refs",
      "/api/github-device-flow",
      "/api/audio/transcriptions",
      "/api/releases/latest",
      "/api/browser-machine-bootstrap",
      "/api/esbuild-wasm",
      "/__clerk/v1/client",
    ]) {
      assert.equal(reachesProxy(path), true, `${path} should reach the proxy`);
    }
  });

  test("engine machine routes never reach the proxy", () => {
    for (const path of [
      "/api/rendezvous",
      "/api/rendezvous/",
      "/api/rendezvous/server_1234567890abcdefghijklmnop",
      "/api/connect/pairings",
      "/api/connect/pairings/abcdefghjkmnpqrstuvwxyz234",
    ]) {
      assert.equal(reachesProxy(path), false, `${path} must bypass the proxy`);
    }
  });

  test("the machine-route exclusion is prefix-exact", () => {
    // A future route that merely shares a prefix keeps its sign-in gate.
    for (const path of ["/api/rendezvous-admin", "/api/connectors", "/api/connected/x"]) {
      assert.equal(reachesProxy(path), true, `${path} should reach the proxy`);
    }
  });

  test("static files by extension never reach the proxy", () => {
    for (const path of [
      "/manifest.json",
      "/robots.txt",
      "/sitemap.xml",
      "/voice/ort/ort-wasm-simd-threaded.wasm",
      "/voice/ort/ort.wasm.min.mjs",
      "/voice/silero_vad.onnx",
      "/icons/icon-192.png",
      "/model-icons/openai.svg",
      "/landing/workbench-dark.webp",
      "/favicon.ico",
      "/ipad-resume-sw.js",
      "/_next/static/chunks/main.js",
      "/_next/image?url=x",
    ]) {
      assert.equal(reachesProxy(path), false, `${path} must bypass the proxy`);
    }
  });
});
