"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { AgentCompletionErrorDock } from "@/components/chat/AgentCompletionErrorDock";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ComposerQueueDock } from "@/components/chat/ComposerQueueDock";
import { CHAT_BOTTOM_DOCK_HEIGHT_VAR, MessageList } from "@/components/chat/MessageList";
import { useHeightCssVarRef } from "@/components/ui/scroll-edge-fade";
import { PlanReviewDock, type DockedPlanFile } from "@/components/chat/PlanReviewDock";
import {
  modelChoiceToOverride,
  type PlanBuildModelChoice,
  type PlanBuildRequest,
} from "@/components/chat/PlanBuildControls";
import { useAgentCompletionErrorDock } from "@/components/chat/useAgentCompletionErrorDock";
import { useRedoInlineUserMessage } from "@/components/chat/useRedoInlineUserMessage";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import {
  agentWorkspaceComposerDraftId,
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import {
  findDockedAskQuestion,
  hideDockedAskFromScroll,
} from "@/lib/ask-question-dock";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  extractComposerUserMessageHistory,
  latestGoalProgressStatus,
  projectAgentEventsToChatMessages,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import {
  conversationHasCompletionFailure,
  isAgentComposerBusy,
} from "@/lib/agent-completion-error";
import { updateChatDraftDefault } from "@/lib/chat-draft-defaults";
import { computeContextUsageRefreshGeneration } from "@/lib/context-usage-refresh";
import { DEFAULT_MODE_OPTIONS, isOrchestrationModeLocked, resolveCanonicalModeId } from "@/lib/chat-modes";
import { markConversationSwitchVisible } from "@/lib/dev-perf";
import { buildQueuedConfigOverride } from "@/lib/queued-prompt-utils";
import { deleteAgentConversationQueueItem } from "@/lib/server-api";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationCreateInput,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { EditorMode, ImageAttachment, ModelInfo, QueuedChatPrompt } from "@/lib/types";
import {
  captureComposerSplitSource,
  clearComposerSplitSource,
  runComposerSplitAnimation,
  waitForComposerSplitSettled,
  waitForComposerSplitStart,
} from "@/components/chat/composer-split-animation";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useCesiumProfileCatalog } from "@/hooks/useCesiumProfileCatalog";
import { useShellView } from "@/components/layout/ShellViewContext";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { AgentNewChatLanding } from "./AgentNewChatLanding";
import { VoiceSessionDock } from "@/components/voice/VoiceSessionDock";
import { AuroraBackdrop } from "./AuroraBackdrop";
import { useAuroraScene } from "./AuroraSceneContext";
import { CesiumProfileToggle } from "./CesiumProfileToggle";
import { useAgentShellState } from "./AgentShellStateContext";
import { useAuroraMood } from "@/hooks/useAuroraMood";
import type { AuroraPlacement } from "@/lib/aurora/aurora-renderer";

function pickAvailableBackend(
  backends: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backends.find((backend) => backend.id === preferredBackendId && backend.available) ??
    backends.find((backend) => backend.available) ??
    backends[0] ??
    null
  );
}

/** Stable identity for the no-events case so memos/effects keyed on it don't re-fire every render. */
const EMPTY_THREAD_EVENTS: never[] = [];

/** Synthetic conversation id for the optimistic first-turn view shown before the server ack. */
const OPTIMISTIC_CONVERSATION_ID = "__optimistic-new-chat__";

// The server round-trip and the selection commit are sequenced on the split
// animation's actual lifecycle (`waitForComposerSplitStart` /
// `waitForComposerSplitSettled`): the ack processing floods the main thread,
// so it must not begin before the animation's start frame is committed, and
// the real conversation view (which remounts MessageList + composer via
// `key`) must not swap in mid-flight and kill the FLIP transforms.

type OptimisticNewChatTurn = {
  key: number;
  text: string;
  attachments?: ImageAttachment[];
  backendId?: AgentBackendId;
  createdAt: number;
};

export function AgentCenterPane() {
  const {
    composerDrafts,
    composerSelections,
    setComposerSelection,
    setExpandedComposerController,
    upsertComposerDraft,
    openExplorerFile,
  } = useOpenInEditor();
  const {
    backends,
    conversationsById,
    eventsByConversationId,
    getConversationComposerState,
    getConversationLoadStatus,
    createAndPromptConversation,
    promptConversation,
    cancelConversation,
    pauseConversation,
    resumeConversation,
    pendingConfigByConversationId,
    setPendingConfigForConversation,
    setConversationBackend,
    setConversationConfigOption,
    setConversationMode,
    setConversationModel,
    syncConversationSnapshot,
    mergeConversationSnapshot,
    refreshConversations,
    upsertConversation,
    answerPermissionForConversation,
    answerQuestionForConversation,
    getConversationHistoryCursor,
    loadOlderConversationHistory,
    retryConversation,
  } = useAgentConversations();
  const { settings: globalSettings } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession, workspaceInfo } = useWorkspace();
  const {
    activeWorkspaceGroup,
    conversationSelectionPending,
    expandedComposerDraftId,
    isDraftConversationSelected,
    refreshConversationGroups,
    selectedConversationId,
    setStableConversationView,
    setSelectedConversationId,
    stableConversationView,
  } = useAgentShellState();
  const previousConversationStatusRef = useRef<string | null>(null);

  const conversation = selectedConversationId
    ? conversationsById[selectedConversationId] ?? null
    : null;
  const activeBackend = useMemo(
    () => backends.find((backend) => backend.id === conversation?.config.backendId) ?? null,
    [backends, conversation?.config.backendId]
  );
  const dismissedCompletionErrorKey = selectedConversationId
    ? workspaceSession.chat.dismissedCompletionErrorKeyByConversationId?.[selectedConversationId]
    : undefined;
  const completionErrorDock = useAgentCompletionErrorDock({
    conversation,
    events: selectedConversationId ? eventsByConversationId[selectedConversationId] : undefined,
    backend: activeBackend,
    dismissedKey: dismissedCompletionErrorKey,
    onDismiss: (dismissKey) => {
      if (!selectedConversationId) {
        return;
      }
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          dismissedCompletionErrorKeyByConversationId: {
            ...current.chat.dismissedCompletionErrorKeyByConversationId,
            [selectedConversationId]: dismissKey,
          },
        },
      }));
    },
    onRetry: async (conversationId) => {
      await retryConversation(conversationId);
    },
  });
  const loadState = selectedConversationId
    ? getConversationLoadStatus(selectedConversationId)
    : "idle";

  const rawThreadEvents = conversation
    ? (eventsByConversationId[conversation.id] ?? EMPTY_THREAD_EVENTS)
    : EMPTY_THREAD_EVENTS;
  const openedPlanFilesRef = useRef(new Set<string>());
  useEffect(() => {
    for (const event of rawThreadEvents) {
      if (event.kind !== "plan_file" || openedPlanFilesRef.current.has(event.eventId)) {
        continue;
      }
      openedPlanFilesRef.current.add(event.eventId);
      const normalizedPath = event.path.replace(/\\/g, "/");
      openExplorerFile({
        path: normalizedPath,
        name: event.title ?? normalizedPath.split("/").pop() ?? normalizedPath,
        language: "markdown",
        icon: "plan",
        previewMode: event.previewMode ?? "preview",
        planFile: true,
      });
    }
  }, [openExplorerFile, rawThreadEvents]);
  const deferredThreadEvents = useDeferredValue(rawThreadEvents);
  const contextUsageRefreshGeneration = useMemo(
    () => computeContextUsageRefreshGeneration(rawThreadEvents),
    [rawThreadEvents]
  );
  const goalProgress = useMemo(
    () => latestGoalProgressStatus(rawThreadEvents, conversation?.status),
    [conversation?.status, rawThreadEvents]
  );

  const threadMessages = useMemo(
    () =>
      conversation
        ? projectAgentEventsToChatMessages(deferredThreadEvents, {
            backendId: conversation.config.backendId,
            workspaceRoot: workspaceInfo?.root ?? null,
          })
        : [],
    [conversation, deferredThreadEvents, workspaceInfo?.root]
  );
  const dockedAsk = useMemo(
    () =>
      findDockedAskQuestion({
        events: rawThreadEvents,
        conversation,
      }),
    [conversation, rawThreadEvents]
  );
  const latestPlanFile = useMemo(() => {
    for (let index = rawThreadEvents.length - 1; index >= 0; index -= 1) {
      const event = rawThreadEvents[index];
      if (event?.kind === "plan_file") {
        const normalizedPath = event.path.replace(/\\/g, "/");
        return {
          eventId: event.eventId,
          seq: event.seq,
          path: normalizedPath,
          title: event.title ?? normalizedPath.split("/").pop() ?? normalizedPath,
        };
      }
    }
    return null;
  }, [rawThreadEvents]);
  const dismissedPlanEventByConversationId =
    workspaceSession.chat.dismissedPlanEventByConversationId ?? {};
  const planSuperseded =
    latestPlanFile && rawThreadEvents.some((event) => {
      if (event.seq <= latestPlanFile.seq) return false;
      return event.kind === "user_message" || event.kind === "assistant_message_end";
    });
  const dockedPlan: DockedPlanFile | null =
    conversation &&
    latestPlanFile &&
    !planSuperseded &&
    dismissedPlanEventByConversationId[conversation.id] !== latestPlanFile.eventId
      ? { path: latestPlanFile.path, title: latestPlanFile.title }
      : null;
  const scrollMessages = useMemo(
    () => hideDockedAskFromScroll(threadMessages, dockedAsk),
    [dockedAsk, threadMessages]
  );
  const [submittingQuestion, setSubmittingQuestion] = useState(false);
  const historyCursor = useMemo(() => {
    if (!selectedConversationId) {
      return { hasOlder: false, loadingOlder: false };
    }
    return getConversationHistoryCursor(selectedConversationId);
  }, [getConversationHistoryCursor, selectedConversationId]);
  const composerUserMessageHistory = useMemo(
    () => extractComposerUserMessageHistory(rawThreadEvents),
    [rawThreadEvents]
  );
  const hasConversationHistoryLoaded =
    !!conversation && (conversation.lastEventSeq === 0 || rawThreadEvents.length > 0);

  useEffect(() => {
    if (!selectedConversationId || conversation || loadState === "loading") {
      return;
    }
    void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
  }, [conversation, loadState, selectedConversationId, syncConversationSnapshot]);

  useEffect(() => {
    const previous = previousConversationStatusRef.current;
    const next = conversation?.status ?? null;
    if (
      previous &&
      previous !== next &&
      (previous === "running" || previous === "awaiting_permission")
    ) {
      void refreshConversationGroups();
    }
    previousConversationStatusRef.current = next;
  }, [conversation?.status, refreshConversationGroups]);

  useEffect(() => {
    if (!selectedConversationId) {
      if (!conversationSelectionPending && !isDraftConversationSelected) {
        setStableConversationView(null);
      }
      return;
    }
    if (!conversation || !hasConversationHistoryLoaded) {
      return;
    }
    setStableConversationView({
      conversationId: selectedConversationId,
      messages: scrollMessages,
      conversationBusy:
        isAgentComposerBusy(conversation, eventsByConversationId[selectedConversationId]) ||
        conversation.status === "awaiting_permission",
      hasOlderHistory: historyCursor.hasOlder,
      loadingOlderHistory: historyCursor.loadingOlder,
      initialScrollTop: workspaceSession.chat.scrollTopByTabId[selectedConversationId] ?? 0,
    });
    requestAnimationFrame(() => {
      markConversationSwitchVisible(selectedConversationId, "thread_visible");
    });
  }, [
    conversation,
    hasConversationHistoryLoaded,
    historyCursor.hasOlder,
    historyCursor.loadingOlder,
    conversationSelectionPending,
    isDraftConversationSelected,
    scrollMessages,
    selectedConversationId,
    setStableConversationView,
    workspaceSession.chat.scrollTopByTabId,
  ]);

  const draftBackend = useMemo(
    () => pickAvailableBackend(backends, workspaceSession.chat.backendId),
    [backends, workspaceSession.chat.backendId]
  );
  const draftModels = useMemo(
    () =>
      draftBackend ? buildDraftModelOptionsForBackend(draftBackend) : [workspaceSession.chat.model],
    [draftBackend, workspaceSession.chat.model]
  );
  const draftModel = useMemo(() => {
    if (!draftBackend) {
      return workspaceSession.chat.model;
    }
    const currentModelValue =
      workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
    return (
      draftModels.find((model) => (model.modelValue ?? model.id) === currentModelValue) ??
      resolveDraftModelForBackend(draftBackend)
    );
  }, [draftBackend, draftModels, workspaceSession.chat.model]);
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

  const composerState = conversation ? getConversationComposerState(conversation.id) : null;
  const composerMode = composerState?.mode ?? draftMode;
  const modeLocked = isOrchestrationModeLocked();

  // Capability-profile toggle. Hard rule: it renders ONLY on the brand-new
  // chat landing (never inside an existing conversation, so the transcript
  // top stays clean) and only when the Cesium agent harness is the draft
  // backend. The pick is remembered in workspaceSession.chat.profileId and
  // binds at conversation creation.
  const { openSettingsView } = useShellView();
  const isCesiumDraft = !conversation && draftBackend?.id === "cesium-agent";
  const cesiumProfileCatalog = useCesiumProfileCatalog(isCesiumDraft);
  const profileToggleOptions = useMemo(
    () =>
      cesiumProfileCatalog.catalog.map((profile) => ({
        value: profile.id,
        name: profile.name,
        description: profile.description,
        builtIn: profile.builtIn,
      })),
    [cesiumProfileCatalog.catalog]
  );
  const draftProfileId =
    workspaceSession.chat.profileId?.trim() || cesiumProfileCatalog.defaultProfileId;
  const handleProfileToggle = useCallback(
    (next: string) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: { ...current.chat, profileId: next },
      }));
    },
    [updateWorkspaceSession]
  );
  const handleManageProfiles = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: { ...current.settingsView, activeNav: "agents" },
    }));
    openSettingsView();
  }, [openSettingsView, updateWorkspaceSession]);
  const profileToggleEl =
    isCesiumDraft && profileToggleOptions.length > 0 ? (
      <CesiumProfileToggle
        options={profileToggleOptions}
        activeId={draftProfileId}
        onChange={handleProfileToggle}
        onManage={handleManageProfiles}
      />
    ) : null;

  const getRedoComposerSeed = useCallback(() => {
    if (!conversation || !selectedConversationId) {
      throw new Error("Composer state unavailable for redo.");
    }
    const state = getConversationComposerState(conversation.id);
    if (!state) {
      throw new Error("Composer state unavailable for redo.");
    }
    return {
      backendId: state.backendId,
      mode: state.mode,
      model: state.model,
    };
  }, [conversation, selectedConversationId, getConversationComposerState]);

  const exposeForkedConversationForRedo = useCallback(
    (forkedId: string, _title: string) => {
      updateWorkspaceSession((current) => {
        const removeIds = new Set([forkedId]);
        const nextHidden = current.chat.hiddenConversationIds.filter(
          (id) => !removeIds.has(id)
        );
        return nextHidden.length === current.chat.hiddenConversationIds.length
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                hiddenConversationIds: nextHidden,
              },
            };
      });
      setSelectedConversationId(forkedId);
      void refreshConversationGroups();
    },
    [refreshConversationGroups, setSelectedConversationId, updateWorkspaceSession]
  );

  const promptRedoSubmit = useCallback(
    async (targetId: string, text: string, attachments?: ImageAttachment[]) =>
      promptConversation(targetId, text, attachments),
    [promptConversation]
  );

  const redoFlow = useRedoInlineUserMessage({
    conversation,
    getRedoComposerSeed,
    backends,
    modelVisibility: globalSettings.models.byBackend,
    composerUserMessageHistory,
    hasOlderHistory: historyCursor.hasOlder,
    onRequestOlderHistory: selectedConversationId
      ? () => loadOlderConversationHistory(selectedConversationId)
      : undefined,
    mergeConversationSnapshot,
    refreshConversations,
    upsertConversation,
    promptConversationForActive: promptRedoSubmit,
    exposeForkedConversation: exposeForkedConversationForRedo,
  });

  const composerDraftId =
    selectedConversationId ??
    agentWorkspaceComposerDraftId(activeWorkspaceGroup?.workspace.id);
  const composerDraftTitle =
    conversation?.title && conversation.title !== "New chat"
      ? `${conversation.title} prompt`
      : "Agent prompt";
  useRegisterDesignCaptureComposer(composerDraftId, 10);

  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
  const composerDraftCaptures = composerDrafts[composerDraftId]?.captures;
  const composerDraftTextReferences = composerDrafts[composerDraftId]?.textReferences;
  const composerDraftLinkReferences = composerDrafts[composerDraftId]?.linkReferences;
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };

  /**
   * Instant new-chat spawning: the conversation view renders optimistically
   * the moment the first prompt is submitted (no server round-trip in the
   * critical path), while the composer visually splits — the typed prompt
   * FLIPs into the user-message card at the top of the thread and the emptied
   * shell slides down to its docked spot at the bottom.
   */
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  /** Publishes the dock height so the thread's bottom dissolve can track it. */
  const dockHeightVarRef = useHeightCssVarRef(CHAT_BOTTOM_DOCK_HEIGHT_VAR);
  const [optimisticTurn, setOptimisticTurn] = useState<OptimisticNewChatTurn | null>(null);
  const optimisticSubmitSeqRef = useRef(0);
  const optimisticPendingRef = useRef(false);
  const optimisticFollowUpsRef = useRef<
    Array<{ text: string; attachments?: ImageAttachment[]; delivery?: "normal" | "steer" }>
  >([]);
  const isDraftConversationSelectedRef = useRef(isDraftConversationSelected);
  isDraftConversationSelectedRef.current = isDraftConversationSelected;

  const beginInstantConversation = useCallback(
    (
      input: AgentConversationCreateInput,
      text: string,
      attachments?: ImageAttachment[]
    ) => {
      const key = ++optimisticSubmitSeqRef.current;
      const submittedAt = Date.now();
      const draftIdAtSubmit = composerDraftId;
      const draftTitleAtSubmit = composerDraftTitle;
      captureComposerSplitSource(paneRootRef.current);
      optimisticPendingRef.current = true;
      setOptimisticTurn({
        key,
        text,
        attachments,
        backendId: input.backendId,
        createdAt: submittedAt,
      });
      void (async () => {
        // Let the FLIP's start frame reach the compositor before kicking off
        // the server round-trip; once started, the transforms run composited
        // and survive the ack-processing main-thread jank.
        await waitForComposerSplitStart();
        const created = await createAndPromptConversation(input, text, attachments);
        if (optimisticSubmitSeqRef.current !== key) {
          return;
        }
        if (!created) {
          optimisticPendingRef.current = false;
          const followUps = optimisticFollowUpsRef.current.splice(0);
          clearComposerSplitSource();
          setOptimisticTurn(null);
          // Give the prompt back to the composer instead of losing it.
          upsertComposerDraft(draftIdAtSubmit, {
            title: draftTitleAtSubmit,
            content: [text, ...followUps.map((item) => item.text)].join("\n\n"),
            attachments,
          });
          return;
        }
        void refreshConversationGroups();
        await waitForComposerSplitSettled();
        if (optimisticSubmitSeqRef.current !== key) {
          return;
        }
        optimisticPendingRef.current = false;
        const followUps = optimisticFollowUpsRef.current.splice(0);
        if (!isDraftConversationSelectedRef.current) {
          // The user navigated elsewhere while the ack landed; the chat is
          // in the rail already, so do not yank the selection back.
          setOptimisticTurn(null);
          return;
        }
        setSelectedConversationId(created.id);
        for (const followUp of followUps) {
          void promptConversation(
            created.id,
            followUp.text,
            followUp.attachments,
            undefined,
            followUp.delivery
          );
        }
      })();
      return true;
    },
    [
      composerDraftId,
      composerDraftTitle,
      createAndPromptConversation,
      promptConversation,
      refreshConversationGroups,
      setSelectedConversationId,
      upsertComposerDraft,
    ]
  );

  const [planBuildModelChoice, setPlanBuildModelChoice] =
    useState<PlanBuildModelChoice>("inherit");
  const planBuildModels = composerState?.models ?? draftModels;
  const planBuildCurrentModel = composerState?.model ?? draftModel;
  const dismissLatestPlan = useCallback(() => {
    if (!selectedConversationId || !latestPlanFile) {
      return;
    }
    updateWorkspaceSession((current) => ({
      ...current,
      chat: {
        ...current.chat,
        dismissedPlanEventByConversationId: {
          ...current.chat.dismissedPlanEventByConversationId,
          [selectedConversationId]: latestPlanFile.eventId,
        },
      },
    }));
  }, [latestPlanFile, selectedConversationId, updateWorkspaceSession]);
  const buildFromPlan = useCallback(
    async (plan: DockedPlanFile, request: PlanBuildRequest = { mode: "agent", modelChoice: "inherit" }) => {
      if (!selectedConversationId) {
        return;
      }
      const selectedModel = modelChoiceToOverride(
        request.modelChoice,
        planBuildModels,
        planBuildCurrentModel
      );
      const configOverride = {
        mode: request.mode as EditorMode,
        ...(selectedModel
          ? {
              modelId: selectedModel.modelValue ?? selectedModel.id,
              modelName: selectedModel.name,
            }
          : {}),
      };
      setPendingConfigForConversation(selectedConversationId, configOverride);
      const ok = await promptConversation(
        selectedConversationId,
        `Implement \`${plan.path}\` end-to-end, preserving the plan's requirements and checklist as the source of truth.`,
        undefined,
        configOverride,
        "normal",
        {
          planPath: plan.path,
          planTitle: plan.title,
          targetMode: request.mode as EditorMode,
          ...(selectedModel
            ? {
                targetModelId: selectedModel.modelValue ?? selectedModel.id,
                targetModelName: selectedModel.name,
              }
            : {}),
        }
      );
      if (ok) {
        dismissLatestPlan();
      }
    },
    [
      dismissLatestPlan,
      planBuildCurrentModel,
      planBuildModels,
      promptConversation,
      selectedConversationId,
      setPendingConfigForConversation,
    ]
  );
  useEffect(() => {
    const handleBuild = (event: Event) => {
      const detail = (event as CustomEvent).detail as Partial<DockedPlanFile> & {
        mode?: string;
        modelChoice?: PlanBuildModelChoice;
      };
      if (!detail?.path) return;
      void buildFromPlan(
        {
          path: detail.path,
          title: detail.title ?? detail.path.split("/").pop() ?? detail.path,
        },
        {
          mode:
            detail.mode === "orchestration"
              ? "orchestration"
              : detail.mode === "goal"
                ? "goal"
                : "agent",
          modelChoice: detail.modelChoice ?? planBuildModelChoice,
        }
      );
    };
    window.addEventListener("opencursor:plan-build", handleBuild);
    return () => {
      window.removeEventListener("opencursor:plan-build", handleBuild);
    };
  }, [buildFromPlan, planBuildModelChoice]);
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const queuedPrompts = conversation?.queuedPrompts ?? [];
  const backendLabels = useMemo(
    () => Object.fromEntries(backends.map((backend) => [backend.id, backend.label ?? backend.id])),
    [backends]
  );

  const removeQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
        }
      })();
    },
    [selectedConversationId, syncConversationSnapshot, upsertConversation]
  );

  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
      })();
    },
    [
      composerDraftId,
      composerDraftTitle,
      selectedConversationId,
      syncConversationSnapshot,
      upsertComposerDraft,
      upsertConversation,
    ]
  );

  const editQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
        if (item.configOverride) {
          setPendingConfigForConversation(selectedConversationId, item.configOverride);
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: {
              ...(current.chat.editingQueuedPromptIdByConversationId ?? {}),
              [selectedConversationId]: item.id,
            },
          },
        }));
      })();
    },
    [
      composerDraftId,
      composerDraftTitle,
      selectedConversationId,
      setPendingConfigForConversation,
      syncConversationSnapshot,
      updateWorkspaceSession,
      upsertComposerDraft,
      upsertConversation,
    ]
  );

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) {
        return;
      }
      updateWorkspaceSession((current) => ({
        ...current,
        chat: updateChatDraftDefault(current.chat, {
          backendId: nextBackend.id,
          mode: (buildDraftModeOptionsForBackend(nextBackend)[0]?.id ??
            current.chat.mode) as EditorMode,
          model: resolveDraftModelForBackend(nextBackend),
        }),
      }));
    },
    [backends, updateWorkspaceSession]
  );

  const handleSubmit = useCallback(
    async (
      text: string,
      attachments?: ImageAttachment[],
      options?: { delivery?: "normal" | "steer" }
    ) => {
      const targetConversationId = selectedConversationId;
      if (!targetConversationId) {
        if (optimisticPendingRef.current) {
          // A first prompt is already in flight; deliver this one right after
          // the conversation ack instead of spawning a second conversation.
          optimisticFollowUpsRef.current.push({
            text,
            attachments,
            delivery: options?.delivery,
          });
          return true;
        }
        const backend = draftBackend;
        if (!backend) {
          return false;
        }
        return beginInstantConversation(
          {
            backendId: backend.id,
            mode: draftMode,
            modelId: draftModel.modelValue ?? draftModel.id,
            modelName: draftModel.name,
            ...(backend.id === "cesium-agent" && draftProfileId
              ? { profileId: draftProfileId }
              : {}),
          },
          text,
          attachments
        );
      }
      const targetConversation =
        targetConversationId === conversation?.id
          ? conversation
          : conversationsById[targetConversationId];
      const targetBusy =
        targetConversation?.status === "running" ||
        targetConversation?.status === "awaiting_permission";
      const pendingConfig = pendingConfigByConversationId[targetConversationId];
      const derivedOverride =
        targetBusy && targetConversation && composerState
          ? buildQueuedConfigOverride(
              targetConversation.config,
              composerState.backendId,
              composerState.mode,
              composerState.model
            )
          : undefined;
      const mergedOverride = { ...derivedOverride, ...pendingConfig };
      const configOverride =
        targetBusy && Object.keys(mergedOverride).length > 0 ? mergedOverride : undefined;
      const ok = await promptConversation(
        targetConversationId,
        text,
        attachments,
        configOverride,
        options?.delivery
      );
      if (!ok) {
        return false;
      }
      void refreshConversationGroups();
      return true;
    },
    [
      beginInstantConversation,
      composerState,
      conversation,
      conversationsById,
      draftBackend,
      draftMode,
      draftModel.id,
      draftModel.modelValue,
      draftModel.name,
      draftProfileId,
      pendingConfigByConversationId,
      promptConversation,
      refreshConversationGroups,
      selectedConversationId,
    ]
  );

  const handleComposerModelChange = useCallback(
    (next: ModelInfo, source: "expanded" | "inline") => {
      const nextBackendId =
        (next.backendId as AgentBackendId | undefined) ??
        composerState?.backendId ??
        conversation?.config.backendId ??
        workspaceSession.chat.backendId;
      updateWorkspaceSession((current) => ({
        ...current,
        chat: updateChatDraftDefault(current.chat, {
          backendId: nextBackendId,
          mode: composerMode,
          model: next,
        }),
      }));
      if (selectedConversationId) {
        if (composerState?.busy) {
          if (source === "inline") {
            setPendingConfigForConversation(selectedConversationId, {
              modelId: next.modelValue ?? next.id,
              modelName: next.name,
              setConfigOptions: next.configSelections,
            });
          } else {
            setPendingConfigForConversation(selectedConversationId, {
              modelId: next.modelValue ?? next.id,
              modelName: next.name,
            });
          }
        } else {
          void setConversationModel(selectedConversationId, next);
        }
        return;
      }
    },
    [
      composerMode,
      composerState,
      conversation?.config,
      selectedConversationId,
      setConversationModel,
      setPendingConfigForConversation,
      updateWorkspaceSession,
      workspaceSession.chat.backendId,
    ]
  );

  const handleComposerBackendChange = useCallback(
    (next: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, next);
      const nextModel = nextBackend ? resolveDraftModelForBackend(nextBackend) : null;
      const nextMode = nextBackend
        ? (buildDraftModeOptionsForBackend(nextBackend)[0]?.id ?? composerMode)
        : composerMode;
      if (selectedConversationId) {
        if (nextBackend && nextModel) {
          updateWorkspaceSession((current) => ({
            ...current,
            chat: updateChatDraftDefault(current.chat, {
              backendId: nextBackend.id,
              mode: nextMode as EditorMode,
              model: nextModel,
            }),
          }));
        }
        if (composerState?.busy) {
          setPendingConfigForConversation(selectedConversationId, { backendId: next });
        } else {
          void setConversationBackend(selectedConversationId, next);
        }
        return;
      }
      setDraftBackend(next);
    },
    [
      backends,
      composerMode,
      composerState,
      selectedConversationId,
      setConversationBackend,
      setDraftBackend,
      setPendingConfigForConversation,
      updateWorkspaceSession,
    ]
  );

  const expandedComposerState = useMemo(() => {
    if (expandedComposerDraftId !== composerDraftId) {
      return null;
    }
    return {
      draftId: composerDraftId,
      title: composerDraftTitle,
      mode: composerMode,
      onModeChange: (next: EditorMode) => {
        if (isOrchestrationModeLocked()) {
          return;
        }
        if (selectedConversationId) {
          updateWorkspaceSession((current) => ({
            ...current,
            chat: updateChatDraftDefault(current.chat, {
              backendId: composerState?.backendId ?? conversation?.config.backendId,
              mode: next,
              model: composerState?.model ?? draftModel,
            }),
          }));
          if (composerState?.busy) {
            setPendingConfigForConversation(selectedConversationId, { mode: next });
          } else {
            void setConversationMode(selectedConversationId, next);
          }
          return;
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            mode: next,
          },
        }));
      },
      model: composerState?.model ?? draftModel,
      onModelChange: (next: typeof draftModel) => {
        handleComposerModelChange(next, "expanded");
      },
      backendId:
        composerState?.backendId ?? draftBackend?.id ?? workspaceSession.chat.backendId,
      backends,
      onBackendChange: (next: AgentBackendId) => {
        handleComposerBackendChange(next);
      },
      models: composerState?.models ?? draftModels,
      modeOptions: composerState?.modeOptions ?? draftModeOptions,
      sessionConfigOptions: composerState?.sessionConfigOptions ?? [],
      onSessionConfigOptionChange: (configId: string, value: string) => {
        if (!selectedConversationId) {
          return;
        }
        void setConversationConfigOption(selectedConversationId, configId, value);
      },
      onSubmit: handleSubmit,
      onCancel: () =>
        selectedConversationId
          ? cancelConversation(selectedConversationId)
          : undefined,
      conversationStatus: conversation?.status,
      goalProgress,
      busy: composerState?.busy ?? false,
      configLocked: false,
      modeLocked,
    };
  }, [
    backends,
    goalProgress,
    cancelConversation,
    conversation?.config.backendId,
    conversation?.status,
    composerDraftId,
    composerDraftTitle,
    composerMode,
    composerState,
    draftBackend?.id,
    draftModeOptions,
    draftModel,
    draftModels,
    expandedComposerDraftId,
    handleComposerBackendChange,
    handleComposerModelChange,
    handleSubmit,
    modeLocked,
    selectedConversationId,
    setPendingConfigForConversation,
    setConversationConfigOption,
    setConversationMode,
    updateWorkspaceSession,
    workspaceSession.chat.backendId,
  ]);

  useEffect(() => {
    setExpandedComposerController(expandedComposerState);
    return () => {
      setExpandedComposerController(null);
    };
  }, [expandedComposerState, setExpandedComposerController]);

  const showLanding = isDraftConversationSelected && !conversation && !optimisticTurn;

  const auroraMood = useAuroraMood({
    conversationKey:
      selectedConversationId ?? (optimisticTurn ? OPTIMISTIC_CONVERSATION_ID : "__draft__"),
    status: conversation?.status,
    hasCompletionFailure: conversationHasCompletionFailure(conversation, rawThreadEvents),
    hasDockedQuestion: dockedAsk != null,
    optimisticKey: OPTIMISTIC_CONVERSATION_ID,
    showLanding,
    isTyping: composerDraftText.trim().length > 0,
    workingOverride: Boolean(optimisticTurn),
    reactToActivity: globalSettings.aurora.reactToActivity,
  });

  // Dynamic placement follows the conversation: centered around the landing
  // composer on a new chat, drifting to the top once the thread exists. The
  // renderer glides between the two, riding along with the composer split.
  const auroraPlacement: AuroraPlacement =
    globalSettings.aurora.placement === "dynamic"
      ? showLanding
        ? "center"
        : "top"
      : globalSettings.aurora.placement;

  // When the desktop shell hosts a window-spanning backdrop, publish the
  // scene to it instead of rendering a pane-local canvas.
  const auroraSceneContext = useAuroraScene();
  const setAuroraScene = auroraSceneContext?.setScene;
  useEffect(() => {
    setAuroraScene?.({ mood: auroraMood, placement: auroraPlacement });
  }, [setAuroraScene, auroraMood, auroraPlacement]);
  const showConversationTransitionState =
    !optimisticTurn &&
    (conversationSelectionPending ||
      (!!selectedConversationId && loadState !== "error" && (!conversation || !hasConversationHistoryLoaded)));

  /**
   * Synthetic single-turn view rendered the instant a first prompt is sent.
   * Built through the same event → message projection as real threads so the
   * swap to the server-acked conversation is pixel-identical.
   */
  const optimisticEvents = useMemo<AgentStoredEvent[] | null>(() => {
    if (!optimisticTurn) {
      return null;
    }
    return [
      {
        seq: 1,
        eventId: `optimistic-event-${optimisticTurn.key}`,
        conversationId: OPTIMISTIC_CONVERSATION_ID,
        createdAt: optimisticTurn.createdAt,
        kind: "user_message",
        messageId: `optimistic-message-${optimisticTurn.key}`,
        content: optimisticTurn.text,
        attachments: optimisticTurn.attachments,
      },
    ];
  }, [optimisticTurn]);
  const optimisticConversationView = useMemo(() => {
    if (!optimisticTurn || !optimisticEvents) {
      return null;
    }
    return {
      conversationId: OPTIMISTIC_CONVERSATION_ID,
      messages: projectAgentEventsToChatMessages(optimisticEvents, {
        backendId: optimisticTurn.backendId,
        workspaceRoot: workspaceInfo?.root ?? null,
      }),
      conversationBusy: true,
      hasOlderHistory: false,
      loadingOlderHistory: false,
      initialScrollTop: 0,
    };
  }, [optimisticEvents, optimisticTurn, workspaceInfo?.root]);

  // While the optimistic turn is live, the real view must not take over until
  // its projected messages exist: `threadMessages` derives from
  // `useDeferredValue(rawThreadEvents)`, which can lag a few frames behind the
  // snapshot merge on slower devices — swapping onto an empty projection would
  // blank the just-sent message before popping it back in.
  const realConversationViewReady =
    !!selectedConversationId &&
    !!conversation &&
    hasConversationHistoryLoaded &&
    (!optimisticTurn || scrollMessages.length > 0);
  const visibleConversationView =
    realConversationViewReady && selectedConversationId && conversation
      ? {
          conversationId: selectedConversationId,
          messages: scrollMessages,
          conversationBusy:
            isAgentComposerBusy(conversation, eventsByConversationId[selectedConversationId]) ||
            conversation.status === "awaiting_permission",
          hasOlderHistory: historyCursor.hasOlder,
          loadingOlderHistory: historyCursor.loadingOlder,
          initialScrollTop: workspaceSession.chat.scrollTopByTabId[selectedConversationId] ?? 0,
        }
      : optimisticConversationView ??
        (showConversationTransitionState ? stableConversationView : null);

  // Run the split FLIP right after the optimistic view is in the DOM: the
  // user-message card and docked shell are translated from the captured
  // source rect to their natural spots before the browser paints.
  useLayoutEffect(() => {
    if (optimisticTurn) {
      runComposerSplitAnimation(paneRootRef.current);
    }
  }, [optimisticTurn]);

  // Retire the optimistic view once the real conversation is selected, loaded,
  // and actually rendering the same turn (non-empty projection).
  useEffect(() => {
    if (!optimisticTurn) {
      return;
    }
    if (
      selectedConversationId &&
      conversation &&
      hasConversationHistoryLoaded &&
      scrollMessages.length > 0
    ) {
      setOptimisticTurn(null);
    }
  }, [
    conversation,
    hasConversationHistoryLoaded,
    optimisticTurn,
    scrollMessages.length,
    selectedConversationId,
  ]);
  const emptyState = (
    <div className="absolute inset-0 flex items-center justify-center px-[14px] pb-[220px] sm:px-[20px] max-[480px]:px-0 max-[480px]:pl-[max(0px,env(safe-area-inset-left,0px))] max-[480px]:pr-[max(0px,env(safe-area-inset-right,0px))]">
      <div className={`${AGENT_CENTER_CONTENT_CLASS} text-center`}>
        <p className="font-sans text-[14px] font-normal text-[var(--text-primary)]">
          {activeWorkspaceGroup?.conversations.length
            ? "Select a conversation from the rail or start a new one."
            : "Start the first agent conversation for this workspace."}
        </p>
        <p className="pt-[8px] font-sans text-[12px] font-normal text-[var(--text-secondary)]">
          The new agent shell keeps the conversation centered and lets the workbench stay tucked
          away until you need it.
        </p>
      </div>
    </div>
  );

  // Single shared root for both the landing and the conversation views: the
  // aurora backdrop must not remount across the new-chat commit so its
  // placement can glide instead of snapping.
  return (
    <div
      ref={paneRootRef}
      data-aurora-surface={globalSettings.aurora.enabled ? "on" : undefined}
      className="aurora-center-pane relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)] @container"
    >
      {auroraSceneContext ? null : (
        <AuroraBackdrop mood={auroraMood} placement={auroraPlacement} />
      )}
      {showLanding ? (
      <>
      {profileToggleEl}
      <div className="relative z-10 min-h-0 min-w-0 flex-1">
        <AgentNewChatLanding onInstantSubmit={beginInstantConversation} />
        <VoiceSessionDock wrapperClassName="pointer-events-none absolute inset-x-0 bottom-[20px] z-30 flex justify-center px-[12px]" />
      </div>
      </>
      ) : (
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {visibleConversationView ? (
          <div className={showConversationTransitionState ? "pointer-events-none h-full" : "h-full"}>
            <MessageList
              key={visibleConversationView.conversationId}
              messages={visibleConversationView.messages}
              contentClassName={AGENT_CENTER_CONTENT_CLASS}
              conversationId={visibleConversationView.conversationId}
              composerDraftId={composerDraftId}
              conversationBusy={visibleConversationView.conversationBusy}
              hasOlderHistory={visibleConversationView.hasOlderHistory}
              loadingOlderHistory={visibleConversationView.loadingOlderHistory}
              onRequestOlderHistory={() =>
                loadOlderConversationHistory(visibleConversationView.conversationId)
              }
              initialScrollTop={visibleConversationView.initialScrollTop}
              onScrollTopSettled={(scrollTop) => {
                if (visibleConversationView.conversationId === OPTIMISTIC_CONVERSATION_ID) {
                  return;
                }
                updateWorkspaceSession((current) =>
                  Math.abs(
                    (current.chat.scrollTopByTabId[visibleConversationView.conversationId] ?? 0) -
                      scrollTop
                  ) < 1
                    ? current
                    : {
                        ...current,
                        chat: {
                          ...current.chat,
                          scrollTopByTabId: {
                            ...current.chat.scrollTopByTabId,
                            [visibleConversationView.conversationId]: scrollTop,
                          },
                        },
                      }
                );
              }}
              onResolvePermission={(requestId, optionId) => {
                void answerPermissionForConversation(
                  visibleConversationView.conversationId,
                  requestId,
                  optionId
                );
              }}
              onForkMessage={redoFlow.handleForkMessage}
              onRedoMessage={redoFlow.handleStartRedoMessage}
              renderUserMessageEditor={redoFlow.renderRedoMessageEditor}
              editingUserMessageId={redoFlow.editingUserMessageId}
              bottomDockVisible={!composerHiddenForExpanded && !showConversationTransitionState}
            />
          </div>
        ) : (
          emptyState
        )}

        {!composerHiddenForExpanded && !showConversationTransitionState ? (
          <div
            ref={dockHeightVarRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30"
          >
            <div className="pointer-events-auto chat-bottom-dock">
              <VoiceSessionDock wrapperClassName="pointer-events-none flex justify-center pb-[6px] pt-[8px] px-0 @min-[481px]:px-[10px]" />
              {dockedAsk && visibleConversationView ? (
                <div className="pt-[8px] px-0 @min-[481px]:px-[10px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <AskQuestionCard
                      steps={dockedAsk.steps}
                      dockAboveComposer
                      submitting={submittingQuestion}
                      onSubmit={async (answer) => {
                        setSubmittingQuestion(true);
                        try {
                          await answerQuestionForConversation(
                            visibleConversationView.conversationId,
                            dockedAsk.questionId,
                            answer
                          );
                        } finally {
                          setSubmittingQuestion(false);
                        }
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {dockedPlan ? (
                <div className="pt-[8px] px-0 @min-[481px]:px-[10px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <PlanReviewDock
                      plan={dockedPlan}
                      models={planBuildModels}
                      currentModel={planBuildCurrentModel}
                      modelChoice={planBuildModelChoice}
                      onModelChoiceChange={setPlanBuildModelChoice}
                      onBuild={(request) => void buildFromPlan(dockedPlan, request)}
                      onDismiss={dismissLatestPlan}
                    />
                  </div>
                </div>
              ) : null}
              {queuedPrompts.length > 0 ? (
                <div className="pt-[8px] px-0 @min-[481px]:px-[10px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <ComposerQueueDock
                      items={queuedPrompts}
                      onDelete={removeQueuedPrompt}
                      onUnqueue={unqueuePromptToComposer}
                      onEdit={editQueuedPrompt}
                      conversationConfig={conversation?.config}
                      backendLabels={backendLabels}
                      collapsed={
                        selectedConversationId
                          ? Boolean(
                              workspaceSession.chat.composerQueueDockCollapsedByConversationId?.[
                                selectedConversationId
                              ]
                            )
                          : false
                      }
                      onCollapsedChange={(collapsed) => {
                        if (!selectedConversationId) return;
                        updateWorkspaceSession((current) => {
                          const prev =
                            current.chat.composerQueueDockCollapsedByConversationId ?? {};
                          const m = { ...prev };
                          if (collapsed) {
                            m[selectedConversationId] = true;
                          } else {
                            delete m[selectedConversationId];
                          }
                          return {
                            ...current,
                            chat: {
                              ...current.chat,
                              composerQueueDockCollapsedByConversationId: m,
                            },
                          };
                        });
                      }}
                    />
                  </div>
                </div>
              ) : null}
              <div className="px-0 @min-[481px]:px-[10px]">
                <div className={AGENT_CENTER_CONTENT_CLASS}>
                  {visibleConversationView ? (
                    <AgentCompletionErrorDock dock={completionErrorDock} />
                  ) : null}
                  <ChatComposer
                    key={composerDraftId}
                    mode={composerMode}
                    onModeChange={(next) => {
                      if (isOrchestrationModeLocked()) {
                        return;
                      }
                      if (selectedConversationId) {
                        updateWorkspaceSession((current) => ({
                          ...current,
                          chat: updateChatDraftDefault(current.chat, {
                            backendId: composerState?.backendId ?? conversation?.config.backendId,
                            mode: next as EditorMode,
                            model: composerState?.model ?? draftModel,
                          }),
                        }));
                        if (composerState?.busy) {
                          setPendingConfigForConversation(selectedConversationId, {
                            mode: next as EditorMode,
                          });
                        } else {
                          void setConversationMode(selectedConversationId, next as EditorMode);
                        }
                        return;
                      }
                      updateWorkspaceSession((current) => ({
                        ...current,
                        chat: {
                          ...current.chat,
                          mode: next,
                        },
                      }));
                    }}
                    model={composerState?.model ?? draftModel}
                    onModelChange={(next) => {
                      handleComposerModelChange(next, "inline");
                    }}
                    backendId={composerState?.backendId ?? draftBackend?.id ?? workspaceSession.chat.backendId}
                    backends={backends}
                    onBackendChange={(next) => {
                      handleComposerBackendChange(next);
                    }}
                    models={composerState?.models ?? draftModels}
                    modeOptions={composerState?.modeOptions ?? draftModeOptions}
                    sessionConfigOptions={composerState?.sessionConfigOptions ?? []}
                    onSessionConfigOptionChange={(configId, value) => {
                      if (!selectedConversationId) {
                        return;
                      }
                      void setConversationConfigOption(selectedConversationId, configId, value);
                    }}
                    value={composerDraftText}
                    onValueChange={(next) => {
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        content: next,
                      });
                    }}
                    selection={composerSelection}
                    onSelectionChange={(next) =>
                      setComposerSelection(composerDraftId, next)
                    }
                    agentShellDockHeightExpand
                    busy={composerState?.busy ?? false}
                    configLocked={false}
                    modeLocked={modeLocked}
                    onSubmit={handleSubmit}
                    onCancel={() =>
                      selectedConversationId
                        ? cancelConversation(selectedConversationId)
                        : undefined
                    }
                    onPause={() =>
                      selectedConversationId
                        ? pauseConversation(selectedConversationId)
                        : undefined
                    }
                    onResume={() =>
                      selectedConversationId
                        ? resumeConversation(selectedConversationId)
                        : undefined
                    }
                    conversationStatus={conversation?.status}
                    goalProgress={goalProgress}
                    conversationId={selectedConversationId}
                    contextUsageRefreshGeneration={contextUsageRefreshGeneration}
                    layout="docked-bottom"
                    dockedCardVisible={
                      (visibleConversationView != null &&
                        (dockedAsk != null || completionErrorDock.visible)) ||
                      dockedPlan != null ||
                      queuedPrompts.length > 0
                    }
                    draftAttachments={composerDraftAttachments}
                    onDraftAttachmentsChange={(next) =>
                      // Do not pass `content` here — submit clears text then
                      // immediately clears attachments; a stale `content`
                      // closure would resurrect the prompt in the composer.
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        attachments: next,
                      })
                    }
                    draftCaptures={composerDraftCaptures}
                    onDraftCapturesChange={(next) =>
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        captures: next,
                      })
                    }
                    draftTextReferences={composerDraftTextReferences}
                    onDraftTextReferencesChange={(next) =>
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        textReferences: next,
                      })
                    }
                    draftLinkReferences={composerDraftLinkReferences}
                    onDraftLinkReferencesChange={(next) =>
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        linkReferences: next,
                      })
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      )}
    </div>
  );
}
