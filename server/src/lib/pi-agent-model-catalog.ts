import type { AgentConfigOption } from "./agents/types.js";
import {
  createPiModelRegistry,
  getPiAgentDir,
  hasPiAgentStoredAuthConfig,
} from "./pi-agent-settings.js";

export const PI_AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiAgentThinkingLevel = (typeof PI_AGENT_THINKING_LEVELS)[number];

export const PI_AGENT_TOOL_APPROVAL_OPTION_ID = "tool_approval";
export type PiAgentToolApprovalMode = "pi" | "mutations" | "all";

export function isPiAgentThinkingLevel(value: unknown): value is PiAgentThinkingLevel {
  return typeof value === "string" && (PI_AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

export function normalizePiAgentToolApprovalMode(value: unknown): PiAgentToolApprovalMode {
  return value === "mutations" || value === "all" ? value : "pi";
}

export function createPiAgentToolApprovalConfigOption(
  currentValue: PiAgentToolApprovalMode = "pi"
): AgentConfigOption {
  return {
    id: PI_AGENT_TOOL_APPROVAL_OPTION_ID,
    name: "Tool approval",
    category: "permission",
    description:
      "Cesium-side approval gate for Pi tool calls. Pi itself has no permission system - extensions decide - so the default matches the Pi CLI.",
    currentValue,
    options: [
      {
        value: "pi",
        name: "Pi default",
        description: "Run tools immediately; only extensions (e.g. permission gates) can block.",
      },
      {
        value: "mutations",
        name: "Ask for edits & commands",
        description: "Ask before bash, edit and write. Read-only tools run immediately.",
      },
      {
        value: "all",
        name: "Ask for every tool",
        description: "Ask before every built-in and extension tool call.",
      },
    ],
  };
}

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
      description: "Configure a Pi provider (OAuth, API key, or models.json) to load available models.",
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
    createPiAgentToolApprovalConfigOption(),
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

type CatalogModel = {
  value: string;
  name: string;
  provider: string;
  custom: boolean;
};

/**
 * Pick the model a fresh Pi conversation should start with. Order of
 * preference mirrors what the Pi CLI does on startup: the `defaultProvider` /
 * `defaultModel` pair from `settings.json`, then the user's own `models.json`
 * providers (someone who wired up a proxy or local server wants it used), then
 * the first available built-in model.
 */
export function selectPiAgentDefaultModel(
  models: CatalogModel[],
  settingsDefault?: { provider?: string; model?: string }
): string | undefined {
  if (models.length === 0) {
    return undefined;
  }
  if (settingsDefault?.provider && settingsDefault.model) {
    const preferred = `${settingsDefault.provider}/${settingsDefault.model}`;
    const match = models.find((model) => model.value === preferred);
    if (match) {
      return match.value;
    }
  }
  if (settingsDefault?.provider) {
    const match = models.find((model) => model.provider === settingsDefault.provider);
    if (match) {
      return match.value;
    }
  }
  return (models.find((model) => model.custom) ?? models[0])?.value;
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
    const { modelRegistry } = await createPiModelRegistry();
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");

    let models = modelRegistry.getAvailable();
    if (models.length === 0) {
      models = modelRegistry
        .getAll()
        .filter((model) => modelRegistry.hasConfiguredAuth(model));
    }

    // Providers whose credentials come from models.json (inline key, env name,
    // or shell command) are user-wired custom endpoints and get priority as the
    // default pick; Pi reports those as `models_json_*` / `fallback` sources.
    const customProviders = new Set<string>();
    for (const model of models) {
      const status = modelRegistry.getProviderAuthStatus(model.provider);
      if (
        status.source === "models_json_key" ||
        status.source === "models_json_command" ||
        status.source === "fallback"
      ) {
        customProviders.add(model.provider);
      }
    }

    const catalog: CatalogModel[] = models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      name: `${modelRegistry.getProviderDisplayName(model.provider)}/${model.name ?? model.id}`,
      provider: model.provider,
      custom: customProviders.has(model.provider),
    }));

    if (catalog.length === 0) {
      return createPiAgentFallbackConfigOptions();
    }

    let settingsDefault: { provider?: string; model?: string; thinking?: PiAgentThinkingLevel } = {};
    try {
      const settingsManager = SettingsManager.create(process.cwd(), getPiAgentDir());
      settingsDefault = {
        provider: settingsManager.getDefaultProvider(),
        model: settingsManager.getDefaultModel(),
        thinking: settingsManager.getDefaultThinkingLevel(),
      };
    } catch {
      // Pi settings unreadable - fall back to registry order.
    }

    const defaultModel = selectPiAgentDefaultModel(catalog, settingsDefault) ?? catalog[0]!.value;
    const modelOptions = catalog.map(({ value, name }) => ({ value, name }));

    const fallback = createPiAgentFallbackConfigOptions();
    return fallback.map((option) => {
      if (option.id === "model") {
        return {
          ...option,
          description: "Models reported by Pi ModelRegistry (auth.json, env, Cesium keys, models.json).",
          currentValue: defaultModel,
          options: modelOptions,
        };
      }
      if (option.id === "thinking_level" && settingsDefault.thinking) {
        return { ...option, currentValue: settingsDefault.thinking };
      }
      return option;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[agents] Pi Agent model list failed (fallback catalog):", detail);
    return createPiAgentFallbackConfigOptions();
  }
}
