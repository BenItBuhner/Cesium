import type { AgentPluginDefinition } from "./types.js";
import { standardHarnessSupport } from "./harness-support.js";

export const BUILT_IN_AGENT_PLUGINS: AgentPluginDefinition[] = [
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

export function listBuiltInAgentPlugins(): AgentPluginDefinition[] {
  return BUILT_IN_AGENT_PLUGINS;
}

export function getBuiltInAgentPlugin(pluginId: string): AgentPluginDefinition | null {
  return BUILT_IN_AGENT_PLUGINS.find((plugin) => plugin.pluginId === pluginId) ?? null;
}
