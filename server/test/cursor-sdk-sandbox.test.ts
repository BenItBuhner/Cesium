import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorSdkSandboxOptions,
  isCursorSdkSandboxUnsupportedError,
  resolveCursorSdkSandboxMode,
} from "../src/lib/agents/cursor-sdk-provider.js";
import { cursorSdkConfigOptionsFromModels } from "../src/lib/agents/provider-cache-store.js";
import type { AgentConfigOption } from "../src/lib/agents/types.js";

const SDK_SANDBOX_UNSUPPORTED_MESSAGE =
  "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. " +
  "Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.";

function sandboxOption(currentValue: string): AgentConfigOption[] {
  return [
    {
      id: "sdk_sandbox",
      name: "Local Sandbox",
      category: "permission",
      currentValue,
      options: [],
    },
  ];
}

test("sdk_sandbox defaults to auto on every platform", () => {
  const options = cursorSdkConfigOptionsFromModels([]);
  const sandbox = options.find((option) => option.id === "sdk_sandbox");
  assert.ok(sandbox, "fallback config options include sdk_sandbox");
  assert.equal(sandbox.currentValue, "auto");
  assert.deepEqual(
    sandbox.options.map((row) => row.value),
    ["auto", "enabled", "disabled"]
  );
});

test("resolveCursorSdkSandboxMode maps option values", () => {
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("auto")), "auto");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("enabled")), "enabled");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("disabled")), "disabled");
});

test("resolveCursorSdkSandboxMode treats missing or unknown values as auto", () => {
  assert.equal(resolveCursorSdkSandboxMode([]), "auto");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("")), "auto");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("bogus")), "auto");
});

test("cursorSdkSandboxOptions only forces a value for explicit modes", () => {
  assert.deepEqual(cursorSdkSandboxOptions("enabled"), { enabled: true });
  assert.deepEqual(cursorSdkSandboxOptions("disabled"), { enabled: false });
  assert.equal(cursorSdkSandboxOptions("auto"), undefined);
});

test("isCursorSdkSandboxUnsupportedError matches the SDK error message", () => {
  assert.equal(
    isCursorSdkSandboxUnsupportedError(new Error(SDK_SANDBOX_UNSUPPORTED_MESSAGE)),
    true
  );
  assert.equal(isCursorSdkSandboxUnsupportedError(SDK_SANDBOX_UNSUPPORTED_MESSAGE), true);
});

test("isCursorSdkSandboxUnsupportedError walks the cause chain", () => {
  const wrapped = new Error("Cursor SDK agent error: run failed", {
    cause: new Error(SDK_SANDBOX_UNSUPPORTED_MESSAGE),
  });
  assert.equal(isCursorSdkSandboxUnsupportedError(wrapped), true);
});

test("isCursorSdkSandboxUnsupportedError ignores unrelated errors", () => {
  assert.equal(isCursorSdkSandboxUnsupportedError(new Error("Provider responded 500")), false);
  assert.equal(isCursorSdkSandboxUnsupportedError(null), false);
  assert.equal(isCursorSdkSandboxUnsupportedError(undefined), false);
  assert.equal(isCursorSdkSandboxUnsupportedError({ message: 42 }), false);
});
