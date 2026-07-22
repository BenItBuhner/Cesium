import type {
  AgentConfigOption,
  AgentConfigOptionCategory,
  AgentConversationMode,
} from "./types.js";
import { configOptionMatchesCategory } from "./config-option-utils.js";

export const LEGACY_MODE_CONFIG_ID = "__acp_legacy_mode__";
export const LEGACY_MODEL_CONFIG_ID = "__acp_legacy_model__";

function parseConfigOptionCategory(value: unknown): AgentConfigOptionCategory {
  if (
    value === "mode" ||
    value === "model" ||
    value === "thought_level" ||
    value === "permission" ||
    value === "other"
  ) {
    return value;
  }
  return "other";
}

export function parseConfigOptionString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function inferConfigOptionCategory(
  record: Record<string, unknown>,
  id: string,
  name: string
): AgentConfigOptionCategory {
  const direct = parseConfigOptionCategory(record.category);
  if (direct !== "other") {
    return direct;
  }
  const lowerId = id.toLowerCase();
  const lowerName = name.toLowerCase();
  if (
    lowerId.includes("thought") ||
    lowerName.includes("thought") ||
    lowerId.includes("reasoning") ||
    lowerName.includes("reasoning") ||
    lowerId.includes("effort") ||
    lowerName.includes("effort") ||
    lowerId.includes("thinking") ||
    lowerName.includes("thinking") ||
    lowerId.includes("speed") ||
    lowerName.includes("speed") ||
    lowerId.includes("tier") ||
    lowerName.includes("tier")
  ) {
    return "thought_level";
  }
  if (
    lowerId === "mode" ||
    lowerId.endsWith("mode") ||
    lowerName.includes("mode") ||
    lowerName.includes("agent")
  ) {
    return "mode";
  }
  if (
    lowerId === "model" ||
    lowerId.endsWith("model") ||
    lowerName.includes("model")
  ) {
    return "model";
  }
  if (lowerId.includes("permission") || lowerName.includes("permission")) {
    return "permission";
  }
  return "other";
}

function resolveConfigOptionCurrentValue(
  record: Record<string, unknown>,
  options: AgentConfigOption["options"]
): string {
  const directKeys = ["currentValue", "selectedValue", "value", "defaultValue"];
  for (const key of directKeys) {
    const candidate = parseConfigOptionString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  const rawOptions = Array.isArray(record.options)
    ? record.options
    : Array.isArray(record.values)
      ? record.values
      : Array.isArray(record.items)
        ? record.items
        : [];
  for (const rawOption of rawOptions) {
    if (!rawOption || typeof rawOption !== "object") {
      continue;
    }
    const optionRecord = rawOption as Record<string, unknown>;
    if (
      optionRecord.selected === true ||
      optionRecord.current === true ||
      optionRecord.active === true ||
      optionRecord.default === true
    ) {
      const selectedValue =
        parseConfigOptionString(optionRecord.value) ||
        parseConfigOptionString(optionRecord.id) ||
        parseConfigOptionString(optionRecord.key);
      if (selectedValue) {
        return selectedValue;
      }
    }
  }

  return options[0]?.value ?? "";
}

export function normalizeProviderMode(
  rawValue: string | undefined,
  fallback: AgentConversationMode
): AgentConversationMode {
  const normalized = rawValue?.trim();
  return normalized ? (normalized as AgentConversationMode) : fallback;
}

export function parseConfigOptions(raw: unknown): AgentConfigOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: AgentConfigOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = parseConfigOptionString(record.id);
    const name =
      parseConfigOptionString(record.name) ||
      parseConfigOptionString(record.label) ||
      id;
    if (!id) {
      continue;
    }
    const options: AgentConfigOption["options"] = [];
    const rawOptions = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : Array.isArray(record.items)
          ? record.items
          : [];
    if (rawOptions.length > 0) {
      for (const option of rawOptions) {
        if (!option || typeof option !== "object") {
          continue;
        }
        const optionRecord = option as Record<string, unknown>;
        const value =
          parseConfigOptionString(optionRecord.value) ||
          parseConfigOptionString(optionRecord.id) ||
          parseConfigOptionString(optionRecord.key);
        const optionName =
          parseConfigOptionString(optionRecord.name) ||
          parseConfigOptionString(optionRecord.label) ||
          value;
        if (!value || !optionName) {
          continue;
        }
        options.push({
          value,
          name: optionName,
          description:
            typeof optionRecord.description === "string"
              ? optionRecord.description
              : undefined,
        });
      }
    }
    const currentValue = resolveConfigOptionCurrentValue(record, options);
    parsed.push({
      id,
      name,
      description:
        typeof record.description === "string" ? record.description : undefined,
      category: inferConfigOptionCategory(record, id, name),
      currentValue,
      options,
    });
  }
  return parsed;
}

export function parseLegacySessionConfigOptions(
  session: Record<string, unknown>
): AgentConfigOption[] {
  const parsed: AgentConfigOption[] = [];

  const rawModes =
    session.modes && typeof session.modes === "object"
      ? (session.modes as Record<string, unknown>)
      : null;
  if (rawModes && Array.isArray(rawModes.availableModes)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModes.availableModes) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.modeId);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODE_CONFIG_ID,
        name: "Mode",
        category: "mode",
        currentValue:
          parseConfigOptionString(rawModes.currentModeId) || options[0]?.value || "",
        options,
      });
    }
  }

  const rawModels =
    session.models && typeof session.models === "object"
      ? (session.models as Record<string, unknown>)
      : null;
  if (rawModels && Array.isArray(rawModels.availableModels)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModels.availableModels) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.modelId) ||
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.value);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        currentValue:
          parseConfigOptionString(rawModels.currentModelId) || options[0]?.value || "",
        options,
      });
    }
  }

  return parsed;
}

export function mergeSessionConfigOptions(
  configOptions: AgentConfigOption[],
  legacyOptions: AgentConfigOption[]
): AgentConfigOption[] {
  const merged = [...configOptions];
  for (const option of legacyOptions) {
    if (
      merged.some((existing) => existing.id === option.id) ||
      merged.some((existing) => configOptionMatchesCategory(existing, option.category))
    ) {
      continue;
    }
    merged.push(option);
  }
  return merged;
}

export function normalizeConversationModeForProvider(
  requested: AgentConversationMode,
  option: AgentConfigOption | undefined
): string | null {
  if (!option) {
    return null;
  }
  const req = typeof requested === "string" ? requested.trim() : "";
  if (option.options.some((value) => value.value === requested)) {
    return requested;
  }
  const requestedLower = req.toLowerCase();
  const caseMatch = option.options.find((v) => v.value.toLowerCase() === requestedLower);
  if (caseMatch) {
    return caseMatch.value;
  }
  const rawCandidates =
    requestedLower === "agent" || requestedLower === "code"
      ? ["agent", "code", "build"]
      : requestedLower === "plan"
        ? ["plan", "architect"]
        : requestedLower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requestedLower === "debug"
            ? ["debug", "build", "agent", "code"]
            : requestedLower === "goal" || requestedLower === "burn"
              ? ["goal", "burn"]
              : requestedLower === "workflow"
                ? ["workflow"]
              : [req];
  const available = new Set(option.options.map((value) => value.value));
  for (const candidate of rawCandidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of rawCandidates) {
    const found = option.options.find((v) => v.value.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found.value;
    }
  }
  return null;
}
