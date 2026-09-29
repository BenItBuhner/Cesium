import { buildCesiumBaseSystemPrompt, buildCesiumSystemPrompt } from "./mcp";
import type { AgentPermissionCategory } from "./protocol";

export type CesiumProviderKind =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-realtime"
  | "anthropic"
  | "google-genai"
  | "openai-compatible";

export type CesiumToolName =
  | "read_file"
  | "grep"
  | "edit_file"
  | "terminal"
  | "wait"
  | "todo"
  | "create_plan"
  | "update_plan"
  | "read_plan"
  | "finalize_plan"
  | "goal_set"
  | "goal_pause"
  | "goal_summarize"
  | "goal_get"
  | "goal_update_plan"
  | "goal_update_progress"
  | "goal_summarize_state"
  | "goal_complete"
  | "goal_block"
  | "goal_resume"
  | "ask_question"
  | "subagent"
  | "read_subagent_transcript"
  | "search_history"
  | "read_history_page"
  | "call_mcp_tool"
  | "refresh_mcp_servers";

export type CesiumToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Permission category when the tool should prompt / honor auto-allow rules. */
  requiresPermission?: AgentPermissionCategory;
};

export type CesiumModelCatalogEntry = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  apiKind: CesiumProviderKind;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  /** Vision / multimodal image prompt support when advertised by the catalog. */
  supportsImages?: boolean;
  contextWindow?: number;
  outputLimit?: number;
};

export const CESIUM_BACKEND_ID = "cesium-agent" as const;
export const CESIUM_BACKEND_LABEL = "Cesium Agent (Beta)";
export const CESIUM_DEFAULT_MODEL_ID = "openai/gpt-5.1";
export const CESIUM_DEFAULT_MODEL_NAME = "OpenAI/GPT-5.1";

/** @deprecated Use buildCesiumBaseSystemPrompt() plus dynamic system reminders. */
export const CESIUM_SYSTEM_PROMPT = buildCesiumBaseSystemPrompt();
export { buildCesiumBaseSystemPrompt, buildCesiumSystemPrompt };

export const CESIUM_CONTEXT_TURN_LIMIT = 250;
export const CESIUM_CONTEXT_EVENT_LIMIT = 20_000;
