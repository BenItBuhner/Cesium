import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clientKeyValueStore } from "../packages/client/src/index.ts";
import { CESIUM_CLOUD_DEFAULTS } from "../src/lib/cloud/cloud-defaults.ts";
import {
  dismissFirstRunAccount,
  FIRST_RUN_ACCOUNT_STORAGE_KEY,
  isFirstRunAccountDismissed,
  readFirstRunAccountState,
  shouldPromptFirstRunAccount,
  writeFirstRunAccountState,
} from "../src/lib/cloud/first-run-account.ts";
import {
  getClerkFallbackRedirectUrl,
  getClerkSignInUrl,
  getClerkSignUpUrl,
  getHostedClerkSignInUrl,
  getHostedClerkSignUpUrl,
  isClerkWidgetOrigin,
  isLoopbackOrEmulatorHostname,
  isPackagedClerkRuntime,
  shouldUseHostedClerkAuth,
} from "../src/lib/cloud/clerk-urls.ts";

describe("first-run account prompt", () => {
  afterEach(() => {
    clientKeyValueStore().removeItem(FIRST_RUN_ACCOUNT_STORAGE_KEY);
    delete process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL;
    delete process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL;
  });

  test("fresh install has no dismissal", () => {
    assert.deepEqual(readFirstRunAccountState(), {
      dismissedAt: null,
      choice: null,
    });
    assert.equal(isFirstRunAccountDismissed(), false);
  });

  test("guest dismissal is persisted", () => {
    dismissFirstRunAccount("guest");
    const state = readFirstRunAccountState();
    assert.equal(state.choice, "guest");
    assert.equal(typeof state.dismissedAt, "number");
    assert.equal(isFirstRunAccountDismissed(), true);
  });

  test("corrupt storage falls back to empty", () => {
    clientKeyValueStore().setItem(FIRST_RUN_ACCOUNT_STORAGE_KEY, "{not-json");
    assert.deepEqual(readFirstRunAccountState(), {
      dismissedAt: null,
      choice: null,
    });
  });

  test("write rejects unknown choice values on read", () => {
    writeFirstRunAccountState({
      dismissedAt: 1,
      choice: "nope" as never,
    });
    assert.deepEqual(readFirstRunAccountState(), {
      dismissedAt: 1,
      choice: null,
    });
  });

  test("prompts only for signed-out clerk mode on first run", () => {
    const base = {
      cloudMode: "clerk" as const,
      cloudStatus: "signed-out" as const,
      dismissed: false,
    };
    assert.equal(shouldPromptFirstRunAccount(base), true);
    assert.equal(
      shouldPromptFirstRunAccount({ ...base, cloudStatus: "loading" }),
      false
    );
    assert.equal(
      shouldPromptFirstRunAccount({ ...base, cloudStatus: "ready" }),
      false
    );
    assert.equal(
      shouldPromptFirstRunAccount({ ...base, dismissed: true }),
      false
    );
    assert.equal(
      shouldPromptFirstRunAccount({ ...base, cloudMode: "device" }),
      false
    );
    assert.equal(
      shouldPromptFirstRunAccount({ ...base, cloudMode: "disabled" }),
      false
    );
  });

  test("committed defaults are the production Clerk + Convex pair", () => {
    assert.match(CESIUM_CLOUD_DEFAULTS.convexUrl, /^https:\/\/.+\.convex\.cloud$/);
    assert.match(CESIUM_CLOUD_DEFAULTS.clerkPublishableKey, /^pk_live_/);
  });

  test("clerk auth page URLs stay path-relative on http(s)", () => {
    assert.equal(getClerkSignInUrl(), "/sign-in");
    assert.equal(getClerkSignUpUrl(), "/sign-up");
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "https://accounts.example/sign-in";
    assert.equal(getClerkSignInUrl(), "https://accounts.example/sign-in");
  });

  test("hosted clerk pages are always absolute production URLs", () => {
    assert.equal(
      getHostedClerkSignInUrl(),
      "https://cesium.techlitnow.com/sign-in?native_handoff=1&redirect_url=https%3A%2F%2Fcesium.techlitnow.com%2Fauth%2Fnative-return"
    );
    assert.equal(
      getHostedClerkSignUpUrl(),
      "https://cesium.techlitnow.com/sign-up?native_handoff=1&redirect_url=https%3A%2F%2Fcesium.techlitnow.com%2Fauth%2Fnative-return"
    );
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "/sign-in";
    assert.equal(
      getHostedClerkSignInUrl(),
      "https://cesium.techlitnow.com/sign-in?native_handoff=1&redirect_url=https%3A%2F%2Fcesium.techlitnow.com%2Fauth%2Fnative-return"
    );
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL = "https://accounts.example/sign-in";
    assert.equal(
      getHostedClerkSignInUrl(),
      "https://accounts.example/sign-in?native_handoff=1&redirect_url=https%3A%2F%2Fcesium.techlitnow.com%2Fauth%2Fnative-return"
    );
  });

  test("hosted clerk auth is required on file://, localhost, and while Clerk is loading", () => {
    const prod = { protocol: "https:", hostname: "cesium.techlitnow.com" };
    assert.equal(shouldUseHostedClerkAuth(prod, "signed-out"), false);
    assert.equal(shouldUseHostedClerkAuth(prod, "loading"), true);
    assert.equal(
      shouldUseHostedClerkAuth({ protocol: "file:", hostname: "" }, "signed-out"),
      true
    );
    assert.equal(
      shouldUseHostedClerkAuth({ protocol: "http:", hostname: "localhost" }, "signed-out"),
      true
    );
    assert.equal(shouldUseHostedClerkAuth(null, "signed-out"), true);
  });

  test("hosted clerk auth is required on emulator, packaged shells, and any non-account origin", () => {
    const prod = { protocol: "https:", hostname: "cesium.techlitnow.com" };
    assert.equal(isClerkWidgetOrigin(prod), true);
    assert.equal(
      isClerkWidgetOrigin({ protocol: "http:", hostname: "10.0.2.2" }),
      false
    );
    assert.equal(isLoopbackOrEmulatorHostname("10.0.2.2"), true);
    assert.equal(isLoopbackOrEmulatorHostname("10.0.3.2"), true);
    assert.equal(
      shouldUseHostedClerkAuth(
        { protocol: "http:", hostname: "10.0.2.2" },
        "signed-out"
      ),
      true
    );
    assert.equal(
      shouldUseHostedClerkAuth(
        { protocol: "https:", hostname: "appassets.androidplatform.net" },
        "signed-out"
      ),
      true
    );
    assert.equal(shouldUseHostedClerkAuth(prod, "signed-out", { packaged: true }), true);
    assert.equal(
      isPackagedClerkRuntime({
        ReactNativeWebView: {},
        location: { protocol: "https:" },
      }),
      true
    );
    assert.equal(
      isPackagedClerkRuntime({
        cesiumDesktop: { isElectron: true },
        location: { protocol: "https:" },
      }),
      true
    );
    assert.equal(
      getClerkFallbackRedirectUrl(
        { protocol: "http:", hostname: "10.0.2.2" },
        { packaged: true }
      ),
      "https://cesium.techlitnow.com/setup?resume=1"
    );
    assert.equal(getClerkFallbackRedirectUrl(prod, { packaged: false }), "/setup?resume=1");
  });

  test("workbench providers mount the first-run account gate", () => {
    const providers = readFileSync(
      fileURLToPath(
        new URL("../src/components/layout/WorkbenchRouteProviders.tsx", import.meta.url)
      ),
      "utf8"
    );
    const gate = readFileSync(
      fileURLToPath(
        new URL("../src/components/auth/FirstRunAccountGate.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(providers, /FirstRunAccountGate/);
    assert.match(providers, /<FirstRunAccountGate>/);
    assert.match(gate, /ClerkAuthTrigger/);
    assert.match(gate, /mode="sign-up"/);
    assert.match(gate, /mode="sign-in"/);
    assert.match(gate, /Continue as guest/);
    assert.match(gate, /aria-label="Continue as guest"/);
    assert.match(gate, /TermsNotice/);
    const trigger = readFileSync(
      fileURLToPath(
        new URL("../src/components/auth/ClerkAuthTrigger.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(trigger, /isPackagedClerkRuntime/);
    assert.match(trigger, /openHostedClerkAuth/);
    assert.match(trigger, /buildTermsAcceptanceMetadata/);
  });

  test("desktop demo driver dismisses the first-run gate as guest", () => {
    const driver = readFileSync(
      fileURLToPath(
        new URL("../scripts/desktop-demo-driver.mjs", import.meta.url)
      ),
      "utf8"
    );
    assert.match(driver, /Continue as guest/);
    assert.match(driver, /first-run account gate/);
  });
});
