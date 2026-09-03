import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  clerkFapiOriginFromPublishableKey,
  installClerkFapiTunnel,
  isClerkFapiUrl,
} from "../src/lib/cloud/clerk-fapi-tunnel.ts";
import {
  isClerkFapiRelayUrl,
  parseOAuthCompletedDeepLinkParams,
} from "../packages/core/src/mobile-bridge.ts";
import { CESIUM_CLOUD_DEFAULTS } from "../src/lib/cloud/cloud-defaults.ts";

const TEST_FAPI_HOST = "clerk.example.com";
const TEST_PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${TEST_FAPI_HOST}$`).toString("base64")}`;

describe("clerk FAPI origin derivation", () => {
  test("decodes the frontend API host from a publishable key", () => {
    assert.equal(
      clerkFapiOriginFromPublishableKey(TEST_PUBLISHABLE_KEY),
      `https://${TEST_FAPI_HOST}`
    );
    assert.equal(
      clerkFapiOriginFromPublishableKey(CESIUM_CLOUD_DEFAULTS.clerkPublishableKey),
      "https://clerk.cesium.techlitnow.com"
    );
  });

  test("rejects malformed keys", () => {
    assert.equal(clerkFapiOriginFromPublishableKey(null), null);
    assert.equal(clerkFapiOriginFromPublishableKey(""), null);
    assert.equal(clerkFapiOriginFromPublishableKey("sk_live_notapk"), null);
    assert.equal(clerkFapiOriginFromPublishableKey("pk_live_!!!"), null);
  });

  test("matches only the exact FAPI origin", () => {
    const origin = `https://${TEST_FAPI_HOST}`;
    assert.equal(isClerkFapiUrl(`${origin}/v1/client`, origin), true);
    assert.equal(isClerkFapiUrl(`${origin}/v1/client/sign_ins?_is_native=1`, origin), true);
    assert.equal(isClerkFapiUrl("https://evil.example.com/v1/client", origin), false);
    assert.equal(isClerkFapiUrl("http://clerk.example.com/v1/client", origin), false);
    assert.equal(isClerkFapiUrl("not a url", origin), false);
  });
});

describe("native Clerk FAPI relay allowlist", () => {
  test("allows production and development Clerk hosts", () => {
    assert.equal(isClerkFapiRelayUrl("https://clerk.cesium.techlitnow.com/v1/client"), true);
    assert.equal(isClerkFapiRelayUrl("https://foo-bar-12.clerk.accounts.dev/v1/client"), true);
  });

  test("blocks everything else", () => {
    assert.equal(isClerkFapiRelayUrl("https://example.com/v1/client"), false);
    assert.equal(isClerkFapiRelayUrl("http://clerk.cesium.techlitnow.com/v1/client"), false);
    assert.equal(isClerkFapiRelayUrl("https://notclerk.accounts.dev.evil.com/x"), false);
    assert.equal(isClerkFapiRelayUrl("file:///etc/passwd"), false);
    assert.equal(isClerkFapiRelayUrl(""), false);
  });
});

describe("oauth deep link params", () => {
  test("extracts ticket, ok, and kind without a URL parser", () => {
    assert.deepEqual(
      parseOAuthCompletedDeepLinkParams(
        "cesium://oauth/done?session=tick_abc&ok=1&kind=clerk"
      ),
      { sessionId: "tick_abc", ok: true, kind: "clerk" }
    );
    assert.deepEqual(
      parseOAuthCompletedDeepLinkParams("cesium://oauth/done?ticket=t2&ok=0&kind=mcp"),
      { sessionId: "t2", ok: false, kind: "mcp" }
    );
    assert.deepEqual(parseOAuthCompletedDeepLinkParams("cesium://oauth/done"), {
      sessionId: undefined,
      ok: true,
      kind: undefined,
    });
  });

  test("decodes percent-encoded tickets", () => {
    assert.equal(
      parseOAuthCompletedDeepLinkParams("cesium://oauth/done?session=a%2Bb&kind=clerk")
        .sessionId,
      "a+b"
    );
  });
});

describe("installClerkFapiTunnel", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalKeyEnv = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
    if (originalKeyEnv === undefined) {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalKeyEnv;
    }
  });

  type FakeWindow = EventTarget & {
    fetch: typeof fetch;
    ReactNativeWebView?: { postMessage: (raw: string) => void };
  };

  function makeFakeWindow(): {
    win: FakeWindow;
    posted: Array<Record<string, unknown>>;
    passthroughCalls: string[];
  } {
    const posted: Array<Record<string, unknown>> = [];
    const passthroughCalls: string[] = [];
    const win = new EventTarget() as FakeWindow;
    win.fetch = (async (input: RequestInfo | URL) => {
      passthroughCalls.push(String(input));
      return new Response("passthrough", { status: 200 });
    }) as typeof fetch;
    win.ReactNativeWebView = {
      postMessage: (raw: string) => {
        posted.push(JSON.parse(raw) as Record<string, unknown>);
      },
    };
    return { win, posted, passthroughCalls };
  }

  test("tunnels FAPI requests over the bridge and builds a Response", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
    const { win, posted } = makeFakeWindow();
    (globalThis as { window: unknown }).window = win;

    assert.equal(installClerkFapiTunnel(), true);

    const responsePromise = win.fetch(`https://${TEST_FAPI_HOST}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "strategy=ticket&ticket=tick_abc",
    });

    // The request must have been posted to the native shell, not the network.
    assert.equal(posted.length, 1);
    const request = posted[0] as {
      type: string;
      id: string;
      url: string;
      method: string;
      body: string;
    };
    assert.equal(request.type, "clerkFapiRequest");
    assert.equal(request.url, `https://${TEST_FAPI_HOST}/v1/client/sign_ins`);
    assert.equal(request.method, "POST");
    assert.equal(request.body, "strategy=ticket&ticket=tick_abc");

    win.dispatchEvent(
      new CustomEvent("cesium:mobile-bridge-message", {
        detail: {
          type: "clerkFapiResponse",
          id: request.id,
          ok: true,
          status: 200,
          headers: { "content-type": "application/json" },
          body: `{"response":{"id":"client_1"}}`,
        },
      })
    );

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { response: { id: "client_1" } });
  });

  test("passes non-FAPI requests through untouched", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
    const { win, posted, passthroughCalls } = makeFakeWindow();
    (globalThis as { window: unknown }).window = win;

    assert.equal(installClerkFapiTunnel(), true);
    const response = await win.fetch("https://api.other.example/v1/data");
    assert.equal(await response.text(), "passthrough");
    assert.deepEqual(passthroughCalls, ["https://api.other.example/v1/data"]);
    assert.equal(posted.length, 0);
  });

  test("rejects with a network-style error when the shell reports failure", async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
    const { win, posted } = makeFakeWindow();
    (globalThis as { window: unknown }).window = win;

    assert.equal(installClerkFapiTunnel(), true);
    const promise = win.fetch(`https://${TEST_FAPI_HOST}/v1/client`);
    const request = posted[0] as { id: string };
    win.dispatchEvent(
      new CustomEvent("cesium:mobile-bridge-message", {
        detail: {
          type: "clerkFapiResponse",
          id: request.id,
          ok: false,
          error: "boom",
        },
      })
    );
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match((error as Error).message, /boom/);
      return true;
    });
  });

  test("does not install outside the mobile WebView", () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
    const { win } = makeFakeWindow();
    delete win.ReactNativeWebView;
    (globalThis as { window: unknown }).window = win;
    assert.equal(installClerkFapiTunnel(), false);
  });
});
