import type { AgentBackendId, AgentConversationConfig, AgentConversationMode } from "./agent-types";
import type { EditorMode, ModelInfo, QueuedChatPrompt, QueuedPromptConfigOverride } from "./types";

export function buildQueuedConfigOverride(
  conversationConfig: AgentConversationConfig | undefined,
  currentBackendId: AgentBackendId,
  currentMode: EditorMode,
  currentModel: ModelInfo,
): QueuedPromptConfigOverride | undefined {
  if (!conversationConfig) return undefined;
  const override: QueuedPromptConfigOverride = {};
  if (currentBackendId && currentBackendId !== conversationConfig.backendId) {
    override.backendId = currentBackendId;
  }
  if (currentMode && currentMode !== conversationConfig.mode) {
    override.mode = currentMode;
  }
  const currentModelId = currentModel.modelValue ?? currentModel.id;
  if (currentModelId && currentModelId !== conversationConfig.modelId) {
    override.modelId = currentModelId;
    override.modelName = currentModel.name;
  }
  if (currentModel.configSelections?.length) {
    override.setConfigOptions = currentModel.configSelections;
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

export function resolveEffectiveConfig(
  conversationConfig: AgentConversationConfig,
  override: QueuedPromptConfigOverride | undefined,
): AgentConversationConfig {
  if (!override) return conversationConfig;
  return {
    backendId: (override.backendId ?? conversationConfig.backendId) as AgentBackendId,
    mode: (override.mode ?? conversationConfig.mode) as AgentConversationMode,
    modelId: override.modelId ?? conversationConfig.modelId,
    modelName: override.modelName ?? conversationConfig.modelName,
  };
}

export function getConfigDiff(
  from: AgentConversationConfig,
  to: AgentConversationConfig,
): QueuedPromptConfigOverride | undefined {
  const diff: QueuedPromptConfigOverride = {};
  if (to.backendId !== from.backendId) diff.backendId = to.backendId;
  if (to.mode !== from.mode) diff.mode = to.mode as EditorMode;
  if (to.modelId !== from.modelId) {
    diff.modelId = to.modelId;
    diff.modelName = to.modelName;
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

export function formatConfigOverrideTooltip(
  diff: QueuedPromptConfigOverride,
  backendLabels?: Record<string, string>,
): string {
  const parts: string[] = [];
  if (diff.backendId) {
    const label = backendLabels?.[diff.backendId] ?? diff.backendId;
    parts.push(`Server: ${label}`);
  }
  if (diff.mode) parts.push(`Mode: ${diff.mode}`);
  if (diff.modelId) parts.push(`Model: ${diff.modelName ?? diff.modelId}`);
  return parts.join(" | ");
}

export function getConfigDiffFromPrevious(
  item: QueuedChatPrompt,
  previousItem: QueuedChatPrompt | null,
  conversationConfig: AgentConversationConfig,
): QueuedPromptConfigOverride | undefined {
  const baseline = previousItem
    ? resolveEffectiveConfig(conversationConfig, previousItem.configOverride)
    : conversationConfig;
  const current = resolveEffectiveConfig(conversationConfig, item.configOverride);
  return getConfigDiff(baseline, current);
}

export function mergeConfigOverride(
  existing: QueuedPromptConfigOverride | undefined,
  update: Partial<QueuedPromptConfigOverride>,
): QueuedPromptConfigOverride {
  return { ...existing, ...update };
}
