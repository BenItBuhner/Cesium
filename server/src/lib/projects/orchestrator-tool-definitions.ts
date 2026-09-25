import type { CesiumToolDefinition } from "../agents/cesium/features/types.js";

const KIND = "orchestration";

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

const AGENT_REF = {
  type: "string",
  description: "Agent name (as listed by project_list_agents) or agent id.",
};

/**
 * The Project orchestrator's entire tool surface besides `ask_question`. It
 * manages agents and Project context; it never touches repositories itself.
 */
export const PROJECT_ORCHESTRATOR_TOOLS: CesiumToolDefinition[] = [
  {
    name: "project_list_engines",
    kind: KIND,
    title: "List engines",
    description:
      "List the engines (machines) this Project can place agents on, with the repositories bound on each and the agent harnesses available there. Call before creating agents on another engine or harness.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_create_agent",
    kind: KIND,
    title: (args) => `Create agent ${str(args, "name")}`.trim(),
    description:
      "Create a child agent and start it on its first task immediately. Instructions must be self-contained: goal, constraints, where to work, what done means, and what to report. Omit engine/harness/model to use the Project defaults; give `repo` to work inside a bound repository (its engine is implied), otherwise the agent gets an empty scratch folder.",
    parameters: {
      type: "object",
      required: ["name", "instructions"],
      properties: {
        name: {
          type: "string",
          description: "Short handle, e.g. api-tests. Lowercase letters, digits and dashes.",
        },
        instructions: { type: "string", description: "The agent's first task, in full." },
        repo: { type: "string", description: "Repository name or id from project_list_engines." },
        engine: {
          type: "string",
          description: "Engine id or label from project_list_engines, for scratch work on that machine. Default: home.",
        },
        harness: {
          type: "string",
          description: "Agent harness id (e.g. cesium-agent, codex-app-server). Default: Project default.",
        },
        model: {
          type: "string",
          description: "Model id for the harness. Default: the Project default on home, the engine's harness default elsewhere.",
        },
        mode: { type: "string", description: "Harness mode, e.g. agent or plan. Default: agent." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_list_agents",
    kind: KIND,
    title: (args) => (str(args, "agent") ? `Check ${str(args, "agent")}` : "List agents"),
    description:
      "Live status of the Project's agents: status bucket, engine, harness, model, repo, queued messages, last reply preview, and anything waiting on a human. Pass `agent` for one agent.",
    parameters: {
      type: "object",
      properties: {
        agent: AGENT_REF,
        include_deleted: { type: "boolean", description: "Also list deleted agents." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_steer_agent",
    kind: KIND,
    title: (args) => `Steer ${str(args, "agent")}`.trim(),
    description:
      "Redirect an agent. If it is working, the message is injected into its current turn when the harness supports that (otherwise it runs right after the current turn); if idle, it starts a turn now. Returns how it landed: mid_turn, queued_steer, queued, or started.",
    parameters: {
      type: "object",
      required: ["agent", "message"],
      properties: { agent: AGENT_REF, message: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "project_queue_agent",
    kind: KIND,
    title: (args) => `Queue for ${str(args, "agent")}`.trim(),
    description:
      "Give an agent its next task. Runs after its current turn and anything already queued; starts now if it is idle.",
    parameters: {
      type: "object",
      required: ["agent", "message"],
      properties: { agent: AGENT_REF, message: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "project_stop_agent",
    kind: KIND,
    title: (args) => `Stop ${str(args, "agent")}`.trim(),
    description:
      "Stop an agent's current turn and clear its queued messages. The agent stays in the Project and can be steered or queued again.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: { agent: AGENT_REF },
      additionalProperties: false,
    },
  },
  {
    name: "project_update_agent",
    kind: KIND,
    title: (args) => `Update ${str(args, "agent")}`.trim(),
    description: "Rename an agent or change its model or mode. Takes effect on its next turn.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: AGENT_REF,
        name: { type: "string", description: "New handle." },
        model: { type: "string" },
        mode: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_delete_agent",
    kind: KIND,
    title: (args) => `Delete ${str(args, "agent")}`.trim(),
    description:
      "Stop an agent and permanently delete its conversation. Use when its work is finished or abandoned; read its transcript first if you still need anything from it.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: { agent: AGENT_REF },
      additionalProperties: false,
    },
  },
  {
    name: "project_read_transcript",
    kind: KIND,
    title: (args) =>
      str(args, "agent") ? `Read ${str(args, "agent")} transcript` : "Read transcript",
    description:
      "Read an agent's recent conversation: its messages, replies, tool calls and failures for the last `turns` turns (default 3, max 20). Long transcripts keep the most recent part.",
    parameters: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: AGENT_REF,
        turns: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_context_list",
    kind: KIND,
    title: "List Project context",
    description:
      "List the files in the Project context folder (notes.md plus any specs, reports or checklists you keep there).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project_context_read",
    kind: KIND,
    title: (args) => `Read ${str(args, "path") || "context file"}`,
    description: "Read a text file from the Project context folder.",
    parameters: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", description: "Relative path, e.g. notes.md." } },
      additionalProperties: false,
    },
  },
  {
    name: "project_context_write",
    kind: KIND,
    title: (args) => `Write ${str(args, "path") || "context file"}`,
    description:
      "Create, replace or append to a text file in the Project context folder. Keep notes.md current: goals, decisions, agent roster and status, open questions.",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", description: "Relative path, e.g. notes.md or specs/api.md." },
        content: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"], description: "Default: replace." },
      },
      additionalProperties: false,
    },
  },
];

export const PROJECT_ORCHESTRATOR_TOOL_NAMES = new Set(
  PROJECT_ORCHESTRATOR_TOOLS.map((tool) => tool.name)
);

/** Tools the orchestrator borrows from the ordinary harness surface. */
export const PROJECT_ORCHESTRATOR_BORROWED_TOOLS = ["ask_question"] as const;

export const PROJECT_ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the orchestrator of a Cesium Project: a long-running body of work that you direct through child agents.",
  "You do not write code, run commands or edit repositories yourself, and you have no tools for that. You plan, delegate, monitor, correct and report.",
  "",
  "How you work:",
  "- Break the user's goal into well-scoped tasks and give each one to a child agent with project_create_agent. Instructions must stand on their own: the goal, where to work, constraints, what done means, and what to report back.",
  "- Children run on their own harness and may live on other engines (machines). Check project_list_engines before placing work on another engine, repository or harness.",
  "- You are told automatically when a child finishes a turn, fails, stops, or needs a human. Those reports arrive as <project_agent_updates> messages. Do not poll; end your turn and wait for them.",
  "- Use project_steer_agent to correct a child that is working now (it lands mid-turn when the harness supports it). Use project_queue_agent to hand a child its next task.",
  "- Read a transcript with project_read_transcript when a reply preview is not enough to judge the work. Check claims before reporting them as done.",
  "- Stop children that go off track. Delete children whose work is finished and no longer needed.",
  "- Keep notes.md in the Project context current: goals, decisions, the agent roster with status, and open questions. Put longer specs or reports in other context files.",
  "- When the user has to decide something, use ask_question or say so plainly.",
  "- Reply to the user briefly: what you delegated and to whom, what came back, and what happens next.",
].join("\n");
