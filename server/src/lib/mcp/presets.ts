import type { McpServerConfig } from "@cesium/core/mcp";

export type McpPresetDefinition = {
  presetId: string;
  label: string;
  description: string;
  config: Omit<McpServerConfig, "id" | "label" | "enabled" | "createdAt" | "updatedAt" | "presetId">;
};

export const MCP_PRESETS: McpPresetDefinition[] = [
  {
    presetId: "context7",
    label: "Context7",
    description: "Up-to-date library documentation (streamable HTTP, optional API key).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.context7.com/mcp" },
      auth: { kind: "none" },
      summary: "Library docs and code examples",
    },
  },
  {
    presetId: "linear",
    label: "Linear",
    description: "Linear issues and projects (OAuth; configure client credentials in settings).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.linear.app/mcp" },
      auth: {
        kind: "oauth",
        scopes: ["read", "write"],
        discoveryUrl: "https://mcp.linear.app/.well-known/oauth-authorization-server",
      },
      summary: "Linear project management",
    },
  },
  {
    presetId: "notion",
    label: "Notion",
    description: "Notion workspace (OAuth).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.notion.com/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Notion pages and databases",
    },
  },
  {
    presetId: "figma",
    label: "Figma",
    description: "Figma design files (OAuth).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.figma.com/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Figma design context",
    },
  },
  {
    presetId: "slack",
    label: "Slack",
    description: "Slack workspace (OAuth).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.slack.com/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Slack messaging",
    },
  },
  {
    presetId: "todoist",
    label: "Todoist",
    description: "Todoist tasks (API token via header).",
    config: {
      transport: "streamable-http",
      remote: { url: "https://api.todoist.com/mcp" },
      auth: {
        kind: "headers",
        headers: [{ name: "Authorization", secretId: "__preset_todoist_token__" }],
      },
      summary: "Todoist task management",
    },
  },
];

export function getMcpPreset(presetId: string): McpPresetDefinition | null {
  return MCP_PRESETS.find((preset) => preset.presetId === presetId) ?? null;
}
