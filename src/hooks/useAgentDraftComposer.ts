"use client";

/**
 * Shared draft-composer wiring for the "new chat" surfaces: the agent landing
 * page and the full-screen voice agent view. Owns the draft id, backend /
 * mode / model resolution, draft persistence plumbing, and the submit path
 * that materializes a conversation via create-and-prompt (or the optimistic
 * instant-submit path when the host provides one).
 *
 * Extracted verbatim from `AgentNewChatLanding` so both surfaces share one
 * code path instead of forking submit logic.
 */

import { useCallback, useMemo, useRef } from "react";
import {
  AGENT_STANDALONE_COMPOSER_DRAFT_ID,
  agentWorkspaceComposerDraftId,
  useOpenInEditor,
} from "@/components/editor/OpenInEditorContext";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import {
  DEFAULT_MODE_OPTIONS,
  resolveCanonicalModeId,
} from "@/lib/chat-modes";
import {
  resolveLastUsedDraftModel,
  updateChatDraftDefault,
} from "@/lib/chat-draft-defaults";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationCreateInput,
} from "@/lib/agent-types";
import type { EditorMode, ImageAttachment, ModelInfo } from "@/lib/types";
import { isStandaloneChatWorkspace } from "@/lib/types";

export function pickAvailableBackend(
  backends: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backends.find((b) => b.id === preferredBackendId && b.available) ??
    backends.find((b) => b.available) ??
    backends[0] ??
    null
  );
}

function branchNameFromPrompt(prompt: string): string {
  const stem = prompt
    .replace(/^\/worktree\b/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `cesium/${stem || `agent-${Date.now().toString(36)}`}`;
}

export type AgentDraftComposerOptions = {
  /**
   * Optimistic first-prompt path (landing only): switches to the conversation
   * view immediately and finishes the server round-trip in the background.
   */
  onInstantSubmit?: (
    input: AgentConversationCreateInput,
    text: string,
    attachments?: ImageAttachment[]
  ) => boolean;
  /** Fired when submit materialized a conversation (non-instant paths). */
  onConversationCreated?: (conversationId: string) => void;
};

export function useAgentDraftComposer(options?: AgentDraftComposerOptions) {
  const { onInstantSubmit, onConversationCreated } = options ?? {};
  const {
    composerDrafts,
    composerSelections,
    setComposerSelection,
    upsertComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
    createAndPromptConversation,
    createAndPromptStandaloneConversation,
  } = useAgentConversations();
  const {
    activeWorkspaceId,
    workspaceSession,
    updateWorkspaceSession,
    seedWorkspaceSessionChatDraft,
    openWorkspaceById,
    gitStatus,
    createWorktree,
    deleteWorktree,
  } = useWorkspace();
  const {
    activeWorkspaceGroup,
    setSelectedConversationId,
    refreshConversationGroups,
    standaloneDraftActive,
    setStandaloneDraftActive,
  } = useAgentShellState();

  const draftBackend = useMemo(
    () => pickAvailableBackend(backends, workspaceSession.chat.backendId),
    [backends, workspaceSession.chat.backendId]
  );
  const draftModels = useMemo(
    () =>
      draftBackend
        ? buildDraftModelOptionsForBackend(draftBackend)
        : [workspaceSession.chat.model],
    [draftBackend, workspaceSession.chat.model]
  );
  // Depend on the narrow chat fields the resolution actually reads — the
  // whole `chat` object is replaced by unrelated session folds (unread maps,
  // tab titles) several times per second under load, and each spurious
  // recompute used to re-derive the full model catalog.
  const chatRef = useRef(workspaceSession.chat);
  chatRef.current = workspaceSession.chat;
  const chatModel = workspaceSession.chat.model;
  const chatBackendId = workspaceSession.chat.backendId;
  const chatLastModelByBackend = workspaceSession.chat.lastModelByBackend;
  const draftModel = useMemo(() => {
    if (!draftBackend) return chatModel;
    return (
      resolveLastUsedDraftModel(chatRef.current, draftBackend, draftModels) ??
      resolveDraftModelForBackend(draftBackend)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveLastUsedDraftModel reads only model/backendId/lastModelByBackend from chat.
  }, [draftBackend, draftModels, chatModel, chatBackendId, chatLastModelByBackend]);
  const draftModeOptions = useMemo(
    () =>
      draftBackend
        ? buildDraftModeOptionsForBackend(draftBackend)
        : DEFAULT_MODE_OPTIONS,
    [draftBackend]
  );
  const draftMode = useMemo(
    () =>
      resolveCanonicalModeId(
        String(workspaceSession.chat.mode ?? draftModeOptions[0]?.id ?? "agent"),
        draftModeOptions
      ) as EditorMode,
    [draftModeOptions, workspaceSession.chat.mode]
  );

  // Standalone chats live in auto-created sandbox workspaces (named "Chat").
  // When one is active, the draft should present and behave as "No workspace".
  // A fresh install has no registered workspaces at all; that state uses the
  // same standalone path so the first chat works without any workspace setup.
  const activeIsStandaloneChat = Boolean(
    activeWorkspaceGroup && isStandaloneChatWorkspace(activeWorkspaceGroup.workspace)
  );
  const noWorkspaceDraft =
    standaloneDraftActive || activeIsStandaloneChat || !activeWorkspaceId;

  const composerDraftId = noWorkspaceDraft
    ? AGENT_STANDALONE_COMPOSER_DRAFT_ID
    : agentWorkspaceComposerDraftId(activeWorkspaceGroup?.workspace.id);
  const composerDraftTitle = "Agent prompt";
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
  const composerDraftCaptures = composerDrafts[composerDraftId]?.captures;
  const composerDraftTextReferences =
    composerDrafts[composerDraftId]?.textReferences;
  const composerDraftLinkReferences =
    composerDrafts[composerDraftId]?.linkReferences;
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };

  const setDraftMode = useCallback(
    (next: EditorMode) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: { ...current.chat, mode: next },
      }));
    },
    [updateWorkspaceSession]
  );

  const setDraftModel = useCallback(
    (next: ModelInfo) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: updateChatDraftDefault(current.chat, { model: next }),
      }));
    },
    [updateWorkspaceSession]
  );

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) return;
      const nextMode =
        buildDraftModeOptionsForBackend(nextBackend)[0]?.id ??
        workspaceSession.chat.mode;
      updateWorkspaceSession((current) => ({
        ...current,
        chat: updateChatDraftDefault(current.chat, {
          backendId: nextBackend.id,
          mode: nextMode ?? current.chat.mode,
          // Restore the model the user last used on this backend; only fall
          // back to the backend default when nothing was remembered.
          model:
            resolveLastUsedDraftModel(
              current.chat,
              nextBackend,
              buildDraftModelOptionsForBackend(nextBackend)
            ) ?? resolveDraftModelForBackend(nextBackend),
        }),
      }));
    },
    [backends, updateWorkspaceSession, workspaceSession.chat.mode]
  );

  const handleSubmit = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const backend = draftBackend;
      if (!backend) return false;

      // Capability profile (Code / Work / custom presets) rides along for the
      // built-in agent only; other backends do not understand profile ids.
      const draftProfileId =
        backend.id === "cesium-agent"
          ? workspaceSession.chat.profileId?.trim() || undefined
          : undefined;
      if (noWorkspaceDraft) {
        const created = await createAndPromptStandaloneConversation(
          {
            backendId: backend.id,
            mode: draftMode,
            modelId: draftModel.modelValue ?? draftModel.id,
            modelName: draftModel.name,
            ...(draftProfileId ? { profileId: draftProfileId } : {}),
          },
          text,
          attachments
        );
        if (!created) return false;
        // Carry the chosen backend/mode/model into the fresh sandbox before
        // opening it, so its session does not reset to default drafts.
        seedWorkspaceSessionChatDraft(created.workspaceId, {
          backendId: backend.id,
          mode: draftMode,
          model: draftModel,
        });
        setStandaloneDraftActive(false);
        await openWorkspaceById(created.workspaceId);
        setSelectedConversationId(created.conversation.id);
        onConversationCreated?.(created.conversation.id);
        void refreshConversationGroups();
        return true;
      }

      const worktreeMatch = text.match(/^\/worktree\b([\s\S]*)$/i);
      const deleteWorktreeMatch = text.match(/^\/delete-worktree\b/i);
      if (deleteWorktreeMatch) {
        const currentWorktree = gitStatus?.worktrees.find(
          (worktree) => worktree.current
        );
        if (!currentWorktree) return false;
        if (currentWorktree.current) {
          window.alert(
            "Open another checkout first, then delete this worktree from Workspace Studio."
          );
          return true;
        }
        await deleteWorktree({ path: currentWorktree.path });
        return true;
      }
      const promptText = worktreeMatch ? worktreeMatch[1]?.trim() ?? "" : text;
      if (worktreeMatch) {
        if (!promptText) return false;
        await createWorktree({
          branch: branchNameFromPrompt(promptText),
          baseBranch: gitStatus?.currentBranch ?? undefined,
          newBranch: true,
        });
      }
      const conversationInput: AgentConversationCreateInput = {
        backendId: backend.id,
        mode: draftMode,
        modelId: draftModel.modelValue ?? draftModel.id,
        modelName: draftModel.name,
        ...(draftProfileId ? { profileId: draftProfileId } : {}),
      };
      if (onInstantSubmit) {
        return onInstantSubmit(conversationInput, promptText, attachments);
      }
      const created = await createAndPromptConversation(
        conversationInput,
        promptText,
        attachments
      );
      if (!created) return false;
      setSelectedConversationId(created.id);
      onConversationCreated?.(created.id);
      void refreshConversationGroups();
      return true;
    },
    [
      createAndPromptConversation,
      onInstantSubmit,
      onConversationCreated,
      createAndPromptStandaloneConversation,
      draftBackend,
      draftMode,
      draftModel,
      createWorktree,
      deleteWorktree,
      gitStatus?.currentBranch,
      gitStatus?.worktrees,
      noWorkspaceDraft,
      openWorkspaceById,
      refreshConversationGroups,
      seedWorkspaceSessionChatDraft,
      setSelectedConversationId,
      setStandaloneDraftActive,
      workspaceSession.chat.profileId,
    ]
  );

  return {
    backends,
    composerDraftId,
    composerDraftTitle,
    composerDraftText,
    composerDraftAttachments,
    composerDraftCaptures,
    composerDraftTextReferences,
    composerDraftLinkReferences,
    composerSelection,
    setComposerSelection,
    upsertComposerDraft,
    draftBackend,
    draftModels,
    draftModel,
    draftModeOptions,
    draftMode,
    setDraftMode,
    setDraftModel,
    setDraftBackend,
    noWorkspaceDraft,
    gitStatus,
    handleSubmit,
  };
}

export type AgentDraftComposerState = ReturnType<typeof useAgentDraftComposer>;
