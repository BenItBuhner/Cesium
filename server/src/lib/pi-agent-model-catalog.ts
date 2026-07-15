import type { AgentConfigOption } from "./agents/types.js";
import {
  applyPiRuntimeApiKeys,
  createPiAuthStorage,
  getPiAgentModelsPath,
  hasPiAgentStoredAuthConfig,
} from "./pi-agent-settings.js";

export function createPiAgentFallbackConfigOptions(): AgentConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "agent",
      options: [{ value: "agent", name: "Agent" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "auto",
      description: "Configure a Pi provider (OAuth or API key) to load available models.",
      options: [{ value: "auto", name: "Auto" }],
    },
    {
      id: "thinking_level",
      name: "Thinking",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "off", name: "Off" },
        { value: "minimal", name: "Minimal" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ],
    },
  ];
}

export function isPiAgentPlaceholderModelCatalog(
  configOptions: AgentConfigOption[]
): boolean {
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption || modelOption.options.length === 0) {
    return true;
  }
  if (modelOption.options.length > 1) {
    return false;
  }
  const only = modelOption.options[0]?.value.trim().toLowerCase();
  return only === "auto" || only === "__default__";
}

export function hasPiAgentRichModelCatalog(configOptions: AgentConfigOption[]): boolean {
  return !isPiAgentPlaceholderModelCatalog(configOptions);
}

/**
 * Load Pi ModelRegistry options for harness cache + model toggles.
 * Mirrors settings-page discovery (refresh + getAvailable, with getAll fallback).
 */
export async function buildPiAgentSeedConfigOptions(): Promise<AgentConfigOption[]> {
  if (!(await hasPiAgentStoredAuthConfig())) {
    return createPiAgentFallbackConfigOptions();
  }

  try {
    const authStorage = await createPiAuthStorage();
    await applyPiRuntimeApiKeys(authStorage);
    const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
    modelRegistry.refresh();

    let models = modelRegistry.getAvailable();
    if (models.length === 0) {
      models = modelRegistry
        .getAll()
        .filter((model) => modelRegistry.hasConfiguredAuth(model));
    }

    const modelOptions = models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      name: `${modelRegistry.getProviderDisplayName(model.provider)}/${model.name ?? model.id}`,
    }));

    if (modelOptions.length === 0) {
      return createPiAgentFallbackConfigOptions();
    }

    const fallback = createPiAgentFallbackConfigOptions();
    return fallback.map((option) =>
      option.id === "model"
        ? {
            ...option,
            description: "Models reported by Pi ModelRegistry.",
            currentValue: modelOptions[0]?.value ?? "auto",
            options: modelOptions,
          }
        : option
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[agents] Pi Agent model list failed (fallback catalog):", detail);
    return createPiAgentFallbackConfigOptions();
  }
}
