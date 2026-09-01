/**
 * The browser machine exposes exactly one agent backend: the first-party
 * Cesium Agent, executed in-page. Capabilities mirror the server's
 * `AGENT_CAPABILITIES["cesium-agent"]` literal.
 */
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentProviderCapabilities,
} from "@cesium/core";
import {
  CESIUM_BACKEND_ID,
  CESIUM_BACKEND_LABEL,
  CESIUM_DEFAULT_MODEL_ID,
  CESIUM_DEFAULT_MODEL_NAME,
} from "@cesium/core";

export const CESIUM_AGENT_CAPABILITIES: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
  supportsCompletionRetry: true,
  supportsCloudExecution: false,
};

export type ModelChoice = {
  id: string;
  name: string;
};

export function buildConfigOptions(input: {
  mode: string;
  modelId: string;
  models: ModelChoice[];
}): AgentConfigOption[] {
  const modelValues = input.models.length
    ? input.models
    : [{ id: input.modelId, name: input.modelId }];
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: input.mode,
      options: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
        { value: "ask", name: "Ask" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: input.modelId,
      options: modelValues.map((model) => ({ value: model.id, name: model.name })),
    },
  ];
}

export function buildBrowserBackendInfo(defaults?: {
  modelId?: string | null;
  modelName?: string | null;
  available?: boolean;
}): AgentBackendInfo {
  const defaultModelId = defaults?.modelId || CESIUM_DEFAULT_MODEL_ID;
  const defaultModelName = defaults?.modelName || defaults?.modelId || CESIUM_DEFAULT_MODEL_NAME;
  return {
    id: CESIUM_BACKEND_ID,
    label: CESIUM_BACKEND_LABEL,
    description:
      "First-party Cesium agent running entirely in this browser tab against the virtual workspace.",
    available: defaults?.available ?? true,
    enabled: true,
    defaultMode: "agent",
    defaultModelId,
    defaultModelName,
    capabilities: CESIUM_AGENT_CAPABILITIES,
  };
}
