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
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { SETUP_ROUTE } from "@/lib/onboarding/workspace-errors";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  NO_MODEL_PLACEHOLDER,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import {
  DEFAULT_MODE_OPTIONS,
  resolveCanonicalModeId,
} from "@/lib/chat-modes";
import {
  resolveLastUsedDraftModel,
  updateComposerDraftDefault,
  updateComposerDraftMode,
} from "@/lib/chat-draft-defaults";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationCreateInput,
} from "@/lib/agent-types";
import type { EditorMode, ImageAttachment, ModelInfo } from "@/lib/types";
import { isStandaloneChatWorkspace } from "@/lib/types";
import { resolveLandingComposerDraftId } from "@/lib/chat-draft-title";
import { backendSupportsCloudExecution } from "@/lib/cloud-execution-devices";
import { useCloudExecutionDevice } from "@/hooks/useCloudExecutionDevice";
import { useComposerDefaults } from "@/hooks/useComposerDefaults";

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
    resetComposerDraft,
  } = useOpenInEditor();
  const {
    backends: allBackends,
    createAndPromptConversation,
    createAndPromptStandaloneConversation,
  } = useAgentConversations();
  const { activeCloudDevice } = useCloudExecutionDevice(allBackends);
  // While the cloud pseudo-device is active, the composer only offers
  // cloud-capable backends; new conversations execute on the vendor's cloud.
  const backends = useMemo(
    () =>
      activeCloudDevice
        ? allBackends.filter(
            (backend) => backendSupportsCloudExecution(backend) && backend.available
          )
        : allBackends,
    [activeCloudDevice, allBackends]
  );
  const {
    activeWorkspaceId,
    openWorkspaceById,
    gitStatus,
    createWorktree,
    deleteWorktree,
  } = useWorkspace();
  const { composer, updateComposer } = useComposerDefaults();
  const {
    activeWorkspaceGroup,
    setSelectedConversationId,
    refreshConversationGroups,
    standaloneDraftActive,
    setStandaloneDraftActive,
  } = useAgentShellState();
  const { hasServer } = useServerConnections();
  const { pushNotification, dismissByKind } = useWorkbenchNotifications();
  const dialogs = useWorkbenchDialogs();

  /**
   * Submitting without any usable backend must not silently no-op: surface a
   * persistent prompt that pushes the user to connect a server (fresh account)
   * or fix the connection (engine offline / no harnesses).
   */
  const notifyNoBackendAvailable = useCallback(() => {
    dismissByKind(WORKBENCH_NOTIFICATION_KIND.connectFirstServer);
    pushNotification({
      kind: WORKBENCH_NOTIFICATION_KIND.connectFirstServer,
      severity: "info",
      title: hasServer ? "Server unavailable" : "Connect a server to chat",
      message: hasServer
        ? "Your server isn't reachable or has no agent harnesses available. Reconnect or pick another server to send prompts."
        : "Cesium needs a connected server before agents can run. Connect one to start chatting - it syncs to your account.",
      persistent: true,
      actions: [
        {
          id: "open-setup",
          label: "Connect server",
          primary: true,
          onClick: () => {
            window.location.assign(SETUP_ROUTE);
          },
        },
      ],
    });
  }, [dismissByKind, hasServer, pushNotification]);

  const draftBackend = useMemo(
    () =>
      pickAvailableBackend(
        backends,
        activeCloudDevice ? activeCloudDevice.backendId : composer.backendId
      ),
    [activeCloudDevice, backends, composer.backendId]
  );
  // No backend (no connected server / engine offline) means no model catalog.
  // Never fall back to the persisted model: it would parade a model the user
  // cannot actually run in the picker.
  const draftModels = useMemo(
    () => (draftBackend ? buildDraftModelOptionsForBackend(draftBackend) : []),
    [draftBackend]
  );
  // Depend on the narrow fields the resolution actually reads so unrelated
  // settings edits do not re-derive the full model catalog.
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const composerModel = composer.model;
  const composerBackendId = composer.backendId;
  const composerLastModelByBackend = composer.lastModelByBackend;
  const draftModel = useMemo(() => {
    if (!draftBackend) return NO_MODEL_PLACEHOLDER;
    return (
      resolveLastUsedDraftModel(composerRef.current, draftBackend, draftModels) ??
      resolveDraftModelForBackend(draftBackend)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveLastUsedDraftModel reads only model/backendId/lastModelByBackend.
  }, [draftBackend, draftModels, composerModel, composerBackendId, composerLastModelByBackend]);
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
        String(composer.mode ?? draftModeOptions[0]?.id ?? "agent"),
        draftModeOptions
      ) as EditorMode,
    [draftModeOptions, composer.mode]
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

  const composerDraftId = resolveLandingComposerDraftId({
    standaloneDraftActive,
    activeWorkspaceId: activeWorkspaceGroup?.workspace.id ?? activeWorkspaceId,
    activeIsStandaloneChat,
  });
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
      updateComposer((current) => updateComposerDraftMode(current, next));
    },
    [updateComposer]
  );

  const setDraftModel = useCallback(
    (next: ModelInfo) => {
      updateComposer((current) => updateComposerDraftDefault(current, { model: next }));
    },
    [updateComposer]
  );

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) return;
      updateComposer((current) =>
        updateComposerDraftDefault(current, {
          backendId: nextBackend.id,
          mode: buildDraftModeOptionsForBackend(nextBackend)[0]?.id ?? current.mode,
          // Restore the model the user last used on this backend; only fall
          // back to the backend default when nothing was remembered.
          model:
            resolveLastUsedDraftModel(
              current,
              nextBackend,
              buildDraftModelOptionsForBackend(nextBackend)
            ) ?? resolveDraftModelForBackend(nextBackend),
        })
      );
    },
    [backends, updateComposer]
  );

  const handleSubmit = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const backend = draftBackend;
      if (!backend) {
        notifyNoBackendAvailable();
        return false;
      }

      // Capability profile (Code / Work / custom presets) rides along for the
      // built-in agent only; other backends do not understand profile ids.
      const draftProfileId =
        backend.id === "cesium-agent" ? composer.profileId?.trim() || undefined : undefined;
      // Cloud execution rides along only when the pinned backend actually
      // advertises it (the pseudo-device pins the composer to such backends).
      const cloudExecution = Boolean(
        activeCloudDevice && backendSupportsCloudExecution(backend)
      );
      if (noWorkspaceDraft) {
        const created = await createAndPromptStandaloneConversation(
          {
            backendId: backend.id,
            mode: draftMode,
            modelId: draftModel.modelValue ?? draftModel.id,
            modelName: draftModel.name,
            ...(draftProfileId ? { profileId: draftProfileId } : {}),
            ...(cloudExecution ? { executionTarget: "cloud" as const } : {}),
          },
          text,
          attachments
        );
        if (!created) return false;
        resetComposerDraft(composerDraftId);
        // The chosen backend/mode/model are account defaults, so the fresh
        // sandbox workspace inherits them without any per-workspace seeding.
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
          await dialogs.alert({
            title: "This worktree is currently open",
            message:
              "Open another checkout first, then delete this worktree from Workspace Studio.",
            detail: currentWorktree.path,
          });
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
        ...(cloudExecution ? { executionTarget: "cloud" as const } : {}),
      };
      if (onInstantSubmit) {
        resetComposerDraft(composerDraftId);
        return onInstantSubmit(conversationInput, promptText, attachments);
      }
      const created = await createAndPromptConversation(
        conversationInput,
        promptText,
        attachments
      );
      if (!created) return false;
      resetComposerDraft(composerDraftId);
      setSelectedConversationId(created.id);
      onConversationCreated?.(created.id);
      void refreshConversationGroups();
      return true;
    },
    [
      activeCloudDevice,
      createAndPromptConversation,
      onInstantSubmit,
      onConversationCreated,
      createAndPromptStandaloneConversation,
      draftBackend,
      draftMode,
      draftModel,
      createWorktree,
      deleteWorktree,
      dialogs,
      gitStatus?.currentBranch,
      gitStatus?.worktrees,
      notifyNoBackendAvailable,
      noWorkspaceDraft,
      openWorkspaceById,
      refreshConversationGroups,
      setSelectedConversationId,
      setStandaloneDraftActive,
      composer.profileId,
      composerDraftId,
      resetComposerDraft,
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
    /** Non-null while new chats are pinned to a cloud pseudo-device. */
    activeCloudDevice,
    /** Account-wide composer defaults the draft resolves from. */
    composer,
  };
}

export type AgentDraftComposerState = ReturnType<typeof useAgentDraftComposer>;
