import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-remembered-permissions-put-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [{ settingsRoutes }, store] = await Promise.all([
  import("../src/routes/settings.js"),
  import("../src/lib/global-settings-store.js"),
]);

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("remembered permission saves survive later stale full global settings PUT", async () => {
  await store.saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cesium-agent",
    toolKey: "cesium:terminal:npm test",
    toolLabel: "Run npm test",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  const staleGlobal = await store.getGlobalSettings();
  staleGlobal.agents = {
    ...staleGlobal.agents,
    rememberedPermissions: [],
    submitCtrlEnter: !staleGlobal.agents.submitCtrlEnter,
  };

  const response = await settingsRoutes.request("/api/settings/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: staleGlobal }),
  });
  assert.equal(response.status, 200);

  const loaded = await store.getGlobalSettings();
  assert.equal(loaded.agents.rememberedPermissions.length, 1);
  assert.equal(loaded.agents.rememberedPermissions[0]?.toolKey, "cesium:terminal:npm test");
  assert.equal(loaded.agents.submitCtrlEnter, staleGlobal.agents.submitCtrlEnter);
});

test("dedicated remembered permission delete and clear routes update the global store", async () => {
  await store.clearRememberedAgentPermissionRules();
  const first = await store.saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-sdk",
    toolKey: "acp:one",
    toolLabel: "One",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });
  await store.saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "claude-code-sdk",
    toolKey: "Bash:ls",
    toolLabel: "ls",
    decision: "reject",
    optionId: "reject_always",
    optionKind: "reject_always",
  });

  const removeResponse = await settingsRoutes.request(
    `/api/settings/remembered-permissions/${encodeURIComponent(first.id)}`,
    { method: "DELETE" }
  );
  assert.equal(removeResponse.status, 200);
  const removeBody = (await removeResponse.json()) as {
    rememberedPermissions: Array<{ id: string; backendId: string }>;
  };
  assert.equal(removeBody.rememberedPermissions.length, 1);
  assert.equal(removeBody.rememberedPermissions[0]?.backendId, "claude-code-sdk");

  const clearHarness = await settingsRoutes.request(
    "/api/settings/remembered-permissions/clear",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backendId: "claude-code-sdk" }),
    }
  );
  assert.equal(clearHarness.status, 200);
  const clearHarnessBody = (await clearHarness.json()) as {
    rememberedPermissions: unknown[];
  };
  assert.equal(clearHarnessBody.rememberedPermissions.length, 0);

  await store.saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "opencode-server",
    toolKey: "opencode-server:abc",
    toolLabel: "OpenCode",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  const clearAll = await settingsRoutes.request(
    "/api/settings/remembered-permissions/clear",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );
  assert.equal(clearAll.status, 200);
  const clearAllBody = (await clearAll.json()) as {
    rememberedPermissions: unknown[];
  };
  assert.equal(clearAllBody.rememberedPermissions.length, 0);
});

test("shared remembered permission helper builds stable keys and resolves auto-accept", async () => {
  const {
    buildRememberedPermissionToolKey,
    persistRememberedPermissionChoice,
    resolveRememberedPermissionDecision,
  } = await import("../src/lib/agents/remembered-permissions.js");

  const keyA = buildRememberedPermissionToolKey("opencode-server", "Run", "pwd");
  const keyB = buildRememberedPermissionToolKey("opencode-server", "Run", "pwd");
  const keyC = buildRememberedPermissionToolKey("opencode-server", "Run", "ls");
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.match(keyA, /^opencode-server:[a-f0-9]{40}$/);

  await store.clearRememberedAgentPermissionRules();
  const saved = await persistRememberedPermissionChoice({
    workspaceId: "workspace-helper",
    backendId: "opencode-v2-beta",
    toolKey: keyA,
    toolLabel: "Run pwd",
    optionId: "allow_always",
  });
  assert.equal(saved?.decision, "allow");

  const remembered = await resolveRememberedPermissionDecision({
    workspaceId: "workspace-helper",
    backendId: "opencode-v2-beta",
    toolKey: keyA,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  assert.equal(remembered.kind, "remembered");
  if (remembered.kind === "remembered") {
    assert.equal(remembered.decision, "allow");
    assert.equal(remembered.providerOptionId, "allow");
  }
});
