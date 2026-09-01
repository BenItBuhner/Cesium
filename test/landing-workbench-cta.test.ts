import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { shouldHardNavigateWorkbench } from "../src/components/landing/WorkbenchLink.tsx";
import { WORKSPACE_ROUTE } from "../src/lib/workbench-view.ts";

const landingPage = readFileSync(
  fileURLToPath(new URL("../src/components/landing/LandingPage.tsx", import.meta.url)),
  "utf8"
);
const landingAuth = readFileSync(
  fileURLToPath(new URL("../src/components/landing/LandingAuthActions.tsx", import.meta.url)),
  "utf8"
);
const downloadPage = readFileSync(
  fileURLToPath(new URL("../src/components/download/DownloadPage.tsx", import.meta.url)),
  "utf8"
);

describe("landing workbench CTAs", () => {
  test("workbench route is the agent shell", () => {
    assert.equal(WORKSPACE_ROUTE, "/agent");
  });

  test("signed-out landing leads with sign-up and sign-in, not a workbench launch", () => {
    assert.match(landingPage, /<LandingHeaderActions \/>/);
    assert.match(landingPage, /<LandingHeroActions \/>/);
    assert.match(landingPage, /<LandingClosingActions \/>/);
    assert.match(landingPage, /<LandingFooterActions \/>/);
    assert.doesNotMatch(landingPage, /Launch workbench/);
    assert.doesNotMatch(landingPage, /Launch the workbench/);
    assert.doesNotMatch(landingPage, /<WorkbenchLink\b/);
    assert.doesNotMatch(landingPage, /href=\{WORKSPACE_ROUTE\}/);
    assert.doesNotMatch(landingPage, /Download the app/);
    assert.doesNotMatch(landingPage, /Read the docs/);
    assert.doesNotMatch(landingPage, /npm run dev/);
    assert.doesNotMatch(landingPage, /Get started/);
    assert.doesNotMatch(landingPage, /Next\.js/);
    assert.doesNotMatch(landingPage, /Bun-powered/);
    assert.doesNotMatch(landingPage, /Local-first AI workbench/);
  });

  test("signed-out visitors only reach the workbench via Continue as guest", () => {
    assert.match(landingAuth, /href="\/sign-in"/);
    assert.match(landingAuth, /href="\/sign-up"/);
    assert.match(landingAuth, /Continue as guest/);
    assert.match(landingAuth, /<WorkbenchLink\b/);
    assert.doesNotMatch(landingAuth, /Launch workbench/);
    assert.doesNotMatch(landingAuth, /Launch the workbench/);
  });

  test("marketing footers expose terms, license, and source", () => {
    assert.match(landingPage, /<SiteLegalLinks \/>/);
    assert.match(downloadPage, /<SiteLegalLinks \/>/);
    assert.match(landingAuth, /TermsNotice/);
  });

  test("sign-in and sign-up land on account setup instead of the workbench", () => {
    const cloudContext = readFileSync(
      fileURLToPath(new URL("../src/contexts/CloudContext.tsx", import.meta.url)),
      "utf8"
    );
    const signIn = readFileSync(
      fileURLToPath(new URL("../src/app/sign-in/[[...sign-in]]/page.tsx", import.meta.url)),
      "utf8"
    );
    const signUp = readFileSync(
      fileURLToPath(new URL("../src/app/sign-up/[[...sign-up]]/page.tsx", import.meta.url)),
      "utf8"
    );
    assert.match(cloudContext, /signInFallbackRedirectUrl="\/setup\?resume=1"/);
    assert.match(cloudContext, /signUpFallbackRedirectUrl="\/setup\?resume=1"/);
    assert.match(signIn, /forceRedirectUrl="\/setup\?resume=1"/);
    assert.match(signUp, /<SignUpWithTerms \/>/);
    const signUpWithTerms = readFileSync(
      fileURLToPath(
        new URL("../src/components/auth/SignUpWithTerms.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(signUpWithTerms, /forceRedirectUrl=\{SIGN_UP_REDIRECT\}/);
    assert.match(signUpWithTerms, /buildTermsAcceptanceMetadata\(acceptedAt\)/);
  });

  test("download header also signs in instead of launching the workbench", () => {
    assert.match(downloadPage, /href="\/sign-in"/);
    assert.doesNotMatch(downloadPage, /Launch workbench/);
  });
});

describe("shouldHardNavigateWorkbench", () => {
  const primary = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
  };

  test("primary click hard-navigates to the workbench", () => {
    assert.equal(shouldHardNavigateWorkbench(primary), true);
  });

  test("modified or already-handled clicks keep the native href", () => {
    assert.equal(shouldHardNavigateWorkbench({ ...primary, defaultPrevented: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, button: 1 }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, metaKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, ctrlKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, shiftKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, altKey: true }), false);
  });
});
