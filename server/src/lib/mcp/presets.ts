import type { McpServerConfig } from "@cesium/core/mcp";

export type McpAuthOnboarding =
  | { kind: "none" }
  | { kind: "oauth-dcr" }
  | { kind: "oauth-manual" }
  | { kind: "bearer"; label?: string; docsUrl?: string }
  | {
      kind: "headers";
      fields: Array<{ name: string; label: string; docsUrl?: string }>;
    };

export type McpPresetDefinition = {
  presetId: string;
  label: string;
  description: string;
  onboarding?: McpAuthOnboarding;
  config: Omit<McpServerConfig, "id" | "label" | "enabled" | "createdAt" | "updatedAt" | "presetId">;
};

export const MCP_PRESETS: McpPresetDefinition[] = [
  {
    presetId: "context7",
    label: "Context7",
    description: "Up-to-date library documentation (streamable HTTP, optional API key).",
    onboarding: {
      kind: "bearer",
      label: "Context7 API key (optional)",
      docsUrl: "https://context7.com/docs",
    },
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
    description: "Linear issues and projects (OAuth with dynamic client registration).",
    onboarding: { kind: "oauth-dcr" },
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
    onboarding: { kind: "oauth-dcr" },
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
    onboarding: { kind: "oauth-dcr" },
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
    onboarding: { kind: "oauth-dcr" },
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
    onboarding: {
      kind: "headers",
      fields: [
        {
          name: "Authorization",
          label: "Todoist API token",
          docsUrl: "https://developer.todoist.com/guides/#authorization",
        },
      ],
    },
    config: {
      transport: "streamable-http",
      remote: { url: "https://api.todoist.com/mcp" },
      auth: {
        kind: "headers",
        headers: [{ name: "Authorization", secretId: "todoist-token" }],
      },
      summary: "Todoist task management",
    },
  },
  {
    presetId: "exa",
    label: "Exa",
    description: "Web search and research (API key header).",
    onboarding: {
      kind: "headers",
      fields: [{ name: "x-api-key", label: "Exa API key", docsUrl: "https://docs.exa.ai" }],
    },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.exa.ai/mcp" },
      auth: {
        kind: "headers",
        headers: [{ name: "x-api-key", secretId: "exa-api-key" }],
      },
      summary: "Exa web search and research",
    },
  },
  {
    presetId: "github",
    label: "GitHub",
    description: "Repositories, issues, and pull requests (personal access token).",
    onboarding: {
      kind: "headers",
      fields: [
        {
          name: "Authorization",
          label: "GitHub personal access token (Bearer …)",
          docsUrl: "https://github.com/settings/tokens",
        },
      ],
    },
    config: {
      transport: "streamable-http",
      remote: { url: "https://api.githubcopilot.com/mcp/" },
      auth: {
        kind: "headers",
        headers: [{ name: "Authorization", secretId: "github-token" }],
      },
      summary: "GitHub repositories and issues",
    },
  },
  {
    presetId: "sentry",
    label: "Sentry",
    description: "Error monitoring and issue context (OAuth or auth token).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.sentry.dev/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Sentry issues and traces",
    },
  },
  {
    presetId: "stripe",
    label: "Stripe",
    description: "Payments, customers, and Stripe docs (OAuth or restricted API key).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.stripe.com" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Stripe payments and billing",
    },
  },
  {
    presetId: "atlassian",
    label: "Atlassian",
    description: "Jira, Confluence, and Bitbucket via the Atlassian Rovo MCP server.",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.atlassian.com/v1/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Jira and Confluence",
    },
  },
  {
    presetId: "huggingface",
    label: "Hugging Face",
    description: "Models, datasets, and Spaces on Hugging Face.",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://huggingface.co/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Hugging Face Hub",
    },
  },
  {
    presetId: "neon",
    label: "Neon",
    description: "Serverless Postgres projects and SQL (OAuth).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.neon.tech/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Neon Postgres",
    },
  },
  {
    presetId: "cloudflare",
    label: "Cloudflare",
    description: "Cloudflare API and account operations (OAuth).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.cloudflare.com/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Cloudflare account and APIs",
    },
  },
  {
    presetId: "vercel",
    label: "Vercel",
    description: "Projects, deployments, and logs (OAuth).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.vercel.com" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Vercel deployments",
    },
  },
  {
    presetId: "supabase",
    label: "Supabase",
    description: "Projects, database, and auth (OAuth).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.supabase.com/mcp" },
      auth: { kind: "oauth", scopes: [] },
      summary: "Supabase projects",
    },
  },
  {
    presetId: "hubspot",
    label: "HubSpot",
    description: "CRM records and marketing context (OAuth).",
    onboarding: { kind: "oauth-dcr" },
    config: {
      transport: "streamable-http",
      remote: { url: "https://mcp.hubspot.com" },
      auth: { kind: "oauth", scopes: [] },
      summary: "HubSpot CRM",
    },
  },
];

export function getMcpPreset(presetId: string): McpPresetDefinition | null {
  return MCP_PRESETS.find((preset) => preset.presetId === presetId) ?? null;
}
