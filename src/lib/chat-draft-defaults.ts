import type { AgentBackendId } from "@/lib/agent-types";
import type { EditorMode, ModelInfo } from "@/lib/types";
import type { ChatSessionState } from "@/lib/workspace-session";

function modelChoiceSignature(model: ModelInfo): string {
  const configSelections =
    model.configSelections?.map((selection) => `${selection.configId}:${selection.value}`).sort() ?? [];
  return JSON.stringify({
    id: model.id,
    modelValue: model.modelValue ?? null,
    name: model.name,
    backendId: model.backendId ?? null,
    configSelections,
  });
}

export function updateChatDraftDefault(
  chat: ChatSessionState,
  patch: {
    backendId?: AgentBackendId;
    mode?: EditorMode;
    model?: ModelInfo;
  }
): ChatSessionState {
  const backendId = (patch.model?.backendId as AgentBackendId | undefined) ?? patch.backendId ?? chat.backendId;
  const mode = patch.mode ?? chat.mode;
  const model = patch.model ?? chat.model;

  if (
    chat.backendId === backendId &&
    chat.mode === mode &&
    modelChoiceSignature(chat.model) === modelChoiceSignature(model)
  ) {
    return chat;
  }

  return {
    ...chat,
    backendId,
    mode,
    model,
  };
}
