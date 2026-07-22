import { buildCesiumBaseSystemPrompt, buildCesiumSystemPrompt } from "./mcp";

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
  | "burn_goal_set"
  | "burn_goal_pause"
  | "burn_goal_summarize"
  | "burn_goal_get"
  | "burn_goal_update_plan"
  | "burn_goal_update_progress"
  | "burn_goal_summarize_state"
  | "burn_goal_complete"
  | "burn_goal_block"
  | "burn_goal_resume"
  | "ask_question"
  | "subagent"
  | "read_subagent_transcript"
  | "search_history"
  | "read_history_page"
  | "call_mcp_tool"
  | "refresh_mcp_servers";

export type CesiumToolDefinition = {
  name: CesiumToolName;
  description: string;
  parameters: Record<string, unknown>;
  requiresPermission?: boolean;
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

export const CESIUM_TOOL_DEFINITIONS: CesiumToolDefinition[] = [
  {
    name: "read_file",
    description: "Read all or part of a workspace file, with pagination for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description: "Search workspace files by regular expression and optional context lines.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        context: { type: "number" },
        maxResults: { type: "number" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "edit_file",
    description: "Apply a precise before/after edit to a file and return an edit preview.",
    requiresPermission: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  {
    name: "terminal",
    description: "Run a command in the workspace, optionally waiting for completion or backgrounding it.",
    requiresPermission: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        waitUntil: { type: "string", enum: ["complete", "background", "pattern"] },
        pattern: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "wait",
    description:
      "Pause this agent for a fixed number of seconds before continuing. Prefer this over shell sleep for timed delays.",
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "number" },
        reason: { type: "string" },
      },
      required: ["seconds"],
    },
  },
  {
    name: "todo",
    description: "Create, update, or read the working todo list for the current conversation.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "replace", "patch"] },
        items: {
          type: "array",
          description:
            "Todo items with status pending, in_progress, blocked, or completed. Use blocked only when a material blocker prevents further progress.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "ask_question",
    description: "Ask the user one or more structured questions with selectable options.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        options: { type: "array" },
        allowMultiple: { type: "boolean" },
        allow_multiple: { type: "boolean" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              title: { type: "string" },
              options: { type: "array" },
              allowMultiple: { type: "boolean" },
              allow_multiple: { type: "boolean" },
            },
            required: ["options"],
          },
        },
      },
    },
  },
  {
    name: "subagent",
    description: "Launch a child Cesium agent with selected model, permissions, instructions, and wait mode.",
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
    },
  },
  {
    name: "read_subagent_transcript",
    description:
      "Read a paginated transcript for an ephemeral subagent started with the subagent tool. In Orchestration Mode, use orchestration_read_agent_transcript for kanban child agents.",
    parameters: {
      type: "object",
      properties: {
        subagentId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["subagentId"],
    },
  },
  {
    name: "search_history",
    description: "Search compressed or older conversation history for relevant context.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_history_page",
    description: "Read a bounded page of older conversation history.",
    parameters: {
      type: "object",
      properties: {
        beforeSeq: { type: "number" },
        limitTurns: { type: "number" },
      },
      required: ["beforeSeq"],
    },
  },
  {
    name: "call_mcp_tool",
    description:
      "Invoke a tool on a connected MCP server. Read mcp-servers/<serverId>/tools/ first to learn tool names and schemas.",
    requiresPermission: true,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["serverId", "toolName"],
    },
  },
  {
    name: "refresh_mcp_servers",
    description:
      "Reconnect enabled MCP servers and regenerate the mcp-servers/ discovery mirror in the workspace.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];
