import type { ModelInfo } from "@/lib/types";

export type ModelPickerParameterValue = {
  id: string;
  label: string;
  value: string;
  valueLabel: string;
};

export type ModelPickerVariant = {
  model: ModelInfo;
  parameters: Map<string, ModelPickerParameterValue>;
  defaultish: boolean;
};

export type ModelPickerParameter = {
  id: string;
  label: string;
  values: Array<{ value: string; label: string }>;
  booleanValues?: { trueValue: string; falseValue: string };
};

export type BaseModelPickerGroup = {
  key: string;
  name: string;
  provider: ModelInfo["provider"];
  detail?: string;
  variants: ModelPickerVariant[];
  defaultVariant: ModelPickerVariant;
  parameters: ModelPickerParameter[];
};

export type ModelPickerGroup = BaseModelPickerGroup & {
  selectedVariant: ModelPickerVariant | null;
};

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}

function titleCase(value: string): string {
  const normalized = normalizeToken(value);
  if (normalized === "xhigh" || normalized === "extra high") return "Extra High";
  if (normalized === "1m") return "1M";
  if (/^\d+\s*[km]$/.test(normalized)) return normalized.replace(/\s+/g, "").toUpperCase();
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parameterLabel(id: string): string {
  const normalized = normalizeToken(id);
  if (/context|length|window|token/.test(normalized)) return "Context";
  if (normalized === "reasoning effort" || normalized === "effort") return "Reasoning Effort";
  if (normalized === "reasoning" || normalized === "thinking") return "Reasoning";
  if (normalized === "fast" || normalized === "speed") return "Fast";
  if (normalized === "variant") return "Variant";
  return titleCase(id);
}

function parameterValueLabel(id: string, value: string): string {
  const normalizedId = normalizeToken(id);
  const normalizedValue = normalizeToken(value);
  if (/context|length|window|token/.test(normalizedId)) return titleCase(value);
  if (
    (normalizedId === "fast" || normalizedId === "speed") &&
    ["true", "enabled", "on", "fast"].includes(normalizedValue)
  ) {
    return "On";
  }
  if (
    (normalizedId === "fast" || normalizedId === "speed") &&
    ["false", "disabled", "off", "standard", "default", "normal"].includes(normalizedValue)
  ) {
    return "Off";
  }
  return titleCase(value);
}

function encodedParameters(value: string): ModelPickerParameterValue[] {
  const match = /^(.*)\[(.*)\]$/.exec(value.trim());
  if (!match) return [];
  return (match[2] ?? "")
    .split(",")
    .flatMap((entry) => {
      const [rawId, ...rawValueParts] = entry.split("=");
      const id = rawId?.trim() ?? "";
      const paramValue = rawValueParts.join("=").trim();
      if (!id || !paramValue) return [];
      return [
        {
          id,
          label: parameterLabel(id),
          value: paramValue,
          valueLabel: parameterValueLabel(id, paramValue),
        },
      ];
    });
}

function legacyNameParameters(name: string): ModelPickerParameterValue[] {
  const out: ModelPickerParameterValue[] = [];
  const paren = /^(.*)\(([^)]*)\)\s*$/.exec(name.trim());
  const tokens = (paren?.[2] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  for (const token of tokens) {
    const normalized = normalizeToken(token);
    let id = "";
    if (/^\d+\s*[km]$/i.test(token)) id = "__context";
    else if (["low", "medium", "high", "xhigh", "extra high", "max", "thinking"].includes(normalized)) {
      id = "__reasoning";
    } else if (normalized === "fast") {
      id = "__fast";
    }
    if (id) {
      out.push({
        id,
        label: id === "__context" ? "Context" : id === "__fast" ? "Fast" : "Reasoning",
        value: id === "__fast" ? "true" : token,
        valueLabel: id === "__fast" ? "On" : titleCase(token),
      });
    }
  }
  return out;
}

function parametersForModel(model: ModelInfo): ModelPickerParameterValue[] {
  if (model.variantParameters?.length) {
    return model.variantParameters.map((parameter) => ({
      id: parameter.id,
      label: parameter.name?.trim() || parameterLabel(parameter.id),
      value: parameter.value,
      valueLabel:
        parameter.valueName?.trim() || parameterValueLabel(parameter.id, parameter.value),
    }));
  }
  const encoded = encodedParameters(model.modelValue ?? model.id);
  // Encoded provider values are authoritative. Never blend them with words
  // from a display name: `thinking=true` used to be misread as Fast.
  if (encoded.length > 0) return encoded;
  return legacyNameParameters(model.name);
}

function baseNameForModel(model: ModelInfo, parameters: ModelPickerParameterValue[]): string {
  if (model.variantGroupName?.trim()) return model.variantGroupName.trim();
  let name = model.name.replace(/\s*\((?:default|current)\)\s*$/i, "").trim();
  for (const parameter of [...parameters].reverse()) {
    const candidates = [parameter.valueLabel, parameter.value]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      name = name
        .replace(new RegExp(`\\s*\\(${escaped}\\)\\s*$`, "i"), "")
        .replace(new RegExp(`\\s+${escaped}\\s*$`, "i"), "")
        .trim();
    }
  }
  return name || model.name;
}

function modelGroupKey(model: ModelInfo, baseName: string): string {
  return `${model.backendId ?? ""}:${model.provider}:${
    model.variantGroupId?.trim() || baseName.toLowerCase()
  }`;
}

function sameModelChoice(a: ModelInfo, b: ModelInfo): boolean {
  const av = a.modelValue ?? a.id;
  const bv = b.modelValue ?? b.id;
  if (av !== bv) return false;
  const ac = a.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
  const bc = b.configSelections?.map((s) => `${s.configId}:${s.value}`).sort().join("|") ?? "";
  return ac === bc;
}

function booleanValues(
  values: Array<{ value: string; label: string }>
): ModelPickerParameter["booleanValues"] {
  const truthy = new Set(["true", "enabled", "on", "fast"]);
  const falsy = new Set(["false", "disabled", "off", "standard", "default", "normal"]);
  const trueValue = values.find((entry) => truthy.has(normalizeToken(entry.value)))?.value;
  const falseValue = values.find((entry) => falsy.has(normalizeToken(entry.value)))?.value;
  return trueValue && falseValue ? { trueValue, falseValue } : undefined;
}

export function buildBaseModelPickerGroups(models: ModelInfo[]): BaseModelPickerGroup[] {
  const byKey = new Map<
    string,
    { name: string; provider: ModelInfo["provider"]; detail?: string; variants: ModelPickerVariant[] }
  >();
  for (const model of models) {
    const parameters = parametersForModel(model);
    const baseName = baseNameForModel(model, parameters);
    const key = modelGroupKey(model, baseName);
    const group = byKey.get(key) ?? {
      name: baseName,
      provider: model.provider,
      detail: model.detail,
      variants: [],
    };
    group.variants.push({
      model,
      parameters: new Map(parameters.map((parameter) => [parameter.id, parameter])),
      defaultish:
        /\b(?:default|current)\b/i.test(model.name) ||
        parameters.length === 0 ||
        (model.modelValue ?? model.id) === "auto",
    });
    byKey.set(key, group);
  }

  return [...byKey.entries()]
    .map(([key, group]) => {
      const definitions = new Map<
        string,
        { label: string; values: Map<string, string> }
      >();
      for (const variant of group.variants) {
        for (const parameter of variant.parameters.values()) {
          const definition = definitions.get(parameter.id) ?? {
            label: parameter.label,
            values: new Map<string, string>(),
          };
          definition.values.set(parameter.value, parameter.valueLabel);
          definitions.set(parameter.id, definition);
        }
      }
      const parameters = [...definitions.entries()].flatMap(([id, definition]) => {
        const values = [...definition.values.entries()].map(([value, label]) => ({ value, label }));
        if (values.length < 2) return [];
        return [
          {
            id,
            label: definition.label,
            values,
            booleanValues: booleanValues(values),
          },
        ];
      });
      return {
        key,
        name: group.name,
        provider: group.provider,
        detail: group.detail,
        variants: group.variants,
        defaultVariant:
          group.variants.find((variant) => variant.defaultish) ?? group.variants[0]!,
        parameters,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function applySelectedToGroup(
  group: BaseModelPickerGroup,
  selected: ModelInfo
): ModelPickerGroup {
  return {
    ...group,
    selectedVariant:
      group.variants.find((variant) => sameModelChoice(variant.model, selected)) ?? null,
  };
}

export function selectVariantForParameter(
  group: ModelPickerGroup,
  parameterId: string,
  value: string
): ModelPickerVariant {
  const current = group.selectedVariant ?? group.defaultVariant;
  const candidates = group.variants.filter(
    (variant) => variant.parameters.get(parameterId)?.value === value
  );
  if (candidates.length === 0) return current;
  const otherIds = group.parameters
    .map((parameter) => parameter.id)
    .filter((id) => id !== parameterId);
  return [...candidates].sort((a, b) => {
    const score = (variant: ModelPickerVariant) =>
      otherIds.reduce(
        (sum, id) =>
          sum +
          (variant.parameters.get(id)?.value === current.parameters.get(id)?.value ? 1 : 0),
        0
      );
    return score(b) - score(a);
  })[0]!;
}

export function canSelectBooleanValue(
  group: ModelPickerGroup,
  parameterId: string,
  value: string
): boolean {
  const current = group.selectedVariant ?? group.defaultVariant;
  const otherIds = group.parameters
    .map((parameter) => parameter.id)
    .filter((id) => id !== parameterId);
  return group.variants.some(
    (variant) =>
      variant.parameters.get(parameterId)?.value === value &&
      otherIds.every(
        (id) => variant.parameters.get(id)?.value === current.parameters.get(id)?.value
      )
  );
}
