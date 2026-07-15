import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("devin acp backend is registered in the harness menu", async () => {
  const [{ AGENT_BACKENDS, listAgentBackends }, { AGENT_CAPABILITIES }] = await Promise.all([
    import("../src/lib/agents/providers.js"),
    import("../src/lib/agents/agent-contract.js"),
  ]);

  const backends = listAgentBackends();
  const index = backends.findIndex((backend) => backend.id === "devin-acp");
  assert.ok(index >= 0, "devin-acp should appear in listAgentBackends()");
  assert.equal(AGENT_BACKENDS["devin-acp"].label, "Devin");
  assert.equal(AGENT_BACKENDS["devin-acp"].capabilities.supportsLoadSession, true);
  assert.equal(AGENT_BACKENDS["devin-acp"].capabilities.supportsPermissions, true);
  assert.equal(AGENT_CAPABILITIES["devin-acp"].supportsToolCalls, true);
  assert.match(AGENT_BACKENDS["devin-acp"].description, /devin acp/i);
});

test("devin acp resolves OPENCURSOR_DEVIN_CLI_BIN and marks backend available", async () => {
  const tmp = path.join(os.tmpdir(), `devin-acp-test-${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const fakeBin = path.join(tmp, "devin");
  writeFileSync(fakeBin, "#!/bin/sh\necho fake-devin\n");
  chmodSync(fakeBin, 0o755);

  const previousBin = process.env.OPENCURSOR_DEVIN_CLI_BIN;
  const previousArgs = process.env.OPENCURSOR_DEVIN_CLI_ARGS;
  process.env.OPENCURSOR_DEVIN_CLI_BIN = fakeBin;
  delete process.env.OPENCURSOR_DEVIN_CLI_ARGS;

  try {
    // providers.ts resolves CLI paths at module load — isolate via a fresh import
    // by busting the cache with a query (Bun/Node ESM cache key is the URL).
    const cacheBust = `?devin-bin=${Date.now()}`;
    const { AGENT_BACKENDS, createAgentProvider } = await import(
      `../src/lib/agents/providers.js${cacheBust}`
    );

    assert.equal(AGENT_BACKENDS["devin-acp"].available, true);
    assert.match(AGENT_BACKENDS["devin-acp"].commandPreview ?? "", /acp/);

    const provider = await createAgentProvider("devin-acp");
    assert.equal(provider.backend.id, "devin-acp");
    assert.equal(typeof provider.startSession, "function");
    assert.equal(typeof provider.loadSession, "function");
  } finally {
    if (previousBin === undefined) {
      delete process.env.OPENCURSOR_DEVIN_CLI_BIN;
    } else {
      process.env.OPENCURSOR_DEVIN_CLI_BIN = previousBin;
    }
    if (previousArgs === undefined) {
      delete process.env.OPENCURSOR_DEVIN_CLI_ARGS;
    } else {
      process.env.OPENCURSOR_DEVIN_CLI_ARGS = previousArgs;
    }
  }
});

test("devin acp seed config options include mode and model families", async () => {
  const { forceRefreshAllBackendCaches, readAgentBackendConfigCache } = await import(
    "../src/lib/agents/provider-cache-store.js"
  );
  await forceRefreshAllBackendCaches(["devin-acp"]);
  const options = await readAgentBackendConfigCache("devin-acp");
  assert.ok(options);
  const mode = options!.find((option) => option.category === "mode");
  const model = options!.find((option) => option.category === "model");
  assert.ok(mode);
  assert.ok(model);
  assert.ok(mode!.options.some((entry) => entry.value === "agent"));
  assert.ok(mode!.options.some((entry) => entry.value === "plan"));
  assert.ok(model!.options.some((entry) => entry.value === "swe"));
  assert.ok(model!.options.some((entry) => entry.value === "opus"));
});
