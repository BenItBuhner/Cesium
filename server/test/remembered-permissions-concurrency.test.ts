import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-remembered-permissions-concurrency-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [{ settingsRoutes }, store, helpers] = await Promise.all([
  import("../src/routes/settings.js"),
  import("../src/lib/global-settings-store.js"),
  import("../src/lib/agents/remembered-permissions.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("concurrent remembered permission saves do not lose updates", async () => {
  await store.clearRememberedAgentPermissionRules();
  const COUNT = 120;
  const backends = [
    "cesium-agent",
    "claude-code-sdk",
    "cursor-sdk",
    "opencode-server",
    "opencode-v2-beta",
    "codex-app-server",
    "google-antigravity-acp",
    "devin-acp",
  ] as const;
  await Promise.all(
    Array.from({ length: COUNT }, (_, i) =>
      store.saveRememberedAgentPermissionRule({
        workspaceId: `ws-${i % 4}`,
        backendId: backends[i % backends.length]!,
        toolKey: `stress:key-${i}`,
        toolLabel: `Rule ${i}`,
        decision: i % 2 === 0 ? "allow" : "reject",
        optionId: i % 2 === 0 ? "allow_always" : "reject_always",
        optionKind: i % 2 === 0 ? "allow_always" : "reject_always",
      })
    )
  );
  const settings = await store.getGlobalSettings();
  assert.equal(settings.agents.rememberedPermissions.length, COUNT);
  for (let i = 0; i < COUNT; i += 1) {
    assert.ok(
      settings.agents.rememberedPermissions.some(
        (rule) => rule.toolKey === `stress:key-${i}`
      ),
      `rule stress:key-${i} lost in concurrent save burst`
    );
  }
});

test("rules saved while a full-settings PUT is in flight survive write-time preservation", async () => {
  await store.clearRememberedAgentPermissionRules();
  const staleSnapshot = await store.getGlobalSettings();

  // Interleave: agent saves land concurrently with a stale full PUT that
  // carries an empty remembered list. Write-time preservation must keep them.
  const putPromise = settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: {
        ...staleSnapshot,
        agents: { ...staleSnapshot.agents, rememberedPermissions: [] },
      },
    }),
  });
  const savePromises = Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.saveRememberedAgentPermissionRule({
        workspaceId: "put-race",
        backendId: "opencode-server",
        toolKey: `opencode-server:race-${i}`,
        toolLabel: `Race ${i}`,
        decision: "allow",
        optionId: "allow_always",
        optionKind: "allow_always",
      })
    )
  );
  const [putResponse] = await Promise.all([putPromise, savePromises]);
  assert.equal(putResponse.status, 200);

  const settings = await store.getGlobalSettings();
  for (let i = 0; i < 20; i += 1) {
    assert.ok(
      settings.agents.rememberedPermissions.some(
        (rule) => rule.toolKey === `opencode-server:race-${i}`
      ),
      `rule opencode-server:race-${i} clobbered by in-flight PUT`
    );
  }
});

test("persist helper retries transient storage failures", async () => {
  const { getStorage, __setStorageForTesting } = await import(
    "../src/storage/runtime.js"
  );
  const realDriver = await getStorage();
  let failuresRemaining = 2;
  const flaky = new Proxy(realDriver, {
    get(target, prop, receiver) {
      if (prop === "saveGlobalSettings" && failuresRemaining > 0) {
        return async () => {
          failuresRemaining -= 1;
          throw new Error("injected transient failure");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  __setStorageForTesting(flaky as typeof realDriver);
  try {
    const saved = await helpers.persistRememberedPermissionChoice({
      workspaceId: "flaky-ws",
      backendId: "codex-app-server",
      toolKey: "codex-app-server:flaky",
      toolLabel: "Flaky save",
      optionId: "allow_always",
    });
    assert.equal(saved?.decision, "allow");
    assert.equal(failuresRemaining, 0);
  } finally {
    __setStorageForTesting(realDriver);
  }

  const resolved = await helpers.resolveRememberedPermissionDecision({
    workspaceId: "flaky-ws",
    backendId: "codex-app-server",
    toolKey: "codex-app-server:flaky",
  });
  assert.equal(resolved.kind, "remembered");
});

test("alternating upsert hammering keeps exactly one rule with the final decision", async () => {
  await store.clearRememberedAgentPermissionRules();
  for (let i = 0; i < 30; i += 1) {
    const optionId = i % 2 === 0 ? "allow_always" : "reject_always";
    await store.saveRememberedAgentPermissionRule({
      workspaceId: "hammer",
      backendId: "google-antigravity-acp",
      toolKey: "google-antigravity:hammer",
      toolLabel: "Hammer",
      decision: optionId === "allow_always" ? "allow" : "reject",
      optionId,
      optionKind: optionId,
    });
  }
  const settings = await store.getGlobalSettings();
  const matches = settings.agents.rememberedPermissions.filter(
    (rule) => rule.toolKey === "google-antigravity:hammer"
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.decision, "reject");
});
