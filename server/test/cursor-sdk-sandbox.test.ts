import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCursorSdkLocalOptions,
  cursorSdkSandboxOptions,
  resolveCursorSdkSandboxMode,
} from "../src/lib/agents/cursor-sdk-local-options.js";
import {
  cursorSdkRunFailureDetail,
  isCursorSdkSandboxRunFailure,
  isCursorSdkSandboxUnsupportedError,
} from "../src/lib/agents/cursor-sdk-sandbox-errors.js";
import {
  cursorSdkConfigOptionsFromModels,
  migrateCursorSdkSandboxConfigOptions,
} from "../src/lib/agents/provider-cache-store.js";
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

test("sdk_sandbox defaults to disabled on every platform", () => {
  const options = cursorSdkConfigOptionsFromModels([]);
  const sandbox = options.find((option) => option.id === "sdk_sandbox");
  assert.ok(sandbox, "fallback config options include sdk_sandbox");
  assert.equal(sandbox.currentValue, "disabled");
  assert.deepEqual(
    sandbox.options.map((row) => row.value),
    ["disabled", "enabled"]
  );
});

test("resolveCursorSdkSandboxMode maps option values", () => {
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("enabled")), "enabled");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("disabled")), "disabled");
});

test("resolveCursorSdkSandboxMode hardens legacy, missing, and unknown values", () => {
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("auto")), "disabled");
  assert.equal(resolveCursorSdkSandboxMode([]), "disabled");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("")), "disabled");
  assert.equal(resolveCursorSdkSandboxMode(sandboxOption("bogus")), "disabled");
});

test("cursorSdkSandboxOptions always passes an explicit SDK setting", () => {
  assert.deepEqual(cursorSdkSandboxOptions("enabled"), { enabled: true });
  assert.deepEqual(cursorSdkSandboxOptions("disabled"), { enabled: false });
});

test("buildCursorSdkLocalOptions hardens headless defaults", () => {
  const windowsRoot = "C:\\Users\\dev\\source\\repo";
  const local = buildCursorSdkLocalOptions({
    cwd: windowsRoot,
    settingSources: ["project", "user", "plugins"],
    sandboxMode: "disabled",
  });
  assert.deepEqual(local, {
    cwd: windowsRoot,
    settingSources: ["project", "user", "plugins"],
    sandboxOptions: { enabled: false },
    autoReview: false,
    enableAgentRetries: true,
  });
});

test("cached auto sandbox settings migrate to explicit disabled", () => {
  const migrated = migrateCursorSdkSandboxConfigOptions(sandboxOption("auto"));
  const sandbox = migrated.find((option) => option.id === "sdk_sandbox");
  assert.ok(sandbox);
  assert.equal(sandbox.currentValue, "disabled");
  assert.deepEqual(
    sandbox.options.map((option) => option.value),
    ["disabled", "enabled"]
  );
});

test("sandbox cache migration preserves explicit opt-in and adds missing option", () => {
  const enabled = migrateCursorSdkSandboxConfigOptions(sandboxOption("enabled"));
  assert.equal(enabled[0]?.currentValue, "enabled");

  const modelOnly: AgentConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "composer-2.5",
      options: [],
    },
  ];
  const withSandbox = migrateCursorSdkSandboxConfigOptions(modelOnly);
  assert.equal(
    withSandbox.find((option) => option.id === "sdk_sandbox")?.currentValue,
    "disabled"
  );
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

test("isCursorSdkSandboxRunFailure detects terminal sandbox errors from run.wait()", () => {
  assert.equal(
    isCursorSdkSandboxRunFailure({
      id: "run-1",
      status: "error",
      result: SDK_SANDBOX_UNSUPPORTED_MESSAGE,
    }),
    true
  );
  assert.equal(
    isCursorSdkSandboxRunFailure({
      id: "run-2",
      status: "error",
      error: { message: SDK_SANDBOX_UNSUPPORTED_MESSAGE },
    }),
    true
  );
  assert.equal(
    isCursorSdkSandboxRunFailure({
      id: "run-3",
      status: "finished",
    }),
    false
  );
  assert.equal(
    isCursorSdkSandboxRunFailure({
      id: "run-4",
      status: "error",
      result: "Provider responded 500",
    }),
    false
  );
});

test("cursorSdkRunFailureDetail preserves structured terminal errors", () => {
  const detail = cursorSdkRunFailureDetail({
    id: "run-5",
    status: "error",
    error: {
      message: SDK_SANDBOX_UNSUPPORTED_MESSAGE,
      code: "sandbox_unsupported",
    },
  });
  assert.match(detail ?? "", /sandboxing is not supported/i);
  assert.match(detail ?? "", /sandbox_unsupported/);
  assert.equal(
    cursorSdkRunFailureDetail({ id: "run-6", status: "finished" }),
    null
  );
});
