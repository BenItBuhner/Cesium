import type { AgentBackendId } from "@/lib/agent-types";
import type { EditorMode, ModelInfo } from "@/lib/types";
import type { ChatSessionState } from "@/lib/workspace-session";

function configSelectionsSignature(
  selections?: Array<{ configId: string; value: string }>
): string {
  return (selections ?? [])
    .map((selection) => `${selection.configId}:${selection.value}`)
    .sort()
    .join("|");
}

function modelChoiceSignature(model: ModelInfo): string {
  return JSON.stringify({
    id: model.id,
    modelValue: model.modelValue ?? null,
    name: model.name,
    backendId: model.backendId ?? null,
    configSelections: configSelectionsSignature(model.configSelections),
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

  // Remember the pick per backend so a later switch back to this harness (or
  // a new chat after using another one) restores the user's model instead of
  // the backend default.
  const rememberKey = (model.backendId as AgentBackendId | undefined) ?? backendId;
  const previousRemembered = chat.lastModelByBackend?.[rememberKey];
  const rememberedChanged =
    previousRemembered == null ||
    modelChoiceSignature(previousRemembered) !== modelChoiceSignature(model);

  if (
    chat.backendId === backendId &&
    chat.mode === mode &&
    modelChoiceSignature(chat.model) === modelChoiceSignature(model) &&
    !rememberedChanged
  ) {
    return chat;
  }

  return {
    ...chat,
    backendId,
    mode,
    model,
    lastModelByBackend: rememberedChanged
      ? { ...(chat.lastModelByBackend ?? {}), [rememberKey]: model }
      : chat.lastModelByBackend,
  };
}

/**
 * Resolve the model a new-chat draft should show for `backend` from the
 * user's last-used choices: the current session draft model when it belongs
 * to this backend, then the per-backend memory. Matches against the live
 * catalog (`draftModels`) so stale ids cannot leak into the dropdown, but
 * when the catalog has not hydrated yet (placeholder 0/1-entry list built
 * from the hardcoded backend default) the remembered pick is trusted as-is —
 * snapping to the placeholder default is exactly the bug this prevents.
 *
 * Returns null when nothing usable was remembered; callers fall back to
 * `resolveDraftModelForBackend`.
 */
export function resolveLastUsedDraftModel(
  chat: ChatSessionState,
  backend: { id: AgentBackendId },
  draftModels: ModelInfo[]
): ModelInfo | null {
  const candidates: ModelInfo[] = [];
  if ((chat.model.backendId ?? chat.backendId) === backend.id) {
    candidates.push(chat.model);
  }
  const remembered = chat.lastModelByBackend?.[backend.id];
  if (remembered && remembered !== chat.model) {
    candidates.push(remembered);
  }

  for (const candidate of candidates) {
    // Exact row id first: keeps composite variant picks (e.g. thought-level
    // rows like `model::thought::high`) instead of collapsing to the first
    // variant that shares the same modelValue.
    const exact = draftModels.find((model) => model.id === candidate.id);
    if (exact) {
      return exact;
    }
    const candidateValue = candidate.modelValue ?? candidate.id;
    const valueMatches = draftModels.filter(
      (model) => (model.modelValue ?? model.id) === candidateValue
    );
    if (valueMatches.length > 0) {
      return (
        valueMatches.find(
          (model) =>
            configSelectionsSignature(model.configSelections) ===
            configSelectionsSignature(candidate.configSelections)
        ) ?? valueMatches[0]!
      );
    }
    if (draftModels.length <= 1 && candidate.backendId === backend.id) {
      // Catalog not hydrated (single synthetic entry): trust the explicit
      // last-used pick over the placeholder.
      return candidate;
    }
  }
  return null;
}
