import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `opencursor-remembered-permissions-${Date.now()}-${Math.random()
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
    backendId: "cursor-acp",
    toolKey: "acp:abc123",
    toolLabel: "Read package.json",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  const saved = await getRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-acp",
    toolKey: "acp:abc123",
  });
  assert.equal(saved?.decision, "allow");
  assert.equal(saved?.toolLabel, "Read package.json");

  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-a",
    backendId: "cursor-acp",
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
    backendId: "cursor-acp",
    toolKey: "acp:abc123",
  });
  assert.equal(wrongWorkspace, undefined);
});
