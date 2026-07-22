import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCURSOR_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-plugin-test-${Date.now()}-${randomUUID().slice(0, 8)}`
);

test("agent plugins install built-ins and resolve prompt plus MCP attachments", async () => {
  const { installAgentPlugin, setAgentPluginHarnessOverride } = await import(
    "../src/lib/plugins/store.js"
  );
  const { resolveAgentPluginAttachments } = await import(
    "../src/lib/plugins/attachments.js"
  );

  const workspaceId = "workspace-plugins";
  const workspaceRoot = process.cwd();
  const install = await installAgentPlugin(workspaceId, "context7");

  assert.equal(install.enabled, true);

  const cursorAttachments = await resolveAgentPluginAttachments({
    workspaceId,
    workspaceRoot,
    backendId: "cursor-sdk",
  });

  assert.equal(cursorAttachments.plugins.length, 1);
  assert.match(cursorAttachments.skillsList, /Use Context7 Docs/);
  assert.equal(cursorAttachments.mcpServers[0]?.pluginId, "context7");
  assert.equal(cursorAttachments.sdkMcp.servers.context7?.type, "http");
  assert.deepEqual(cursorAttachments.toolDisplays[0], {
    pluginId: "context7",
    pluginName: "Context7",
    pluginIconUrl: "https://context7.com/favicon.ico",
    mcpServerIds: ["context7"],
  });

  await setAgentPluginHarnessOverride(workspaceId, "context7", "cursor-sdk", false);
  const disabledAttachments = await resolveAgentPluginAttachments({
    workspaceId,
    workspaceRoot,
    backendId: "cursor-sdk",
  });
  assert.equal(disabledAttachments.plugins.length, 0);

  await fs.rm(process.env.OPENCURSOR_DATA_DIR!, { recursive: true, force: true });
});

test("custom agent plugins contribute skills without MCP", async () => {
  const { installAgentPlugin } = await import("../src/lib/plugins/store.js");
  const { resolveAgentPluginAttachments } = await import(
    "../src/lib/plugins/attachments.js"
  );

  const workspaceId = "workspace-custom-plugin";
  await installAgentPlugin(workspaceId, "docs-helper", {
    schemaVersion: 1,
    pluginId: "docs-helper",
    displayName: "Docs Helper",
    description: "Custom skill-only plugin",
    mcp: [],
    skills: [
      {
        id: "docs-style",
        title: "Docs Style",
        description: "Write concise docs",
        body: "Keep docs terse and implementation-focused.",
      },
    ],
  });

  const attachments = await resolveAgentPluginAttachments({
    workspaceId,
    workspaceRoot: process.cwd(),
    backendId: "google-antigravity-cli",
  });
  assert.match(attachments.promptSection, /Docs Helper/);
  assert.match(attachments.promptSection, /Keep docs terse/);
  assert.equal(attachments.mcpServers.length, 0);
});

test("plugin discovery includes local Context7 and harness verify identifies all backends", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-plugin-verify-"));
  const workspaceId = "workspace-plugin-verify";

  const { discoverAgentPlugins } = await import("../src/lib/plugins/discovery.js");
  const { installAgentPlugin } = await import("../src/lib/plugins/store.js");
  const { verifyAgentPluginHarnesses } = await import("../src/lib/plugins/verify.js");
  const { HARNESS_PLUGIN_CAPABILITIES } = await import("../src/lib/plugins/harness-support.js");

  const discovery = await discoverAgentPlugins({ query: "context7" });
  assert.ok(discovery.plugins.some((entry) => entry.definition.pluginId === "context7"));
  assert.ok(discovery.sources.some((source) => source.id === "local" || source.id === "builtin"));

  await installAgentPlugin(workspaceId, "context7");
  const report = await verifyAgentPluginHarnesses({ workspaceId, workspaceRoot });

  assert.equal(report.enabledPluginCount, 1);
  assert.equal(report.harnesses.length, Object.keys(HARNESS_PLUGIN_CAPABILITIES).length);
  assert.ok(report.summary.identifyingPlugins.includes("cesium-agent"));
  assert.ok(report.summary.identifyingPlugins.includes("cursor-sdk"));
  assert.ok(report.summary.promptOnlyMcp.includes("opencode-server"));
  assert.ok(report.summary.promptOnlyMcp.includes("opencode-v2-beta"));
  assert.ok(report.summary.promptOnlyMcp.includes("pi-agent"));

  const openCode = report.harnesses.find((entry) => entry.backendId === "opencode-server");
  assert.ok(openCode);
  assert.equal(openCode.nativeMcp, false);
  assert.ok(openCode.warnings.length > 0);
  assert.match(openCode.warnings[0]?.reason ?? "", /will not work|prompt/i);

  const antigravity = report.harnesses.find(
    (entry) => entry.backendId === "google-antigravity-cli"
  );
  assert.ok(antigravity?.identified);
  assert.equal(antigravity?.nativeMcp, true);

  const mcpConfig = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, ".agents", "mcp_config.json"), "utf8")
  ) as { mcpServers: Record<string, { serverUrl?: string }> };
  assert.equal(mcpConfig.mcpServers.context7?.serverUrl, "https://mcp.context7.com/mcp");

  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(process.env.OPENCURSOR_DATA_DIR!, { recursive: true, force: true });
});
