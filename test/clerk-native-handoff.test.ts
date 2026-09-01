import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  activateClerkSessionFromTicket,
  buildAndroidClerkHandoffIntent,
  buildClerkHandoffDeepLink,
  clerkAuthRedirectPath,
  ensureNativeClerkHandoffOnAuthUrl,
  isNativeClerkHandoffSearch,
  NATIVE_CLERK_HANDOFF_PATH,
  readClerkHandoffTicket,
  WEB_CLERK_REDIRECT_PATH,
  withNativeClerkHandoffQuery,
} from "../src/lib/cloud/clerk-native-handoff.ts";
import { requestClerkSignInToken } from "../src/lib/cloud/create-clerk-sign-in-token.ts";
import { parseOAuthCompletedDeepLink } from "../src/lib/oauth-deep-link.ts";
import { handleDesktopDeepLink } from "../src/components/desktop/DesktopNativeSync.tsx";

describe("native Clerk handoff", () => {
  test("web sign-in stays on setup; native handoff goes to the ticket page", () => {
    assert.equal(WEB_CLERK_REDIRECT_PATH, "/setup?resume=1");
    assert.equal(clerkAuthRedirectPath(null), "/setup?resume=1");
    assert.equal(clerkAuthRedirectPath({}), "/setup?resume=1");
    assert.equal(
      clerkAuthRedirectPath({ native_handoff: "1" }),
      NATIVE_CLERK_HANDOFF_PATH
    );
    assert.equal(
      clerkAuthRedirectPath(new URLSearchParams("native_handoff=1")),
      NATIVE_CLERK_HANDOFF_PATH
    );
    assert.equal(isNativeClerkHandoffSearch({ native_handoff: "true" }), true);
  });

  test("hosted auth URLs stamp the return ticket query", () => {
    const url = withNativeClerkHandoffQuery("https://cesium.techlitnow.com/sign-in");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("native_handoff"), "1");
    assert.equal(
      parsed.searchParams.get("redirect_url"),
      "https://cesium.techlitnow.com/auth/native-return"
    );
    assert.equal(
      ensureNativeClerkHandoffOnAuthUrl("https://cesium.techlitnow.com/sign-up"),
      withNativeClerkHandoffQuery("https://cesium.techlitnow.com/sign-up")
    );
    assert.equal(
      ensureNativeClerkHandoffOnAuthUrl("https://auth.openai.com/oauth/authorize"),
      "https://auth.openai.com/oauth/authorize"
    );
  });

  test("deep link carries the Clerk ticket", () => {
    const link = buildClerkHandoffDeepLink("tick_abc");
    assert.equal(link, "cesium://oauth/done?session=tick_abc&ok=1&kind=clerk");
    assert.match(
      buildAndroidClerkHandoffIntent("tick_abc"),
      /intent:\/\/oauth\/done\?session=tick_abc&ok=1&kind=clerk/
    );
    const parsed = parseOAuthCompletedDeepLink(link);
    assert.deepEqual(parsed, {
      sessionId: "tick_abc",
      ok: true,
      kind: "clerk",
    });
    assert.equal(
      parseOAuthCompletedDeepLink("cesium://oauth/done?ticket=other&ok=1&kind=clerk")
        ?.sessionId,
      "other"
    );
    assert.equal(parseOAuthCompletedDeepLink("https://example.com/oauth"), null);
  });

  test("ticket reader ignores other OAuth kinds", () => {
    assert.equal(
      readClerkHandoffTicket({
        sessionId: "tick_abc",
        kind: "clerk",
        ok: true,
      }),
      "tick_abc"
    );
    assert.equal(
      readClerkHandoffTicket({
        sessionId: "sess-1",
        kind: "mcp",
        ok: true,
      }),
      null
    );
    assert.equal(
      readClerkHandoffTicket({
        ticket: "tick_abc",
        kind: "clerk",
        ok: false,
      }),
      null
    );
    assert.equal(
      readClerkHandoffTicket({
        sessionId: "tick_abc",
        ok: true,
      }),
      null
    );
  });

  test("ticket activation finalizes the Clerk future sign-in", async () => {
    const calls: string[] = [];
    const signIn = {
      createdSessionId: null as string | null,
      async ticket(params: { ticket: string }) {
        assert.equal(params.ticket, "tick_abc");
        signIn.createdSessionId = "sess_123";
        return { error: null };
      },
      async finalize() {
        calls.push(signIn.createdSessionId ?? "");
        return { error: null };
      },
    };
    const sessionId = await activateClerkSessionFromTicket({ signIn }, "tick_abc");
    assert.equal(sessionId, "sess_123");
    assert.deepEqual(calls, ["sess_123"]);
  });

  test("sign-in token request posts user_id to Clerk", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      assert.equal(String(url), "https://api.clerk.com/v1/sign_in_tokens");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk_test");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        user_id?: string;
        expires_in_seconds?: number;
      };
      assert.equal(body.user_id, "user_123");
      assert.equal(body.expires_in_seconds, 300);
      return new Response(JSON.stringify({ token: "tick_live" }), { status: 200 });
    };
    const token = await requestClerkSignInToken({
      userId: "user_123",
      secretKey: "sk_test",
      fetchImpl,
    });
    assert.equal(token, "tick_live");
  });

  test("desktop deep links dispatch oauthCompleted for Clerk tickets", () => {
    const posted: unknown[] = [];
    const original = globalThis.window;
    (globalThis as { window: Window }).window = {
      dispatchEvent(event: Event) {
        posted.push((event as CustomEvent).detail);
        return true;
      },
    } as Window;
    try {
      handleDesktopDeepLink("cesium://oauth/done?session=tick_abc&ok=1&kind=clerk");
      assert.deepEqual(posted, [
        {
          type: "oauthCompleted",
          sessionId: "tick_abc",
          ok: true,
          kind: "clerk",
        },
      ]);
    } finally {
      if (original) {
        (globalThis as { window: Window }).window = original;
      } else {
        // @ts-expect-error restore missing window in node
        delete globalThis.window;
      }
    }
  });

  test("native return page and first-run gate are wired", () => {
    const nativeReturn = readFileSync(
      fileURLToPath(
        new URL("../src/app/auth/native-return/page.tsx", import.meta.url)
      ),
      "utf8"
    );
    const gate = readFileSync(
      fileURLToPath(
        new URL("../src/components/auth/FirstRunAccountGate.tsx", import.meta.url)
      ),
      "utf8"
    );
    const cloud = readFileSync(
      fileURLToPath(new URL("../src/contexts/CloudContext.tsx", import.meta.url)),
      "utf8"
    );
    const proxy = readFileSync(
      fileURLToPath(new URL("../src/proxy.ts", import.meta.url)),
      "utf8"
    );
    assert.match(nativeReturn, /createClerkNativeHandoffTicket/);
    assert.match(gate, /ClerkAuthTrigger/);
    const handoff = readFileSync(
      fileURLToPath(
        new URL("../src/components/auth/ClerkNativeHandoff.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(cloud, /ClerkNativeHandoff/);
    assert.match(cloud, /getClerkFallbackRedirectUrl/);
    assert.match(proxy, /\/auth\/native-return/);
    assert.match(handoff, /useSignIn\(\)/);
    assert.doesNotMatch(handoff, /isLoaded/);
    assert.doesNotMatch(handoff, /setActive/);
  });
});
