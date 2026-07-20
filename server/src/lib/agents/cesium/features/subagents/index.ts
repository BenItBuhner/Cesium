import { createSubagentsV1Module } from "./v1-tools.js";
import { createSubagentsV2Module } from "./v2-tools.js";
import type {
  CesiumFeatureDefinition,
  CesiumFeatureModule,
  CesiumHarnessLimits,
  CesiumSubagentsVersion,
} from "../types.js";

export { SUBAGENTS_V1_TOOL_NAMES, SUBAGENTS_V1_TOOLS, createSubagentsV1Module } from "./v1-tools.js";
export {
  SUBAGENTS_V2_TOOL_NAMES,
  createSubagentsV2Tools,
  createSubagentsV2Module,
} from "./v2-tools.js";
export { SubagentsV2Runtime } from "./v2-runtime.js";
export type {
  SubagentsV2Agent,
  SubagentsV2AgentStatus,
  SubagentsV2MailboxMessage,
  SubagentsV2SpawnResult,
  SubagentsV2WaitResult,
} from "./v2-runtime.js";

export const SUBAGENTS_FEATURE_DEFINITION: CesiumFeatureDefinition = {
  id: "subagents",
  label: "Subagents",
  description:
    "Delegation engine used to hand focused work to child agents while the parent coordinates.",
  defaultVersion: 1,
  versions: [
    {
      version: 1,
      label: "V1 — ephemeral task delegation",
      description: "Launch one isolated subagent and read its transcript.",
      resolve: () => createSubagentsV1Module(),
    },
    {
      version: 2,
      label: "V2 — collaborative agent tree",
      description: "Spawn, wait, message, follow up, and interrupt persistent child agents.",
      resolve: (limits) => createSubagentsV2Module(limits),
    },
  ],
};

export function resolveSubagentsModule(
  version: CesiumSubagentsVersion,
  limits: CesiumHarnessLimits
): CesiumFeatureModule {
  return version === 2 ? createSubagentsV2Module(limits) : createSubagentsV1Module();
}

export function isSubagentsV2ToolName(name: string): boolean {
  return (
    name === "spawn_agent" ||
    name === "send_message" ||
    name === "followup_task" ||
    name === "wait_agent" ||
    name === "interrupt_agent" ||
    name === "list_agents"
  );
}

export function isSubagentsV1ToolName(name: string): boolean {
  return name === "subagent" || name === "read_subagent_transcript";
}
