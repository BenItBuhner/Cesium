import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

function tempWorkspace(): string {
  const root = path.join(os.tmpdir(), `agy-legacy-cleanup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(path.join(root, ".agents"), { recursive: true });
  return root;
}

test("legacy cleanup removes the agy hook bridge and Cesium-managed MCP entries but keeps user config", async () => {
  const { cleanupLegacyAntigravityWorkspaceArtifacts, resetLegacyAntigravityCleanupForTest } =
    await import("../src/lib/agents/google-antigravity-legacy-cleanup.js");
  resetLegacyAntigravityCleanupForTest();
  const root = tempWorkspace();
  const agents = path.join(root, ".agents");
  writeFileSync(path.join(agents, ".opencursor-antigravity-hook.cjs"), "// helper");
  writeFileSync(path.join(agents, ".opencursor-antigravity-events.jsonl"), "{}\n");
  writeFileSync(path.join(agents, "hooks.json.4242.tmp"), "{}");
  writeFileSync(
    path.join(agents, "hooks.json"),
    JSON.stringify(
      {
        "opencursor-antigravity-event-bridge": { enabled: true, PreToolUse: [] },
        "user-lint-hook": { enabled: true, PostToolUse: [] },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(agents, "mcp_config.json"),
    JSON.stringify(
      {
        mcpServers: {
          context7: { serverUrl: "https://mcp.context7.com/mcp" },
          "my-own-server": { command: "/usr/local/bin/my-mcp" },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(agents, ".cesium-plugin-mcp.json"),
    JSON.stringify({ schemaVersion: 1, managedServerIds: ["context7"], updatedAt: 1 })
  );

  const result = await cleanupLegacyAntigravityWorkspaceArtifacts(root);
  assert.equal(result.hooksJsonUpdated, true);
  assert.equal(result.mcpConfigUpdated, true);
  assert.equal(existsSync(path.join(agents, ".opencursor-antigravity-hook.cjs")), false);
  assert.equal(existsSync(path.join(agents, ".opencursor-antigravity-events.jsonl")), false);
  assert.equal(existsSync(path.join(agents, "hooks.json.4242.tmp")), false);
  assert.equal(existsSync(path.join(agents, ".cesium-plugin-mcp.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(agents, "hooks.json"), "utf8")), {
    "user-lint-hook": { enabled: true, PostToolUse: [] },
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(agents, "mcp_config.json"), "utf8")), {
    mcpServers: { "my-own-server": { command: "/usr/local/bin/my-mcp" } },
  });

  // Second call is a no-op per process; `force` re-runs and finds nothing.
  const again = await cleanupLegacyAntigravityWorkspaceArtifacts(root);
  assert.deepEqual(again, { removedFiles: [], hooksJsonUpdated: false, mcpConfigUpdated: false });
  const forced = await cleanupLegacyAntigravityWorkspaceArtifacts(root, { force: true });
  assert.deepEqual(forced, { removedFiles: [], hooksJsonUpdated: false, mcpConfigUpdated: false });
});

test("legacy cleanup deletes files that only ever held Cesium's entries and tolerates missing dirs", async () => {
  const { cleanupLegacyAntigravityWorkspaceArtifacts, resetLegacyAntigravityCleanupForTest } =
    await import("../src/lib/agents/google-antigravity-legacy-cleanup.js");
  resetLegacyAntigravityCleanupForTest();
  const root = tempWorkspace();
  const agents = path.join(root, ".agents");
  writeFileSync(
    path.join(agents, "hooks.json"),
    JSON.stringify({ "opencursor-antigravity-event-bridge": { enabled: true } })
  );
  writeFileSync(
    path.join(agents, "mcp_config.json"),
    JSON.stringify({ mcpServers: { context7: { serverUrl: "https://mcp.context7.com/mcp" } } })
  );
  writeFileSync(
    path.join(agents, ".cesium-plugin-mcp.json"),
    JSON.stringify({ schemaVersion: 1, managedServerIds: ["context7"], updatedAt: 1 })
  );
  const result = await cleanupLegacyAntigravityWorkspaceArtifacts(root);
  assert.equal(existsSync(path.join(agents, "hooks.json")), false);
  assert.equal(existsSync(path.join(agents, "mcp_config.json")), false);
  assert.ok(result.removedFiles.some((file) => file.endsWith("hooks.json")));
  assert.ok(result.removedFiles.some((file) => file.endsWith("mcp_config.json")));

  const bare = path.join(os.tmpdir(), `agy-legacy-none-${process.pid}-${Date.now()}`);
  mkdirSync(bare, { recursive: true });
  assert.deepEqual(await cleanupLegacyAntigravityWorkspaceArtifacts(bare), {
    removedFiles: [],
    hooksJsonUpdated: false,
    mcpConfigUpdated: false,
  });
});
