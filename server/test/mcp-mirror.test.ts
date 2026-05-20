import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServerConfig } from "@cesium/core/mcp";
import { writeMcpWorkspaceMirror } from "../src/lib/mcp/workspace-mirror.js";

test("writeMcpWorkspaceMirror writes redacted discovery files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencursor-mcp-"));
  try {
    const config: McpServerConfig = {
      id: "context7",
      label: "Context7",
      enabled: true,
      transport: "streamable-http",
      remote: { url: "https://mcp.context7.com/mcp" },
      auth: { kind: "none" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeMcpWorkspaceMirror({
      workspaceRoot: root,
      servers: [config],
      catalogs: [
        {
          config,
          status: { connected: true, lastCheckedAt: Date.now(), toolCount: 1 },
          instructions: "Use Context7 for docs.",
          tools: [
            {
              name: "resolve-library-id",
              description: "Resolve a library id",
              inputSchema: { type: "object", properties: { libraryName: { type: "string" } } },
            },
          ],
        },
      ],
    });
    const summary = await readFile(
      path.join(root, "mcp-servers", "context7", "summary.txt"),
      "utf8"
    );
    assert.match(summary, /Context7/);
    const catalog = await readFile(
      path.join(root, "mcp-servers", "context7", "tools", "_catalog.json"),
      "utf8"
    );
    assert.match(catalog, /resolve-library-id/);
    assert.doesNotMatch(catalog, /sk-secret/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
