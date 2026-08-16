import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-engine-agent-flags-${Date.now()}-${Math.random()
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
  saveRememberedAgentPermissionRule,
  setEngineAgentFlags,
} = await import("../src/lib/global-settings-store.js");

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

test("setEngineAgentFlags updates only the provided flags", async () => {
  const before = await getGlobalSettings();
  assert.equal(before.agents.autoAcceptAllAgentPermissions, false);
  assert.equal(before.agents.mcpProt, false);

  const agents = await setEngineAgentFlags({ autoAcceptAllAgentPermissions: true });
  assert.equal(agents.autoAcceptAllAgentPermissions, true);
  assert.equal(agents.mcpProt, false);

  const partial = await setEngineAgentFlags({ mcpProt: true });
  assert.equal(partial.autoAcceptAllAgentPermissions, true);
  assert.equal(partial.mcpProt, true);

  const persisted = await getGlobalSettings();
  assert.equal(persisted.agents.autoAcceptAllAgentPermissions, true);
  assert.equal(persisted.agents.mcpProt, true);
});

test("setEngineAgentFlags preserves remembered permission rules", async () => {
  await saveRememberedAgentPermissionRule({
    workspaceId: "workspace-flags",
    backendId: "cesium-agent",
    toolKey: "cesium:terminal:ls",
    toolLabel: "List files",
    decision: "allow",
    optionId: "allow_always",
    optionKind: "allow_always",
  });

  await setEngineAgentFlags({ autoAcceptAllAgentPermissions: false, mcpProt: false });

  const settings = await getGlobalSettings();
  assert.equal(settings.agents.autoAcceptAllAgentPermissions, false);
  assert.equal(settings.agents.mcpProt, false);
  assert.equal(
    settings.agents.rememberedPermissions.some(
      (rule) => rule.workspaceId === "workspace-flags"
    ),
    true
  );
});
