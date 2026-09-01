import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGPL_CANONICAL_URL,
  AGPL_NAME,
  AGPL_SPDX,
  CESIUM_LICENSE_BLOB_URL,
  CESIUM_SOURCE_URL,
  LICENSE_PATH,
  TERMS_PATH,
  TERMS_SECTIONS,
  TERMS_VERSION,
  buildTermsAcceptanceMetadata,
  getHostedLegalUrl,
  getLegalPageUrl,
  getTermsPlainText,
  getTermsSectionIds,
} from "../src/lib/legal/terms.ts";
import { CESIUM_GITHUB_REPO } from "../src/lib/releases.ts";
import { DEFAULT_PRODUCTION_SITE_URL } from "../src/lib/site-url.ts";

const requiredSectionIds = [
  "agreement",
  "who",
  "license",
  "service",
  "eligibility",
  "accounts",
  "responsibilities",
  "secrets",
  "agents",
  "workspaces",
  "storage",
  "sync",
  "github-codespaces",
  "clients",
  "engines",
  "third-parties",
  "acceptable-use",
  "content",
  "privacy",
  "warranty",
  "liability",
  "indemnity",
  "changes",
  "termination",
  "export",
  "consumer",
  "law",
  "misc",
  "contact",
];

const requiredPhrases = [
  "you are solely responsible",
  "API keys",
  "obfuscation",
  "You are the principal for every agent run",
  "conversation snapshots",
  "Codespace",
  "browser-only",
  "rendezvous",
  "Clerk",
  "Convex",
  "Postgres",
  "AGPL-3.0 section 13",
  "checking the Terms periodically",
  "mandatory rights",
  "device key",
];

describe("terms of service content", () => {
  test("posts a dated version and the full section set", () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(getTermsSectionIds(), requiredSectionIds);
    assert.equal(TERMS_SECTIONS.length, requiredSectionIds.length);
  });

  test("cites AGPL-3.0 and the public source repository", () => {
    assert.equal(AGPL_SPDX, "AGPL-3.0");
    assert.match(AGPL_NAME, /Affero General Public License/);
    assert.equal(CESIUM_SOURCE_URL, `https://github.com/${CESIUM_GITHUB_REPO}`);
    assert.equal(
      CESIUM_LICENSE_BLOB_URL,
      `https://github.com/${CESIUM_GITHUB_REPO}/blob/main/LICENSE`
    );
    assert.equal(AGPL_CANONICAL_URL, "https://www.gnu.org/licenses/agpl-3.0.html");
    const text = getTermsPlainText();
    assert.match(text, /AGPL-3\.0/);
    assert.match(text, new RegExp(CESIUM_GITHUB_REPO));
  });

  test("covers secrets, agents, sync, codespaces, and consumer carve-outs", () => {
    const text = getTermsPlainText();
    for (const phrase of requiredPhrases) {
      assert.match(
        text,
        new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      );
    }
  });

  test("records clickwrap metadata with the posted version", () => {
    const acceptedAt = "2026-09-01T12:00:00.000Z";
    assert.deepEqual(buildTermsAcceptanceMetadata(acceptedAt), {
      termsAccepted: true,
      legalAccepted: true,
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: acceptedAt,
    });
  });

  test("legal URLs stay path-relative on http(s) and hosted on file://", () => {
    assert.equal(getLegalPageUrl(TERMS_PATH, { protocol: "https:" }), "/terms");
    assert.equal(getLegalPageUrl(LICENSE_PATH, { protocol: "http:" }), "/license");
    assert.equal(
      getLegalPageUrl(TERMS_PATH, { protocol: "file:" }),
      `${DEFAULT_PRODUCTION_SITE_URL}/terms`
    );
    assert.equal(getHostedLegalUrl(TERMS_PATH), `${DEFAULT_PRODUCTION_SITE_URL}/terms`);
  });
});

describe("terms wiring", () => {
  test("sign-up puts express Terms consent between the fields and Continue", () => {
    const signUp = readFileSync(
      fileURLToPath(new URL("../src/components/auth/SignUpWithTerms.tsx", import.meta.url)),
      "utf8"
    );
    assert.match(signUp, /TermsAgreementCheckbox/);
    assert.match(signUp, /unsafeMetadata=\{/);
    assert.match(signUp, /buildTermsAcceptanceMetadata/);
    assert.match(signUp, /embedInHostCard: true/);
    assert.match(signUp, /primaryActionDisabled: !agreed/);
    assert.match(signUp, /ClerkSignUpFrame/);
    assert.match(signUp, /useInjectBeforeClerkPrimary/);
    assert.doesNotMatch(signUp, /Check the box above to continue to sign-up/);
    assert.doesNotMatch(signUp, /clerkHostLegalRowClass/);
  });

  test("public routes, sitemap, and robots keep terms reachable", () => {
    const proxy = readFileSync(
      fileURLToPath(new URL("../src/proxy.ts", import.meta.url)),
      "utf8"
    );
    const sitemap = readFileSync(
      fileURLToPath(new URL("../src/app/sitemap.ts", import.meta.url)),
      "utf8"
    );
    const robots = readFileSync(
      fileURLToPath(new URL("../src/app/robots.ts", import.meta.url)),
      "utf8"
    );
    assert.match(proxy, /"\/terms\(\.\*\)"/);
    assert.match(proxy, /"\/license\(\.\*\)"/);
    assert.match(sitemap, /\/terms/);
    assert.match(sitemap, /\/license/);
    assert.match(robots, /\/terms/);
    assert.match(robots, /\/license/);
  });

  test("Clerk appearance points at the terms page", () => {
    const cloud = readFileSync(
      fileURLToPath(new URL("../src/contexts/CloudContext.tsx", import.meta.url)),
      "utf8"
    );
    const appearance = readFileSync(
      fileURLToPath(new URL("../src/lib/cloud/clerk-appearance.ts", import.meta.url)),
      "utf8"
    );
    assert.match(cloud, /appearance=\{getClerkAppearance\(\)\}/);
    assert.match(appearance, /termsPageUrl: TERMS_PATH/);
    assert.match(appearance, /privacyPageUrl: `\$\{TERMS_PATH\}#privacy`/);
    assert.match(appearance, /primaryActionDisabled/);
    assert.match(appearance, /layout: legalUrls/);
  });

  test("license page embeds the repository LICENSE file", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../src/app/license/page.tsx", import.meta.url)),
      "utf8"
    );
    assert.match(page, /readFileSync\(join\(process\.cwd\(\), "LICENSE"\)/);
    assert.match(page, /CESIUM_SOURCE_URL/);
    assert.match(page, /AGPL_CANONICAL_URL/);
  });

  test("account settings expose terms and license", () => {
    const panel = readFileSync(
      fileURLToPath(
        new URL("../src/components/editor/settings/AccountSettingsPanel.tsx", import.meta.url)
      ),
      "utf8"
    );
    assert.match(panel, /LegalLinksSection/);
    assert.match(panel, /searchId="account-terms"/);
    assert.match(panel, /searchId="account-license"/);
  });
});
