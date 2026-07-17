import { defaultHarnessSettings, normalizeHarnessSettings } from "./limits.js";
import { resolveSubagentsModule } from "./subagents/index.js";
import type {
  CesiumFeatureModule,
  CesiumHarnessSettings,
  CesiumToolDefinition,
  ResolvedCesiumHarness,
} from "./types.js";

export type {
  CesiumFeatureModule,
  CesiumHarnessFeatureId,
  CesiumHarnessFeatureVersions,
  CesiumHarnessLimits,
  CesiumHarnessSettings,
  CesiumSubagentsVersion,
  CesiumToolDefinition,
  ResolvedCesiumHarness,
} from "./types.js";

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

/**
 * Resolve the active harness feature stack from settings.
 * Feature modules are swapped by version (e.g. subagents v1 vs v2) without
 * rewriting the core turn loop — tools, reminders, and dispatch keys come from modules.
 */
export function resolveCesiumHarnessFeatures(
  harnessInput?: CesiumHarnessSettings | unknown
): {
  settings: CesiumHarnessSettings;
  modules: CesiumFeatureModule[];
  featureTools: CesiumToolDefinition[];
  subagentsVersion: 1 | 2;
} {
  const settings = harnessInput
    ? normalizeHarnessSettings(harnessInput)
    : defaultHarnessSettings();
  const subagents = resolveSubagentsModule(settings.features.subagents.version, settings.limits);
  const modules: CesiumFeatureModule[] = [subagents];
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
  harnessInput?: CesiumHarnessSettings | unknown
): ResolvedCesiumHarness {
  const features = resolveCesiumHarnessFeatures(harnessInput);
  const tools = [...baseTools, ...features.featureTools];
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
