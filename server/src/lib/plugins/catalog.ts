import type { AgentPluginDefinition } from "./types.js";
import { standardHarnessSupport } from "./harness-support.js";

const CORE_BUILT_IN_AGENT_PLUGINS: AgentPluginDefinition[] = [
  {
    schemaVersion: 1,
    pluginId: "context7",
    displayName: "Context7",
    description: "Fetch current documentation and code examples for libraries and frameworks.",
    iconUrl: "https://context7.com/favicon.ico",
    builtIn: true,
    marketplace: { id: "context7", publisher: "Context7" },
    mcp: [{ id: "context7", presetId: "context7" }],
    skills: [
      {
        id: "context7-docs",
        title: "Use Context7 Docs",
        description: "Look up library documentation before answering API or framework questions.",
        triggerHints: ["framework docs", "API reference", "library examples"],
        body: [
          "Use Context7 when the user asks about libraries, frameworks, SDKs, APIs, or CLI usage.",
          "Prefer fetched documentation over memory for version-sensitive syntax, setup, and migration guidance.",
        ].join("\n"),
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "linear",
    displayName: "Linear",
    description: "Read and update Linear issues, comments, teams, and project metadata.",
    iconUrl: "https://linear.app/favicon.ico",
    builtIn: true,
    marketplace: { id: "linear", publisher: "Linear" },
    mcp: [{ id: "linear", presetId: "linear" }],
    skills: [
      {
        id: "linear-workflow",
        title: "Linear Workflow",
        description: "Use Linear context for issue-driven implementation work.",
        triggerHints: ["Linear issue", "ticket", "project work"],
        body: [
          "When the user references a Linear issue, fetch the issue and relevant comments before planning or editing.",
          "Keep issue status, acceptance criteria, and implementation notes aligned with the work performed.",
        ].join("\n"),
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "notion",
    displayName: "Notion",
    description: "Search, create, and update Notion pages, databases, tasks, and documentation.",
    iconUrl: "https://www.notion.so/images/favicon.ico",
    builtIn: true,
    marketplace: { id: "notion", publisher: "Notion" },
    mcp: [{ id: "notion", presetId: "notion" }],
    skills: [
      {
        id: "notion-knowledge",
        title: "Notion Knowledge Capture",
        description: "Use Notion as a structured workspace for tasks and documentation.",
        triggerHints: ["Notion", "task board", "docs"],
        body: [
          "Use Notion tools for workspace knowledge, task creation, database queries, and documentation capture.",
          "Prefer structured page/database operations over unstructured prose when updating Notion.",
        ].join("\n"),
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "figma",
    displayName: "Figma",
    description: "Read designs, generate screens, sync components, and bridge code with Figma.",
    iconUrl: "https://static.figma.com/app/icon/1/favicon.png",
    builtIn: true,
    marketplace: { id: "figma", publisher: "Figma" },
    mcp: [{ id: "figma", presetId: "figma" }],
    skills: [
      {
        id: "figma-design",
        title: "Figma Design Workflow",
        description: "Use Figma design context and design-system workflows.",
        triggerHints: ["Figma", "design", "mockup", "Code Connect"],
        body: [
          "Use Figma tools whenever the user references a Figma URL or asks to create, inspect, or sync design work.",
          "Reuse existing design-system components and tokens before generating new nodes or code.",
        ].join("\n"),
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "slack",
    displayName: "Slack",
    description: "Search and interact with Slack workspace conversations.",
    iconUrl: "https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png",
    builtIn: true,
    marketplace: { id: "slack", publisher: "Slack" },
    mcp: [{ id: "slack", presetId: "slack" }],
    skills: [
      {
        id: "slack-context",
        title: "Slack Context",
        description: "Use Slack for conversational context and team updates.",
        triggerHints: ["Slack", "thread", "channel"],
        body: "Use Slack tools to find relevant team context before summarizing discussions or acting on Slack references.",
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "todoist",
    displayName: "Todoist",
    description: "Create and manage Todoist tasks from agent workflows.",
    iconUrl: "https://todoist.com/favicon.ico",
    builtIn: true,
    marketplace: { id: "todoist", publisher: "Todoist" },
    mcp: [{ id: "todoist", presetId: "todoist" }],
    skills: [
      {
        id: "todoist-tasks",
        title: "Todoist Tasks",
        description: "Use Todoist for lightweight task capture.",
        triggerHints: ["Todoist", "task", "reminder"],
        body: "Use Todoist tools when the user asks to capture, schedule, or update lightweight personal tasks.",
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "exa",
    displayName: "Exa",
    description: "Search the web and research sources with Exa.",
    iconUrl: "https://exa.ai/favicon.ico",
    builtIn: true,
    marketplace: { id: "exa", publisher: "Exa" },
    mcp: [{ id: "exa", presetId: "exa" }],
    skills: [
      {
        id: "exa-research",
        title: "Exa Research",
        description: "Use Exa for current web research and source discovery.",
        triggerHints: ["search the web", "research", "find sources"],
        body: "Use Exa when the user needs current web results, citations, or research beyond local workspace context.",
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "github",
    displayName: "GitHub",
    description: "Read and update GitHub repositories, issues, and pull requests.",
    iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
    builtIn: true,
    marketplace: { id: "github", publisher: "GitHub" },
    mcp: [{ id: "github", presetId: "github" }],
    skills: [
      {
        id: "github-workflow",
        title: "GitHub Workflow",
        description: "Use GitHub context for issues, PRs, and repository work.",
        triggerHints: ["GitHub issue", "pull request", "repo"],
        body: "When the user references a GitHub issue or pull request, fetch it before planning or editing.",
      },
    ],
    harnesses: standardHarnessSupport(),
  },
  {
    schemaVersion: 1,
    pluginId: "sentry",
    displayName: "Sentry",
    description: "Inspect Sentry issues, traces, and production error context.",
    iconUrl: "https://sentry.io/favicon.ico",
    builtIn: true,
    marketplace: { id: "sentry", publisher: "Sentry" },
    mcp: [{ id: "sentry", presetId: "sentry" }],
    skills: [
      {
        id: "sentry-debug",
        title: "Sentry Debugging",
        description: "Pull Sentry issue and trace context when debugging production errors.",
        triggerHints: ["Sentry", "production error", "stack trace"],
        body: "Use Sentry tools when the user mentions a Sentry issue, event, or production exception.",
      },
    ],
    harnesses: standardHarnessSupport(),
  },
];

type FirstPartyRemotePlugin = {
  pluginId: string;
  displayName: string;
  description: string;
  iconUrl: string;
  publisher: string;
  skillTitle: string;
  skillBody: string;
  triggerHints: string[];
};

const FIRST_PARTY_REMOTE_SPECS: FirstPartyRemotePlugin[] = [
  {
    pluginId: "stripe",
    displayName: "Stripe",
    description: "Inspect payments, customers, and Stripe documentation.",
    iconUrl: "https://stripe.com/favicon.ico",
    publisher: "Stripe",
    skillTitle: "Stripe Billing",
    skillBody:
      "Use Stripe tools when the user asks about charges, customers, invoices, or Stripe API behavior.",
    triggerHints: ["Stripe", "payment", "invoice"],
  },
  {
    pluginId: "atlassian",
    displayName: "Atlassian",
    description: "Jira issues, Confluence pages, and Bitbucket from Atlassian Cloud.",
    iconUrl: "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
    publisher: "Atlassian",
    skillTitle: "Atlassian Workflow",
    skillBody:
      "When the user references a Jira issue or Confluence page, fetch it before planning or editing.",
    triggerHints: ["Jira", "Confluence", "Atlassian"],
  },
  {
    pluginId: "huggingface",
    displayName: "Hugging Face",
    description: "Search models, datasets, and Spaces on the Hugging Face Hub.",
    iconUrl: "https://huggingface.co/favicon.ico",
    publisher: "Hugging Face",
    skillTitle: "Hugging Face Hub",
    skillBody:
      "Use Hugging Face tools when the user asks about models, datasets, inference, or Spaces.",
    triggerHints: ["Hugging Face", "model hub", "dataset"],
  },
  {
    pluginId: "neon",
    displayName: "Neon",
    description: "Manage Neon serverless Postgres projects and run SQL.",
    iconUrl: "https://neon.tech/favicon.ico",
    publisher: "Neon",
    skillTitle: "Neon Postgres",
    skillBody: "Use Neon tools for branches, SQL, and project status instead of guessing schema.",
    triggerHints: ["Neon", "Postgres", "database"],
  },
  {
    pluginId: "cloudflare",
    displayName: "Cloudflare",
    description: "Operate Cloudflare accounts, Workers, DNS, and related APIs.",
    iconUrl: "https://www.cloudflare.com/favicon.ico",
    publisher: "Cloudflare",
    skillTitle: "Cloudflare Ops",
    skillBody:
      "Use Cloudflare tools for Workers, DNS, KV, R2, and account diagnostics the user names.",
    triggerHints: ["Cloudflare", "Workers", "DNS"],
  },
  {
    pluginId: "vercel",
    displayName: "Vercel",
    description: "Inspect Vercel projects, deployments, and runtime logs.",
    iconUrl: "https://vercel.com/favicon.ico",
    publisher: "Vercel",
    skillTitle: "Vercel Deployments",
    skillBody: "Use Vercel tools when the user asks about a deployment, preview URL, or build log.",
    triggerHints: ["Vercel", "deployment", "preview"],
  },
  {
    pluginId: "supabase",
    displayName: "Supabase",
    description: "Query Supabase projects, tables, and auth configuration.",
    iconUrl: "https://supabase.com/favicon.ico",
    publisher: "Supabase",
    skillTitle: "Supabase Data",
    skillBody: "Use Supabase tools for schema, rows, and project settings instead of inventing SQL.",
    triggerHints: ["Supabase", "Postgres", "RLS"],
  },
  {
    pluginId: "hubspot",
    displayName: "HubSpot",
    description: "Read and update HubSpot CRM contacts, deals, and companies.",
    iconUrl: "https://www.hubspot.com/favicon.ico",
    publisher: "HubSpot",
    skillTitle: "HubSpot CRM",
    skillBody: "Use HubSpot tools when the user mentions contacts, deals, or CRM records.",
    triggerHints: ["HubSpot", "CRM", "deal"],
  },
];

const FIRST_PARTY_REMOTE_PLUGINS: AgentPluginDefinition[] = FIRST_PARTY_REMOTE_SPECS.map(
  (spec) => ({
    schemaVersion: 1,
    pluginId: spec.pluginId,
    displayName: spec.displayName,
    description: spec.description,
    iconUrl: spec.iconUrl,
    builtIn: true,
    marketplace: { id: spec.pluginId, publisher: spec.publisher },
    mcp: [{ id: spec.pluginId, presetId: spec.pluginId }],
    skills: [
      {
        id: `${spec.pluginId}-workflow`,
        title: spec.skillTitle,
        description: spec.description,
        triggerHints: spec.triggerHints,
        body: spec.skillBody,
      },
    ],
    harnesses: standardHarnessSupport(),
  })
);

export const BUILT_IN_AGENT_PLUGINS: AgentPluginDefinition[] = [
  ...CORE_BUILT_IN_AGENT_PLUGINS,
  ...FIRST_PARTY_REMOTE_PLUGINS,
];

export function listBuiltInAgentPlugins(): AgentPluginDefinition[] {
  return BUILT_IN_AGENT_PLUGINS;
}

export function getBuiltInAgentPlugin(pluginId: string): AgentPluginDefinition | null {
  return BUILT_IN_AGENT_PLUGINS.find((plugin) => plugin.pluginId === pluginId) ?? null;
}
