import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_USER_PREFERENCES,
  mergeLegacyUserPreferences,
  parseUserPreferences,
  serializeUserPreferences,
} from "../src/lib/preferences.ts";

describe("user preferences", () => {
  test("defaults iPad resume cache off", () => {
    assert.equal(DEFAULT_USER_PREFERENCES.experimentalIpadResumeCache, false);
    assert.equal(parseUserPreferences(null).experimentalIpadResumeCache, false);
    assert.equal(DEFAULT_USER_PREFERENCES.vscodeExtensionsBeta, false);
    assert.equal(parseUserPreferences(null).vscodeExtensionsBeta, false);
  });

  test("parses and serializes iPad resume cache flag", () => {
    const parsed = parseUserPreferences(
      JSON.stringify({
        experimentalIpadMode: true,
        experimentalIpadResumeCache: true,
        vscodeExtensionsBeta: true,
      })
    );

    assert.equal(parsed.experimentalIpadMode, true);
    assert.equal(parsed.experimentalIpadResumeCache, true);
    assert.equal(parsed.vscodeExtensionsBeta, true);
    assert.equal(
      JSON.parse(serializeUserPreferences(parsed)).experimentalIpadResumeCache,
      true
    );
    assert.equal(
      JSON.parse(serializeUserPreferences(parsed)).vscodeExtensionsBeta,
      true
    );
  });

  test("Projects defaults on, can be turned off, and survives the boot cache round trip", () => {
    assert.equal(DEFAULT_USER_PREFERENCES.projects, true);
    assert.equal(parseUserPreferences("{}").projects, true);
    const parsed = parseUserPreferences(JSON.stringify({ projects: false }));
    assert.equal(parsed.projects, false);
    assert.equal(JSON.parse(serializeUserPreferences(parsed)).projects, false);
  });

  test("a legacy per-device document never overrides the account's Projects choice", () => {
    const account = { ...DEFAULT_USER_PREFERENCES, projects: false };
    const legacy = parseUserPreferences(JSON.stringify({ vscodeExtensionsBeta: true }));
    const merged = mergeLegacyUserPreferences(account, legacy);
    assert.equal(merged.projects, false);
    assert.equal(merged.vscodeExtensionsBeta, true);
  });
});
