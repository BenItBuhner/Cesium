import type { AgentBackendId } from "../agents/types.js";
import type { AgentPluginDefinition, AgentPluginHarnessSupport } from "./types.js";

const ALL_NATIVE_MCP_BACKENDS: AgentBackendId[] = [
  "cesium-agent",
  "cursor-sdk",
  "claude-code-sdk",
  "gemini-acp",
  "devin-acp",
  "codex-app-server",
  "opencode-server",
  "google-antigravity-cli",
  "pi-agent",
];

function support(
  backendId: AgentBackendId,
  nativeMcp: boolean,
  notes?: string
): AgentPluginHarnessSupport {
  return {
    backendId,
    nativeMcp,
    promptSkills: true,
    notes,
  };
}

function standardHarnessSupport(): AgentPluginDefinition["harnesses"] {
  return Object.fromEntries(
    ALL_NATIVE_MCP_BACKENDS.map((backendId) => [
      backendId,
      support(
        backendId,
        backendId !== "codex-app-server",
        backendId === "codex-app-server"
          ? "Codex app server receives plugin skills and MCP mirror instructions when native MCP is unavailable."
          : undefined
      ),
    ])
  ) as AgentPluginDefinition["harnesses"];
}

export const BUILT_IN_AGENT_PLUGINS: AgentPluginDefinition[] = [
  {
    schemaVersion: 1,
    pluginId: "context7",
    displayName: "Context7",
    description: "Fetch current documentation and code examples for libraries and frameworks.",
    iconUrl: "https://context7.com/favicon.ico",
    builtIn: true,
    marketplace: { publisher: "Context7" },
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
    marketplace: { publisher: "Linear" },
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
    marketplace: { publisher: "Notion" },
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
    marketplace: { publisher: "Figma" },
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
    marketplace: { publisher: "Slack" },
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
    marketplace: { publisher: "Todoist" },
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
];

export function listBuiltInAgentPlugins(): AgentPluginDefinition[] {
  return BUILT_IN_AGENT_PLUGINS;
}

export function getBuiltInAgentPlugin(pluginId: string): AgentPluginDefinition | null {
  return BUILT_IN_AGENT_PLUGINS.find((plugin) => plugin.pluginId === pluginId) ?? null;
}
