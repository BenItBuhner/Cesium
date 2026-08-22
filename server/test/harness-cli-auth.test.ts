import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isHarnessCliAuthBackendId,
  parseHarnessDeviceAuthOutput,
} from "../src/lib/harness-cli-auth.js";

test("isHarnessCliAuthBackendId covers CLI-login harnesses including Cursor ACP", () => {
  assert.equal(isHarnessCliAuthBackendId("cursor-acp"), true);
  assert.equal(isHarnessCliAuthBackendId("codex-acp"), true);
  assert.equal(isHarnessCliAuthBackendId("codex-app-server"), true);
  assert.equal(isHarnessCliAuthBackendId("grok-build"), true);
  assert.equal(isHarnessCliAuthBackendId("cursor-sdk"), false);
  assert.equal(isHarnessCliAuthBackendId("cesium-agent"), false);
});

test("parseHarnessDeviceAuthOutput extracts labeled verification URL and code", () => {
  const parsed = parseHarnessDeviceAuthOutput(
    "Visit https://auth.example.com/device\nEnter code: ABCD-EFGH\n"
  );
  assert.equal(parsed.verificationUrl, "https://auth.example.com/device");
  assert.equal(parsed.userCode, "ABCD-EFGH");
});
