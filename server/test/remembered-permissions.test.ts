import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-remembered-permissions-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const {
  getGlobalSettings,
  getRememberedAgentPermissionRule,
  saveRememberedAgentPermissionRule,
} = await import("../src/lib/global-settings-store.js");

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("global settings default remembered permissions to an empty list", async () => {
  const settings = await getGlobalSettings();
  assert.deepEqual(settings.agents.rememberedPermissions, []);
  assert.equal(settings.agents.autoAcceptAllAgentPermissions, false);
});

test("remembered agent permission rules are scoped and upserted", async () => {
  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-sdk",
    toolKey: "acp:abc123",
    toolLabel: "Read package.json",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  const saved = await getRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-sdk",
    toolKey: "acp:abc123",
  });
  assert.equal(saved?.decision, "allow");
  assert.equal(saved?.toolLabel, "Read package.json");

  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-sdk",
    toolKey: "acp:abc123",
    toolLabel: "Read package.json",
    decision: "reject",
    optionId: "reject_always",
    optionKind: "reject_always",
  });

  const settings = await getGlobalSettings();
  assert.equal(settings.agents.rememberedPermissions.length, 1);
  assert.equal(settings.agents.rememberedPermissions[0]?.decision, "reject");

  const wrongWorkspace = await getRememberedAgentPermissionRule({
    workspaceId: "workspace-b",
    backendId: "cursor-sdk",
    toolKey: "acp:abc123",
  });
  assert.equal(wrongWorkspace, undefined);
});

test("remembered permission backend ids are normalized from legacy harness ids", async () => {
  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-legacy",
    backendId: "cesium",
    toolKey: "cesium:terminal:npm test",
    toolLabel: "Run npm test",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  const cesiumRule = await getRememberedAgentPermissionRule({
    workspaceId: "workspace-legacy",
    backendId: "cesium-agent",
    toolKey: "cesium:terminal:npm test",
  });
  assert.equal(cesiumRule?.backendId, "cesium-agent");

  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-legacy",
    backendId: "cursor-acp",
    toolKey: "acp:legacy",
    toolLabel: "Legacy cursor rule",
    decision: "reject",
    optionId: "reject_always",
    optionKind: "reject_always",
  });

  const cursorRule = await getRememberedAgentPermissionRule({
    workspaceId: "workspace-legacy",
    backendId: "cursor-sdk",
    toolKey: "acp:legacy",
  });
  assert.equal(cursorRule?.backendId, "cursor-sdk");
});

test("remembered permission category matchStyle covers any tool key in that category", async () => {
  const {
    findMatchingRememberedPermissionRule,
    saveRememberedAgentPermissionRule,
  } = await import("../src/lib/global-settings-store.js");

  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-category",
    backendId: "cesium-agent",
    toolKey: "cesium:switch_mode",
    toolLabel: "Any mode switch",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
    permissionCategory: "switchMode",
    matchStyle: "category",
  });

  const settings = await getGlobalSettings();
  const matched = findMatchingRememberedPermissionRule(settings.agents.rememberedPermissions, {
    workspaceId: "workspace-category",
    backendId: "cesium-agent",
    toolKey: "cesium:switch_mode:plan",
    permissionCategory: "switchMode",
  });
  assert.equal(matched?.decision, "allow");
  assert.equal(matched?.matchStyle, "category");
  assert.equal(matched?.permissionCategory, "switchMode");

  const exactWins = await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-category",
    backendId: "cesium-agent",
    toolKey: "cesium:switch_mode:ask",
    toolLabel: "Switch to ask mode",
    decision: "reject",
    optionId: "reject_always",
    optionKind: "reject_always",
    permissionCategory: "switchMode",
    matchStyle: "exact",
  });
  assert.equal(exactWins.decision, "reject");

  const refreshed = await getGlobalSettings();
  const preferExact = findMatchingRememberedPermissionRule(refreshed.agents.rememberedPermissions, {
    workspaceId: "workspace-category",
    backendId: "cesium-agent",
    toolKey: "cesium:switch_mode:ask",
    permissionCategory: "switchMode",
  });
  assert.equal(preferExact?.decision, "reject");
  assert.equal(preferExact?.matchStyle ?? "exact", "exact");
});

test("shared permission options expose allow/reject once and always kinds", async () => {
  const {
    STANDARD_PERMISSION_OPTIONS,
    withPersistentPermissionOptions,
    permissionDecisionFromOption,
    permissionDecisionFromKind,
    isOrchestrationPermissionCategory,
  } = await import("../src/lib/agents/permission-options.js");

  assert.deepEqual(
    STANDARD_PERMISSION_OPTIONS.map((option) => option.kind),
    ["allow_once", "allow_always", "reject_once", "reject_always"]
  );
  assert.equal(permissionDecisionFromOption("allow_always"), "allow");
  assert.equal(permissionDecisionFromOption("reject_once"), "reject");
  assert.equal(permissionDecisionFromKind("allow_once"), "allow");
  assert.equal(isOrchestrationPermissionCategory("switchMode"), false);
  assert.equal(isOrchestrationPermissionCategory("terminal"), true);

  const ensured = withPersistentPermissionOptions([
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ]);
  assert.ok(ensured.some((option) => option.kind === "allow_always"));
  assert.ok(ensured.some((option) => option.kind === "reject_always"));
});
