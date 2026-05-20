export type CesiumProviderKind = "openai-chat-completions" | "openai-responses" | "openai-realtime" | "anthropic" | "google-genai" | "openai-compatible";
export type CesiumToolName = "read_file" | "grep" | "edit_file" | "terminal" | "todo" | "ask_question" | "subagent" | "read_subagent_transcript" | "search_history" | "read_history_page";
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
    contextWindow?: number;
    outputLimit?: number;
};
export declare const CESIUM_BACKEND_ID: "cesium-agent";
export declare const CESIUM_BACKEND_LABEL = "Cesium Agent (Beta)";
export declare const CESIUM_DEFAULT_MODEL_ID = "openai/gpt-5.1";
export declare const CESIUM_DEFAULT_MODEL_NAME = "OpenAI/GPT-5.1";
export declare const CESIUM_SYSTEM_PROMPT: string;
export declare const CESIUM_CONTEXT_TURN_LIMIT = 250;
export declare const CESIUM_CONTEXT_EVENT_LIMIT = 20000;
export declare const CESIUM_TOOL_DEFINITIONS: CesiumToolDefinition[];
//# sourceMappingURL=agent-harness.d.ts.map
