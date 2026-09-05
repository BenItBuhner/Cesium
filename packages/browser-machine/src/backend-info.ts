/**
 * Harness registry for the in-browser engine.
 *
 * The browser machine only advertises harnesses that genuinely execute
 * in-page. The settings UI derives the visible harness list from this
 * catalog (via `/api/agents/backends` and the conversation-list backend
 * payloads), so a harness that is not registered here simply does not exist
 * for browser-only clients - no dead toggles, no phantom settings.
 *
 * Adding a future in-page harness (for example a lazily loaded Cursor SDK
 * shim) is a one-stop change: append a descriptor to `BROWSER_HARNESSES`
 * with its backend id and `AgentBackendInfo` builder, and the backends
 * catalog, composer picker, and Settings → Agents gating light up
 * automatically on every client.
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
import type { BrowserModeId } from "./stores/settings";
import { BROWSER_MODE_DEFINITIONS } from "./stores/settings";

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
  supportsCancelResume: false,
};

export type ModelChoice = {
  id: string;
  name: string;
};

/** One in-page harness the browser machine can execute. */
export type BrowserHarnessDescriptor = {
  backendId: string;
  buildInfo(defaults?: {
    modelId?: string | null;
    modelName?: string | null;
    available?: boolean;
  }): AgentBackendInfo;
};

export function buildConfigOptions(input: {
  mode: string;
  modelId: string;
  models: ModelChoice[];
  /** Modes the user enabled in Settings; defaults to every browser mode. */
  enabledModes?: BrowserModeId[];
}): AgentConfigOption[] {
  const modelValues = input.models.length
    ? input.models
    : [{ id: input.modelId, name: input.modelId }];
  const enabledModes =
    input.enabledModes && input.enabledModes.length > 0
      ? input.enabledModes
      : BROWSER_MODE_DEFINITIONS.map((mode) => mode.id);
  // The active mode stays selectable even when disabled in Settings so open
  // conversations never point at a missing option (server parity).
  const modeOptions = BROWSER_MODE_DEFINITIONS.filter(
    (mode) => enabledModes.includes(mode.id) || mode.id === input.mode
  ).map((mode) => ({ value: mode.id, name: mode.label }));
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: input.mode,
      options: modeOptions,
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

/**
 * Every harness executable inside the page today. Future in-page harnesses
 * (e.g. a Cursor SDK shim with lazily loaded glue code) register here.
 */
export const BROWSER_HARNESSES: readonly BrowserHarnessDescriptor[] = [
  {
    backendId: CESIUM_BACKEND_ID,
    buildInfo: buildBrowserBackendInfo,
  },
];

/** Backend ids the browser machine can actually run. */
export const BROWSER_SUPPORTED_BACKEND_IDS: readonly string[] = BROWSER_HARNESSES.map(
  (harness) => harness.backendId
);
