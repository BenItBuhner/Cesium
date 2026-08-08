import type { CesiumFeatureModule, CesiumHarnessLimits, CesiumToolDefinition } from "../types.js";

export const SUBAGENTS_V2_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "read_subagent_transcript",
] as const;

/**
 * Codex MultiAgentV2-inspired collaboration tools.
 * Adapted for Cesium: plaintext mailbox (no encrypted tool args), path-addressed agents,
 * configurable wait timeouts, and a transcript reader for UI cards.
 */
export function createSubagentsV2Tools(limits: CesiumHarnessLimits): CesiumToolDefinition[] {
  const maxMinutes = Math.round(limits.waitAgentMaxTimeoutMs / 60_000);
  const defaultSeconds = Math.round(limits.waitAgentDefaultTimeoutMs / 1000);
  return [
    {
      name: "spawn_agent",
      description:
        "Spawn a collaborative subagent thread addressed by a canonical path (e.g. /root/explore_auth). Returns immediately; the child runs in the background. Use wait_agent to poll for mailbox updates, followup_task to assign more work, and send_message to queue context without starting a turn. Children are equally capable agents sharing your workspace tools (read_file, grep, write_file, edit_file, terminal, call_mcp_tool, browser_*) plus the collaboration tools, and can spawn their own sub-agents up to the configured spawn depth. Screenshots and demo recordings they capture are saved under artifacts/browser/.",
      parameters: {
        type: "object",
        properties: {
          task_name: {
            type: "string",
            description:
              "Short snake_case identifier for this child. Becomes the path segment under the parent (e.g. explore_auth → /root/explore_auth).",
          },
          message: {
            type: "string",
            description: "Initial task instructions delivered to the child and executed as its first turn.",
          },
          title: {
            type: "string",
            description: "Optional human-readable nickname shown in the UI.",
          },
          modelId: {
            type: "string",
            description: "Optional model override for the child (provider/model).",
          },
          fork_turns: {
            type: "string",
      description:
        'Context inheritance: "all" (full-history fork, default — Codex MultiAgentV2 parity), "none" (fresh child), or a positive integer string for a partial fork of the most recent turns.',
          },
        },
        required: ["task_name", "message"],
        additionalProperties: false,
      },
    },
    {
      name: "send_message",
      description:
        "Queue a mailbox message to an existing agent without triggering a turn. Use followup_task when the child should act on the message.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Agent path or task_name from spawn_agent / list_agents.",
          },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
    },
    {
      name: "followup_task",
      description:
        "Send a task to an existing subagent and trigger a turn if it is idle. Prefer reusing agents when work depends on prior child context.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Agent path or task_name from spawn_agent / list_agents.",
          },
          message: { type: "string" },
        },
        required: ["target", "message"],
        additionalProperties: false,
      },
    },
    {
      name: "wait_agent",
      description:
        `Wait for a mailbox update from any live subagent (queued messages or final-status notifications). Does not return full content — returns a short summary and whether the wait timed out. Prefer short polls (30–60s) when you can keep working; use longer waits only when blocked. Default ${defaultSeconds}s; max ${maxMinutes} minutes (configurable in Cesium Agent settings).`,
      parameters: {
        type: "object",
        properties: {
          timeout_ms: {
            type: "number",
            description: `Milliseconds to wait. Omit to use the configured default (${limits.waitAgentDefaultTimeoutMs}). Must be between ${limits.waitAgentMinTimeoutMs} and ${limits.waitAgentMaxTimeoutMs}.`,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "interrupt_agent",
      description:
        "Interrupt a running subagent's current turn. The agent remains addressable for followup_task / send_message.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Agent path or task_name to interrupt.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      name: "list_agents",
      description:
        "List live collaborative subagents and their statuses. Optionally filter by path_prefix.",
      parameters: {
        type: "object",
        properties: {
          path_prefix: {
            type: "string",
            description: "Optional path prefix filter (e.g. /root/).",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "read_subagent_transcript",
      description:
        "Read the transcript of a collaborative subagent (by agent path, task_name, or id). In Orchestration Mode, use orchestration_read_agent_transcript for kanban child agents.",
      parameters: {
        type: "object",
        properties: {
          subagentId: {
            type: "string",
            description: "Agent path, task_name, or id from spawn_agent / list_agents.",
          },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["subagentId"],
        additionalProperties: false,
      },
    },
  ];
}

export function createSubagentsV2Module(limits: CesiumHarnessLimits): CesiumFeatureModule {
  const tools = createSubagentsV2Tools(limits);
  return {
    id: "subagents",
    version: 2,
    label: "Subagents V2",
    description:
      "Codex-inspired collaborative subagents: path-addressed threads, mailbox messaging, wait_agent polling, and interrupt/follow-up control.",
    tools,
    toolNames: tools.map((tool) => tool.name),
    reminder:
      "Subagents V2 is active. Prefer spawn_agent + wait_agent + followup_task for parallel collaborative work. " +
      "Spawn returns immediately; poll with wait_agent using short timeouts when you can keep working. " +
      "Agents address each other by path (e.g. /root/task_name). Do not use the legacy `subagent` tool — it is not registered in V2. " +
      "Children are equally capable agents: they share your workspace tool surface (files, terminal, MCP, browser) and all agents share the same filesystem and working directory, so edits by one agent are immediately visible to the others. " +
      "Children can test sites, take screenshots, and record demo videos (saved under artifacts/browser/); have them report artifact file paths in their summaries, then verify with read_file (images attach for vision models). " +
      "When parallel workstreams must touch files, give each its own worktree branch (`create_worktree`), point the work at that path, then merge verified branches back and clean up.",
  };
}
