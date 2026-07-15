import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportEnabledMcpServersForSdk,
  mcpServerConfigToSdkServer,
} from "../src/lib/agents/mcp-export-adapter.js";

test("mcpServerConfigToSdkServer exports stdio servers for SDKs", async () => {
  const server = await mcpServerConfigToSdkServer({
    workspaceId: "workspace",
    workspaceRoot: "/repo",
    config: {
      id: "context7",
      label: "Context7",
      enabled: true,
      transport: "stdio",
      stdio: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      auth: { kind: "none" },
      createdAt: 1,
      updatedAt: 1,
    },
  });
  assert.deepEqual(server, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    env: undefined,
    cwd: "/repo",
  });
});

test("mcpServerConfigToSdkServer exports remote servers for SDKs", async () => {
  const server = await mcpServerConfigToSdkServer({
    workspaceId: "workspace",
    workspaceRoot: "/repo",
    config: {
      id: "remote",
      label: "Remote",
      enabled: true,
      transport: "streamable-http",
      remote: { url: "https://example.com/mcp" },
      auth: { kind: "none" },
      createdAt: 1,
      updatedAt: 1,
    },
  });
  assert.deepEqual(server, {
    type: "http",
    url: "https://example.com/mcp",
  });
});

test("exportEnabledMcpServersForSdk preserves plugin metadata for skipped configs", async () => {
  const exported = await exportEnabledMcpServersForSdk({
    workspaceId: "workspace",
    workspaceRoot: "/repo",
    configs: [
      {
        id: "plugin-bad",
        label: "Plugin Bad",
        enabled: true,
        transport: "streamable-http",
        auth: { kind: "none" },
        pluginId: "plugin",
        displayName: "Plugin",
        iconUrl: "https://example.com/icon.png",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  assert.deepEqual(exported, {
    servers: {},
    skipped: [
      {
        id: "plugin-bad",
        label: "Plugin Bad",
        reason: "Unsupported or incomplete MCP server config.",
        pluginId: "plugin",
        pluginName: "Plugin",
      },
    ],
  });
});
