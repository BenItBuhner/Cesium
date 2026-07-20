import { defaultHarnessSettings, normalizeHarnessSettings } from "./limits.js";
import {
  createCesiumFeatureRegistry,
  type CesiumFeatureRegistry,
} from "./registry.js";
import { SUBAGENTS_FEATURE_DEFINITION } from "./subagents/index.js";
import type {
  CesiumFeatureDefinition,
  CesiumFeatureModule,
  CesiumHarnessSettings,
  CesiumToolDefinition,
  ResolvedCesiumHarness,
} from "./types.js";

export type {
  CesiumFeatureModule,
  CesiumFeatureCatalogEntry,
  CesiumFeatureDefinition,
  CesiumFeatureVersionDefinition,
  CesiumHarnessFeatureId,
  CesiumHarnessFeatureVersions,
  CesiumHarnessLimits,
  CesiumHarnessSettings,
  CesiumSubagentsVersion,
  CesiumToolDefinition,
  ResolvedCesiumHarness,
} from "./types.js";
export {
  createCesiumFeatureRegistry,
  type CesiumFeatureRegistry,
} from "./registry.js";

export {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_SUBAGENTS_VERSION,
  DEFAULT_WAIT_AGENT_DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS,
  DEFAULT_WAIT_AGENT_MIN_TIMEOUT_MS,
  DEFAULT_WAIT_MAX_SECONDS,
  HARD_MAX_WAIT_AGENT_TIMEOUT_MS,
  defaultHarnessLimits,
  defaultHarnessSettings,
  mergeHarnessSettings,
  normalizeHarnessLimits,
  normalizeHarnessSettings,
  normalizeSubagentsVersion,
  resolveWaitAgentTimeoutMs,
} from "./limits.js";

export {
  SubagentsV2Runtime,
  createSubagentsV1Module,
  createSubagentsV2Module,
  isSubagentsV1ToolName,
  isSubagentsV2ToolName,
  resolveSubagentsModule,
} from "./subagents/index.js";

export const CESIUM_FEATURE_REGISTRY = createCesiumFeatureRegistry([
  SUBAGENTS_FEATURE_DEFINITION,
]);

/** Register a plugin-like feature layer in the process-wide Cesium harness. */
export function registerCesiumFeatureDefinition(
  definition: CesiumFeatureDefinition
): () => void {
  return CESIUM_FEATURE_REGISTRY.register(definition);
}

export function getCesiumFeatureCatalog() {
  return CESIUM_FEATURE_REGISTRY.catalog();
}

/**
 * Resolve the active harness feature stack from settings.
 * Feature modules are swapped by version (e.g. subagents v1 vs v2) without
 * rewriting the core turn loop — tools, reminders, and dispatch keys come from modules.
 */
export function resolveCesiumHarnessFeatures(
  harnessInput?: CesiumHarnessSettings | unknown,
  registry: CesiumFeatureRegistry = CESIUM_FEATURE_REGISTRY
): {
  settings: CesiumHarnessSettings;
  modules: CesiumFeatureModule[];
  featureTools: CesiumToolDefinition[];
  subagentsVersion: 1 | 2;
} {
  const settings = harnessInput
    ? normalizeHarnessSettings(harnessInput)
    : defaultHarnessSettings();
  const modules = registry.resolve(settings, settings.limits);
  return {
    settings,
    modules,
    featureTools: modules.flatMap((module) => module.tools),
    subagentsVersion: settings.features.subagents.version,
  };
}

/** Compose base tools + active feature-module tools into a resolved harness. */
export function resolveCesiumHarness(
  baseTools: CesiumToolDefinition[],
  harnessInput?: CesiumHarnessSettings | unknown,
  registry: CesiumFeatureRegistry = CESIUM_FEATURE_REGISTRY
): ResolvedCesiumHarness {
  const features = resolveCesiumHarnessFeatures(harnessInput, registry);
  const tools = [...baseTools, ...features.featureTools];
  const duplicateToolNames = tools
    .map((tool) => tool.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateToolNames.length > 0) {
    throw new Error(
      `Cesium harness feature tool collision: ${[...new Set(duplicateToolNames)].join(", ")}`
    );
  }
  return {
    settings: features.settings,
    modules: features.modules,
    tools,
    toolNames: new Set(tools.map((tool) => tool.name)),
    subagentsVersion: features.subagentsVersion,
  };
}

export function harnessFeatureReminder(resolved: ResolvedCesiumHarness): string {
  return resolved.modules
    .map((module) => module.reminder)
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n");
}
