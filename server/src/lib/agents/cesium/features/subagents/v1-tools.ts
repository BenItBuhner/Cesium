import type { CesiumFeatureModule, CesiumToolDefinition } from "../types.js";

export const SUBAGENTS_V1_TOOL_NAMES = ["subagent", "read_subagent_transcript"] as const;

export const SUBAGENTS_V1_TOOLS: CesiumToolDefinition[] = [
  {
    name: "subagent",
    description:
      "Start an ephemeral in-session research subagent (not a kanban child agent). Stores a transcript card keyed by subagentId for read_subagent_transcript.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        instructions: { type: "string" },
        modelId: { type: "string" },
        wait: { type: "boolean" },
        allowedTools: { type: "array" },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "read_subagent_transcript",
    description:
      "Read the transcript of an ephemeral subagent started with the subagent tool (subagentId from that card). In Orchestration Mode, use orchestration_read_agent_transcript for kanban child agents assigned via orchestration_assign_agent.",
    parameters: {
      type: "object",
      properties: {
        subagentId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["subagentId"],
      additionalProperties: false,
    },
  },
];

export function createSubagentsV1Module(): CesiumFeatureModule {
  return {
    id: "subagents",
    version: 1,
    label: "Subagents V1",
    description:
      "Classic ephemeral subagent tool: single-shot research child with transcript card. Simple and blocking.",
    tools: SUBAGENTS_V1_TOOLS,
    toolNames: [...SUBAGENTS_V1_TOOL_NAMES],
    reminder:
      "Subagents V1 is active. Use `subagent` for ephemeral research children and `read_subagent_transcript` to inspect their cards. For durable kanban children use Orchestration Mode tools.",
  };
}
