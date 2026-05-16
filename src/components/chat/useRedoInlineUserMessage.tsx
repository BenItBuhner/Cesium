"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
  AgentConversationSnapshot,
} from "@/lib/agent-types";
import {
  buildConversationModeOptions,
  buildConversationModelOptions,
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  resolveConversationModel,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import type { GlobalSettingsState } from "@/lib/global-settings";
import type {
  ChatMessage,
  EditorMode,
  ImageAttachment,
  ModelInfo,
} from "@/lib/types";
import {
  fetchAgentConversationSnapshot,
  forkAgentConversation,
  handoffAgentConversation,
  updateAgentConversationConfig,
} from "@/lib/server-api";

export type RedoInlineComposerSeed = {
  backendId?: AgentBackendId;
  mode: EditorMode;
  model: ModelInfo;
};

export type UseRedoInlineUserMessageArgs = {
  conversation: AgentConversationRecord | null;
  getRedoComposerSeed: () => RedoInlineComposerSeed;
  backends: AgentBackendInfo[];
  /** Same map as composer model resolution (`globalSettings.models.byBackend`). */
  modelVisibility: GlobalSettingsState["models"]["byBackend"];
  composerUserMessageHistory: string[];
  hasOlderHistory: boolean;
  onRequestOlderHistory?: () => void;
  mergeConversationSnapshot: (snapshot: AgentConversationSnapshot) => void;
  refreshConversations: () => Promise<AgentConversationRecord[]>;
  upsertConversation: (conversation: AgentConversationRecord) => void;
  promptConversationForActive: (
    conversationId: string,
    text: string,
    attachments?: ImageAttachment[]
  ) => Promise<boolean>;
  exposeForkedConversation?: (conversationId: string, title: string) => void;
};

function pickAvailableBackend(
  backendsList: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backendsList.find((backend) => backend.id === preferredBackendId && backend.available) ??
    backendsList.find((backend) => backend.available) ??
    backendsList[0] ??
    null
  );
}

export function buildRedoComposerSeedFromConversation(
  conversation: AgentConversationRecord,
  backends: AgentBackendInfo[],
  modelVisibility: GlobalSettingsState["models"]["byBackend"]
): RedoInlineComposerSeed {
  const backend = pickAvailableBackend(backends, conversation.config.backendId);
  const models = buildConversationModelOptions(conversation, backends, modelVisibility);
  const modeOptions = buildConversationModeOptions(conversation, backends);
  const modeOptionPool = modeOptions.length > 0 ? modeOptions : DEFAULT_MODE_OPTIONS;
  const mode = resolveCanonicalModeId(
    String(conversation.config.mode ?? modeOptionPool[0]?.id ?? "agent"),
    modeOptionPool
  ) as EditorMode;

  return {
    backendId: conversation.config.backendId ?? backend?.id,
    mode,
    model:
      models.find((model) => model.selected) ??
      resolveConversationModel(conversation, backends),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Shared OSP-90 redo / fork-from-message flow for message threads (inline composer + fork-after-edit). */
export function useRedoInlineUserMessage(args: UseRedoInlineUserMessageArgs): {
  editingUserMessageId: string | null;
  handleStartRedoMessage: (message: ChatMessage) => void;
  handleForkMessage: (messageId: string) => Promise<void>;
  renderRedoMessageEditor: (message: ChatMessage) => ReactNode;
} {
  const { pushNotification } = useWorkbenchNotifications();
  const {
    backends,
    composerUserMessageHistory,
    conversation,
    exposeForkedConversation,
    getRedoComposerSeed,
    hasOlderHistory,
    mergeConversationSnapshot,
    modelVisibility,
    onRequestOlderHistory,
    promptConversationForActive,
    refreshConversations,
    upsertConversation,
  } = args;
  type RedoDraft = {
    messageId: string;
    content: string;
    attachments?: ImageAttachment[];
    backendId?: AgentBackendId;
    mode: EditorMode;
    model: ModelInfo;
  };

  const [redoMessageDraft, setRedoMessageDraft] = useState<RedoDraft | null>(null);

  useEffect(() => {
    setRedoMessageDraft(null);
  }, [conversation?.id]);

  const handleStartRedoMessage = useCallback(
    (message: ChatMessage) => {
      const conv = conversation;
      if (!conv) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Redo Failed",
          message: "No active conversation was available for this message.",
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      if (conv.status === "running" || conv.status === "awaiting_permission") {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before redoing a message.",
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      let seed: RedoInlineComposerSeed;
      try {
        seed = getRedoComposerSeed();
      } catch (error) {
        try {
          seed = buildRedoComposerSeedFromConversation(
            conv,
            backends,
            modelVisibility
          );
        } catch (fallbackError) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: "Redo Failed",
            message: errorMessage(
              fallbackError,
              errorMessage(error, "Composer state unavailable for redo.")
            ),
            autoDismissMs: 8000,
            compact: true,
          });
          return;
        }
      }
      setRedoMessageDraft({
        messageId: message.id,
        content: message.rawContent ?? message.content ?? "",
        attachments: message.attachments?.map((attachment) => ({ ...attachment })),
        backendId: seed.backendId,
        mode: seed.mode,
        model: seed.model,
      });
    },
    [
      backends,
      conversation,
      getRedoComposerSeed,
      modelVisibility,
      pushNotification,
    ]
  );

  const submitRedoMessageDraft = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const conv = conversation;
      if (!conv || !redoMessageDraft) {
        return false;
      }
      if (conv.status === "running" || conv.status === "awaiting_permission") {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before redoing a message.",
          autoDismissMs: 8000,
          compact: true,
        });
        return false;
      }

      try {
        const result = await forkAgentConversation(conv.id, {
          beforeMessageId: redoMessageDraft.messageId,
        });
        let nextConversationId = result.conversation.id;
        let nextConversation = result.conversation;

        const refreshed = await refreshConversations();
        nextConversation =
          refreshed.find((c) => c.id === nextConversationId) ?? nextConversation;

        if (
          redoMessageDraft.backendId &&
          redoMessageDraft.backendId !== nextConversation.config.backendId
        ) {
          const handoffResult = await handoffAgentConversation(
            nextConversationId,
            redoMessageDraft.backendId
          );
          nextConversationId = handoffResult.newConversationId;
          const handedOff = await refreshConversations();
          nextConversation =
            handedOff.find((c) => c.id === nextConversationId) ?? nextConversation;
        }

        const modelId =
          redoMessageDraft.model.modelValue ?? redoMessageDraft.model.id;
        const configPatch: Record<string, unknown> = {};
        if (redoMessageDraft.mode !== nextConversation.config.mode) {
          configPatch.mode = redoMessageDraft.mode;
        }
        if (
          modelId !== nextConversation.config.modelId ||
          redoMessageDraft.model.name !== nextConversation.config.modelName
        ) {
          configPatch.modelId = modelId;
          configPatch.modelName = redoMessageDraft.model.name;
          if (redoMessageDraft.model.configSelections?.length) {
            configPatch.setConfigOptions = redoMessageDraft.model.configSelections;
          }
        }
        if (Object.keys(configPatch).length > 0) {
          const updated = await updateAgentConversationConfig(
            nextConversationId,
            configPatch
          );
          nextConversation = updated.conversation;
          upsertConversation(updated.conversation);
        }

        const snapshot = await fetchAgentConversationSnapshot(nextConversationId);
        mergeConversationSnapshot(snapshot.snapshot);
        exposeForkedConversation?.(
          nextConversationId,
          nextConversation.title ?? "Forked conversation"
        );
        setRedoMessageDraft(null);
        return await promptConversationForActive(nextConversationId, text, attachments);
      } catch (error) {
        const msg = errorMessage(error, "Failed to redo message.");
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Redo Failed",
          message: msg,
          autoDismissMs: 8000,
          compact: true,
        });
        return false;
      }
    },
    [
      conversation,
      exposeForkedConversation,
      mergeConversationSnapshot,
      promptConversationForActive,
      pushNotification,
      redoMessageDraft,
      refreshConversations,
      upsertConversation,
    ]
  );

  const handleForkMessage = useCallback(
    async (messageId: string) => {
      const conv = conversation;
      if (!conv) {
        return;
      }
      if (conv.status === "running" || conv.status === "awaiting_permission") {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before forking.",
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      try {
        const result = await forkAgentConversation(conv.id, {
          upToMessageId: messageId,
        });
        const nextList = await refreshConversations();
        const newConv = nextList.find((c) => c.id === result.conversation.id);
        if (!newConv) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: "Fork Failed",
            message: "Server did not return the new conversation in the workspace list.",
            compact: true,
          });
          return;
        }
        const snap = await fetchAgentConversationSnapshot(result.conversation.id);
        mergeConversationSnapshot(snap.snapshot);
        exposeForkedConversation?.(
          newConv.id,
          newConv.title ?? "Forked conversation"
        );
      } catch (error) {
        const msg = errorMessage(error, "Failed to fork conversation.");
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Fork Failed",
          message: msg,
          autoDismissMs: 8000,
          compact: true,
        });
      }
    },
    [
      conversation,
      exposeForkedConversation,
      mergeConversationSnapshot,
      pushNotification,
      refreshConversations,
    ]
  );

  const renderRedoMessageEditor = useCallback(
    (message: ChatMessage) => {
      if (!redoMessageDraft || redoMessageDraft.messageId !== message.id) {
        return null;
      }
      const activeConv = conversation;
      const targetBackend =
        pickAvailableBackend(backends, redoMessageDraft.backendId) ??
        pickAvailableBackend(backends, activeConv?.config.backendId);

      const redoModels = targetBackend
        ? buildDraftModelOptionsForBackend(targetBackend, modelVisibility)
        : [redoMessageDraft.model];
      const redoModeOptions = targetBackend
        ? buildDraftModeOptionsForBackend(targetBackend)
        : [];
      const modeOptionPool =
        redoModeOptions.length > 0 ? redoModeOptions : DEFAULT_MODE_OPTIONS;
      const redoMode = resolveCanonicalModeId(
        String(redoMessageDraft.mode),
        modeOptionPool
      ) as EditorMode;

      const resolvedComposerBackendId =
        targetBackend?.id ??
        redoMessageDraft.backendId ??
        pickAvailableBackend(backends, undefined)?.id;
      if (!resolvedComposerBackendId) {
        return null;
      }

      return (
        <div className="flex flex-col gap-[6px]">
          <div className="flex items-center justify-between px-[2px]">
            <span className="font-sans text-[11px] text-[var(--text-secondary)]">
              Redo message
            </span>
            <button
              type="button"
              onClick={() => setRedoMessageDraft(null)}
              className="rounded-[5px] px-[6px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          </div>
          <ChatComposer
            key={`redo-${redoMessageDraft.messageId}`}
            mode={redoMode}
            onModeChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, mode: next }
                  : current
              )
            }
            model={redoMessageDraft.model}
            onModelChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, model: next }
                  : current
              )
            }
            backendId={resolvedComposerBackendId}
            backends={backends}
            onBackendChange={(nextBackendId) => {
              const nextBackend = pickAvailableBackend(backends, nextBackendId);
              const nextModel = nextBackend
                ? resolveDraftModelForBackend(nextBackend)
                : redoMessageDraft.model;
              const nextMode = nextBackend
                ? ((buildDraftModeOptionsForBackend(nextBackend)[0]?.id ??
                    redoMessageDraft.mode) as EditorMode)
                : redoMessageDraft.mode;
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? {
                      ...current,
                      backendId: nextBackend?.id ?? nextBackendId,
                      mode: nextMode,
                      model: nextModel,
                    }
                  : current
              );
            }}
            models={redoModels.length > 0 ? redoModels : [redoMessageDraft.model]}
            modeOptions={modeOptionPool}
            value={redoMessageDraft.content}
            onValueChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, content: next }
                  : current
              )
            }
            busy={false}
            configLocked={false}
            onSubmit={(text, attachments) => submitRedoMessageDraft(text, attachments)}
            layout="empty-top"
            shellMxClass=""
            draftAttachments={redoMessageDraft.attachments}
            onDraftAttachmentsChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, attachments: next }
                  : current
              )
            }
            userMessageHistory={composerUserMessageHistory}
            hasMoreOlderUserMessageHistory={hasOlderHistory}
            onRequestOlderUserMessageHistory={onRequestOlderHistory}
          />
        </div>
      );
    },
    [
      backends,
      composerUserMessageHistory,
      conversation,
      hasOlderHistory,
      modelVisibility,
      onRequestOlderHistory,
      redoMessageDraft,
      submitRedoMessageDraft,
    ]
  );

  return {
    editingUserMessageId: redoMessageDraft?.messageId ?? null,
    handleStartRedoMessage,
    handleForkMessage,
    renderRedoMessageEditor,
  };
}
