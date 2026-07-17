import { createSubagentsV1Module } from "./v1-tools.js";
import { createSubagentsV2Module } from "./v2-tools.js";
import type { CesiumFeatureModule, CesiumHarnessLimits, CesiumSubagentsVersion } from "../types.js";

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
