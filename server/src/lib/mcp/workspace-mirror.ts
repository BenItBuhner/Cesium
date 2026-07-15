import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "@cesium/core/mcp";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnectionStatus } from "./types.js";

const MAX_TOOL_MD_CHARS = 12_000;

function resolveMirrorPath(workspaceRoot: string, relativePath: string): string {
  const resolved = path.resolve(workspaceRoot, relativePath);
  const rel = path.relative(workspaceRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Mirror path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

function slugifyToolFileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "tool";
}

function toolToMarkdown(tool: Tool): string {
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? JSON.stringify(tool.inputSchema, null, 2)
      : "{}";
  const body = `# ${tool.name}

${tool.description?.trim() || "No description."}

## Input schema

\`\`\`json
${schema.slice(0, MAX_TOOL_MD_CHARS)}
\`\`\`
`;
  return body.length > MAX_TOOL_MD_CHARS
    ? `${body.slice(0, MAX_TOOL_MD_CHARS)}\n\n_(truncated — see _catalog.json)_`
    : body;
}

export async function writeMcpWorkspaceMirror(input: {
  workspaceRoot: string;
  servers: McpServerConfig[];
  catalogs: Array<{
    config: McpServerConfig;
    status: McpConnectionStatus;
    instructions?: string;
    tools: Tool[];
  }>;
}): Promise<void> {
  const root = resolveMirrorPath(input.workspaceRoot, "mcp-servers");
  await fs.mkdir(root, { recursive: true });
  const activeServerIds = new Set(input.catalogs.map((entry) => entry.config.id));
  for (const dirent of await fs.readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || activeServerIds.has(dirent.name)) {
      continue;
    }
    await fs.rm(path.join(root, dirent.name), { recursive: true, force: true });
  }

  const indexLines = [
    "# MCP servers",
    "",
    `Last refreshed: ${new Date().toISOString()}`,
    "",
    "Each subdirectory contains tool catalogs and instructions for one connected MCP server.",
    "",
  ];

  for (const entry of input.catalogs) {
    const serverDir = path.join(root, entry.config.id);
    const toolsDir = path.join(serverDir, "tools");
    await fs.mkdir(toolsDir, { recursive: true });

    const summary =
      entry.config.summary?.trim() ||
      `${entry.config.label} (${entry.config.transport})`;
    await fs.writeFile(path.join(serverDir, "summary.txt"), `${summary}\n`, "utf8");
    if (entry.config.pluginId) {
      await fs.writeFile(
        path.join(serverDir, "plugin.json"),
        `${JSON.stringify(
          {
            pluginId: entry.config.pluginId,
            pluginContributionId: entry.config.pluginContributionId,
            displayName: entry.config.displayName,
            iconUrl: entry.config.iconUrl,
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }

    await fs.writeFile(
      path.join(serverDir, "status.json"),
      `${JSON.stringify(entry.status, null, 2)}\n`,
      "utf8"
    );

    if (entry.instructions?.trim()) {
      await fs.writeFile(
        path.join(serverDir, "instructions.md"),
        `${entry.instructions.trim()}\n`,
        "utf8"
      );
    }

    await fs.writeFile(
      path.join(toolsDir, "_catalog.json"),
      `${JSON.stringify({ tools: entry.tools }, null, 2)}\n`,
      "utf8"
    );

    for (const tool of entry.tools) {
      const fileName = `${slugifyToolFileName(tool.name)}.md`;
      await fs.writeFile(path.join(toolsDir, fileName), toolToMarkdown(tool), "utf8");
    }

    if (entry.config.auth.kind === "oauth") {
      await fs.writeFile(
        path.join(serverDir, "oauth.md"),
        `# OAuth\n\nThis server uses OAuth. Tokens are stored on the Cesium server only — not in this folder.\n\nStatus: ${entry.status.connected ? "connected" : entry.status.needsAuth ? "needs authentication" : "disconnected"}\n`,
        "utf8"
      );
    }

    indexLines.push(
      `- **${entry.config.label}** (\`${entry.config.id}\`): ${summary}${
        entry.config.pluginId ? ` _(managed by ${entry.config.displayName ?? entry.config.pluginId})_` : ""
      }`
    );
  }

  await fs.writeFile(path.join(root, "_index.md"), `${indexLines.join("\n")}\n`, "utf8");
}

export async function ensureMcpGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = resolveMirrorPath(workspaceRoot, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (existing.includes("mcp-servers/")) {
      return;
    }
    await fs.appendFile(gitignorePath, "\nmcp-servers/\n", "utf8");
  } catch {
    // no .gitignore — skip
  }
}
