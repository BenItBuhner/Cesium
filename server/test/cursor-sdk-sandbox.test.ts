import assert from "node:assert/strict";
import test from "node:test";
import type { AgentOptions, SDKAgent } from "@cursor/sdk";
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
import {
  createCursorSdkProvider,
  type CursorSdkProviderDependencies,
} from "../src/lib/agents/cursor-sdk-provider.js";
import { buildCursorSdkCloudOptions } from "../src/lib/agents/cursor-sdk-cloud-options.js";
import { AGENT_CAPABILITIES } from "../src/lib/agents/agent-contract.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentRuntimeCallbacks,
  AgentStoredEvent,
} from "../src/lib/agents/types.js";
import type { AgentPluginAttachmentSnapshot } from "../src/lib/plugins/attachments.js";

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

test("live sandbox and setting-source changes rebind the local SDK agent", async () => {
  const createdOptions: AgentOptions[] = [];
  const resumedOptions: Array<Partial<AgentOptions> | undefined> = [];
  const disposedHandles: string[] = [];
  let resumeCount = 0;

  const fakeAgent = (agentId: string, handleName: string): SDKAgent =>
    ({
      agentId,
      async [Symbol.asyncDispose]() {
        disposedHandles.push(handleName);
      },
    }) as unknown as SDKAgent;

  const dependencies: CursorSdkProviderDependencies = {
    agent: {
      async create(options) {
        createdOptions.push(options);
        return fakeAgent("agent-cursor-sdk-test", "created");
      },
      async resume(agentId, options) {
        resumedOptions.push(options);
        resumeCount += 1;
        return fakeAgent(agentId, `resumed-${resumeCount}`);
      },
    },
    async getApiKey() {
      return "test-key";
    },
    async resolvePluginAttachments(input) {
      return {
        ...input,
        plugins: [],
        skillsList: "",
        promptSection: "",
        mcpSummaries: [],
        mcpServers: [],
        sdkMcp: { servers: {}, skipped: [] },
        warnings: [],
        toolDisplays: [],
      } satisfies AgentPluginAttachmentSnapshot;
    },
    buildCloudOptions: buildCursorSdkCloudOptions,
  };

  const configOptions = cursorSdkConfigOptionsFromModels([]);
  const backend: AgentBackendInfo = {
    id: "cursor-sdk",
    label: "Cursor SDK",
    description: "test",
    available: true,
    defaultMode: "agent",
    defaultModelId: "composer-2.5",
    defaultModelName: "Composer 2.5",
    capabilities: AGENT_CAPABILITIES["cursor-sdk"],
  };
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "conversation-cursor-sdk-test",
    workspaceId: "workspace-cursor-sdk-test",
    title: "Cursor SDK lifecycle test",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cursor-sdk",
      mode: "agent",
      modelId: "composer-2.5",
      modelName: "Composer 2.5",
    },
    providerSessionId: null,
    configOptions,
    capabilities: AGENT_CAPABILITIES["cursor-sdk"],
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: true,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const callbacks: AgentRuntimeCallbacks = {
    workspace: {
      id: conversation.workspaceId,
      root: "C:\\Users\\dev\\source\\repo",
      name: "Windows workspace",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
    conversation,
    async appendEvents(events) {
      return events.map(
        (event, index) =>
          ({
            ...event,
            seq: index + 1,
            createdAt: event.createdAt ?? 1,
          }) as AgentStoredEvent
      );
    },
    async readSnapshot() {
      return null;
    },
    async updateConversation(patch) {
      conversation =
        typeof patch === "function"
          ? patch(conversation)
          : { ...conversation, ...patch };
      return conversation;
    },
  };

  const provider = createCursorSdkProvider({
    backend,
    configOptions,
    dependencies,
  });
  const handle = await provider.startSession(callbacks);

  assert.equal(createdOptions.length, 1);
  assert.equal(createdOptions[0]?.local?.cwd, callbacks.workspace.root);
  assert.deepEqual(createdOptions[0]?.local?.sandboxOptions, {
    enabled: false,
  });
  assert.equal(createdOptions[0]?.local?.autoReview, false);

  await handle.setConfigOption("sdk_sandbox", "enabled");
  assert.equal(resumedOptions.length, 1);
  assert.deepEqual(resumedOptions[0]?.local?.sandboxOptions, {
    enabled: true,
  });
  assert.deepEqual(disposedHandles, ["created"]);

  await handle.setConfigOption("setting_sources", "all");
  assert.equal(resumedOptions.length, 2);
  assert.deepEqual(resumedOptions[1]?.local?.settingSources, ["all"]);
  assert.deepEqual(disposedHandles, ["created", "resumed-1"]);

  await handle.dispose();
  assert.deepEqual(disposedHandles, [
    "created",
    "resumed-1",
    "resumed-2",
  ]);
});
