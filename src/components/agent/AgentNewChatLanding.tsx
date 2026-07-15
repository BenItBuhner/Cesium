"use client";

import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Cloud,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Laptop,
  Plus,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import {
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { usePersistHomeWorkspaceRailAppearances } from "@/hooks/usePersistHomeWorkspaceRailAppearances";
import type { WorkspaceRailAppearance } from "@/lib/global-settings";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import {
  DEFAULT_MODE_OPTIONS,
  filterGoalModeOptions,
  resolveCanonicalModeId,
} from "@/lib/chat-modes";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import type {
  EditorMode,
  GitBranchInfo,
  GitWorktreeInfo,
  ImageAttachment,
} from "@/lib/types";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { useAgentShellState } from "./AgentShellStateContext";
import {
  CHAT_UI_SHORTCUT_EVENT,
  isChatUiShortcutEvent,
} from "@/lib/chat-ui-shortcut-events";
import {
  getWorkspaceRailAppearance,
  resolveGroupWorkspaceAppearanceKey,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";

function pickAvailableBackend(
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

type BranchPickerItem = {
  key: string;
  branch: GitBranchInfo;
  localBranchName: string;
  localBranchExists: boolean;
  worktree: GitWorktreeInfo | null;
  icon: "remote" | "worktree" | null;
};

function localBranchNameForRemote(branchName: string): string {
  return branchName.replace(/^[^/]+\//, "");
}

const QUICK_ACTION_BUTTON_CLASSNAME =
  "inline-flex max-w-full items-center gap-[4px] rounded-[var(--agent-pill-radius)] border border-[var(--agent-border)] bg-[var(--agent-panel-bg)] px-[14px] py-[7px] text-left font-sans text-[12px] leading-none font-normal text-[var(--text-primary)] whitespace-nowrap transition-colors hover:bg-[var(--agent-card-hover-bg)]";

function WorkspacePickerIcon({
  appearances,
  workspaceKey,
  isHome,
  className = "size-[13px] shrink-0",
  strokeWidth = 1.5,
}: {
  appearances: Record<string, WorkspaceRailAppearance>;
  workspaceKey: string;
  isHome: boolean;
  className?: string;
  strokeWidth?: number;
}) {
  const appearance = getWorkspaceRailAppearance(appearances, workspaceKey, { isHome });
  return (
    <WorkspaceFolderIcon
      iconName={appearance.icon}
      color={appearance.color}
      className={className}
      strokeWidth={strokeWidth}
    />
  );
}

export function AgentNewChatLanding() {
  const {
    composerDrafts,
    composerSelections,
    setComposerSelection,
    setExpandedComposerController,
    upsertComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
    createAndPromptConversation,
  } = useAgentConversations();
  const {
    workspaceSession,
    updateWorkspaceSession,
    openWorkspaceById,
    gitStatus,
    refreshGitStatus,
    initializeGitRepo,
    switchBranch,
    createWorktree,
    deleteWorktree,
    homeWorkspaceId,
  } = useWorkspace();
  const {
    activeWorkspaceGroup,
    expandedComposerDraftId,
    groups,
    refreshConversationGroups,
    setSelectedConversationId,
    setRightPaneOpen,
  } = useAgentShellState();
  const { settings, updateSettings } = useGlobalSettings();
  const goalModeBetaEnabled = settings.features.goalModeBeta;
  const { activeServer, setActiveServer } = useServerConnections();
  const { workspaces: directoryWorkspaces } = useWorkspaceDirectory();
  const runCommand = useIDECommandRunner();

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
    if (!draftBackend) return workspaceSession.chat.model;
    const currentModelValue =
      workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
    return (
      draftModels.find((m) => (m.modelValue ?? m.id) === currentModelValue) ??
      resolveDraftModelForBackend(draftBackend)
    );
  }, [draftBackend, draftModels, workspaceSession.chat.model]);
  const draftModeOptions = useMemo(
    () =>
      draftBackend
        ? buildDraftModeOptionsForBackend(draftBackend, { goalModeBetaEnabled })
        : filterGoalModeOptions(DEFAULT_MODE_OPTIONS, goalModeBetaEnabled),
    [draftBackend, goalModeBetaEnabled]
  );
  const draftMode = useMemo(
    () =>
      resolveCanonicalModeId(
        String(workspaceSession.chat.mode ?? draftModeOptions[0]?.id ?? "agent"),
        draftModeOptions
      ) as EditorMode,
    [draftModeOptions, workspaceSession.chat.mode]
  );

  const isHomeWorkspace = Boolean(
    homeWorkspaceId && activeWorkspaceGroup?.workspace.id === homeWorkspaceId
  );
  const workspaceRailAppearances = settings.general.workspaceRailAppearances;

  const composerDraftId = `agent-draft:${activeWorkspaceGroup?.workspace.id ?? "workspace"}`;
  const composerDraftTitle = "Agent prompt";
  useRegisterDesignCaptureComposer(composerDraftId, 9);
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
  const composerDraftCaptures = composerDrafts[composerDraftId]?.captures;
  const composerDraftTextReferences = composerDrafts[composerDraftId]?.textReferences;
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const branchPickerRef = useRef<HTMLButtonElement>(null);
  const workspacePickerRef = useRef<HTMLButtonElement>(null);
  const targetPickerRef = useRef<HTMLButtonElement>(null);
  const branchPopoverRef = useRef<HTMLDivElement>(null);
  const workspacePopoverRef = useRef<HTMLDivElement>(null);
  const targetPopoverRef = useRef<HTMLDivElement>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [gitActionBusy, setGitActionBusy] = useState<string | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) return;
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          backendId: nextBackend.id,
          mode:
            buildDraftModeOptionsForBackend(nextBackend, { goalModeBetaEnabled })[0]?.id ??
            current.chat.mode,
          model: resolveDraftModelForBackend(nextBackend),
        },
      }));
    },
    [backends, goalModeBetaEnabled, updateWorkspaceSession]
  );

  const handleSubmit = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const backend = draftBackend;
      if (!backend) return false;
      const worktreeMatch = text.match(/^\/worktree\b([\s\S]*)$/i);
      const deleteWorktreeMatch = text.match(/^\/delete-worktree\b/i);
      if (deleteWorktreeMatch) {
        const currentWorktree = gitStatus?.worktrees.find((worktree) => worktree.current);
        if (!currentWorktree) return false;
        if (currentWorktree.current) {
          window.alert("Open another checkout first, then delete this worktree from Workspace Studio.");
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
      const created = await createAndPromptConversation({
        backendId: backend.id,
        mode: draftMode,
        modelId: draftModel.modelValue ?? draftModel.id,
        modelName: draftModel.name,
      }, promptText, attachments);
      if (!created) return false;
      setSelectedConversationId(created.id);
      void refreshConversationGroups();
      return true;
    },
    [
      createAndPromptConversation,
      draftBackend,
      draftMode,
      draftModel.id,
      draftModel.modelValue,
      draftModel.name,
      createWorktree,
      deleteWorktree,
      gitStatus?.currentBranch,
      gitStatus?.worktrees,
      refreshConversationGroups,
      setSelectedConversationId,
    ]
  );

  const expandedComposerState = useMemo(() => {
    if (expandedComposerDraftId !== composerDraftId) {
      return null;
    }
    return {
      draftId: composerDraftId,
      title: composerDraftTitle,
      mode: draftMode,
      onModeChange: (next: EditorMode) =>
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            mode: next,
          },
        })),
      model: draftModel,
      onModelChange: (next: typeof draftModel) =>
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            model: next,
          },
        })),
      backendId: draftBackend?.id ?? workspaceSession.chat.backendId,
      backends,
      onBackendChange: setDraftBackend,
      models: draftModels,
      modeOptions: draftModeOptions,
      sessionConfigOptions: [],
      onSessionConfigOptionChange: undefined,
      onSubmit: handleSubmit,
      onCancel: undefined,
      busy: false,
      configLocked: false,
    };
  }, [
    backends,
    composerDraftId,
    composerDraftTitle,
    draftBackend?.id,
    draftMode,
    draftModeOptions,
    draftModel,
    draftModels,
    expandedComposerDraftId,
    handleSubmit,
    setDraftBackend,
    updateWorkspaceSession,
    workspaceSession.chat.backendId,
  ]);

  useEffect(() => {
    if (!isHomeWorkspace) {
      return;
    }
    setBranchPickerOpen(false);
    setTargetPickerOpen(false);
  }, [isHomeWorkspace]);

  useEffect(() => {
    setExpandedComposerController(expandedComposerState);
    return () => {
      setExpandedComposerController(null);
    };
  }, [expandedComposerState, setExpandedComposerController]);

  const planShortcutHint = useMemo(() => {
    return (
      getShortcutDisplayForCommand(
        settings.keyboardShortcuts.bindings,
        "workbench.action.focusChatPlanMode",
        detectShortcutPlatform()
      ) || "Mod+I"
    );
  }, [settings.keyboardShortcuts.bindings]);

  const branchPickerItems = useMemo<BranchPickerItem[]>(() => {
    const branches = gitStatus?.branches ?? [];
    const worktrees = gitStatus?.worktrees ?? [];
    const localBranchNames = new Set(
      branches
        .filter((branch) => branch.type === "local")
        .map((branch) => branch.name)
    );
    const worktreeByBranch = new Map<string, GitWorktreeInfo>();
    for (const worktree of worktrees) {
      if (worktree.branch && !worktreeByBranch.has(worktree.branch)) {
        worktreeByBranch.set(worktree.branch, worktree);
      }
    }

    return branches.flatMap((branch) => {
      const localBranchName =
        branch.type === "remote" ? localBranchNameForRemote(branch.name) : branch.name;
      const localBranchExists = localBranchNames.has(localBranchName);
      const worktree = worktreeByBranch.get(localBranchName) ?? null;
      if (branch.type === "remote" && (localBranchExists || worktree)) {
        return [];
      }
      return [
        {
          key: `${branch.type}:${branch.name}`,
          branch,
          localBranchName,
          localBranchExists,
          worktree,
          icon:
            branch.type === "remote"
              ? "remote"
              : worktree && !branch.current
                ? "worktree"
                : null,
        },
      ];
    });
  }, [gitStatus?.branches, gitStatus?.worktrees]);

  const filteredBranchItems = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    if (!q) {
      return branchPickerItems.slice(0, 80);
    }
    return branchPickerItems
      .filter((item) => item.branch.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [branchPickerItems, branchQuery]);

  const workspacePickerOptions = useMemo(() => {
    const fromDirectory = directoryWorkspaces
      .filter((workspace) => workspace.serverId === activeServer.id)
      .map((workspace) => ({
        workspace,
        workspaceKey: workspace.workspaceKey,
        serverId: workspace.serverId,
        serverLabel: workspace.serverLabel,
      }));
    if (fromDirectory.length > 0) {
      return fromDirectory;
    }
    return groups
      .filter((group) => !group.serverId || group.serverId === activeServer.id)
      .map((group) => ({
        workspace: group.workspace,
        workspaceKey: resolveGroupWorkspaceAppearanceKey(group, activeServer.id),
        serverId: group.serverId,
        serverLabel: group.serverLabel,
      }));
  }, [activeServer.id, directoryWorkspaces, groups]);

  const homeAppearancePersistEntries = useMemo(
    () =>
      workspacePickerOptions.map((group) => ({
        workspaceKey: group.workspaceKey,
        isHome: Boolean(homeWorkspaceId && group.workspace.id === homeWorkspaceId),
      })),
    [workspacePickerOptions, homeWorkspaceId]
  );
  usePersistHomeWorkspaceRailAppearances(
    workspaceRailAppearances,
    homeAppearancePersistEntries,
    updateSettings
  );

  const activeWorkspaceAppearanceKey = useMemo(() => {
    if (!activeWorkspaceGroup) {
      return null;
    }
    return resolveGroupWorkspaceAppearanceKey(activeWorkspaceGroup, activeServer.id);
  }, [activeServer.id, activeWorkspaceGroup]);

  const filteredWorkspaceGroups = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase();
    if (!q) return workspacePickerOptions;
    return workspacePickerOptions.filter(
      (g) =>
        g.workspace.name.toLowerCase().includes(q) ||
        g.serverLabel?.toLowerCase().includes(q)
    );
  }, [workspacePickerOptions, workspaceQuery]);

  const activeBranchLabel = gitStatus?.isGitRepo
    ? gitStatus.currentBranch ?? "Detached"
    : "No git repo";

  const branchPickerPosition = branchPickerOpen && branchPickerRef.current
    ? branchPickerRef.current.getBoundingClientRect()
    : null;
  const workspacePickerPosition =
    workspacePickerOpen && workspacePickerRef.current
      ? workspacePickerRef.current.getBoundingClientRect()
      : null;
  const targetPickerPosition = targetPickerOpen && targetPickerRef.current
    ? targetPickerRef.current.getBoundingClientRect()
    : null;

  const runGitAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setGitActionBusy(key);
      setGitActionError(null);
      try {
        await action();
      } catch (error) {
        setGitActionError(error instanceof Error ? error.message : "Git action failed.");
      } finally {
        setGitActionBusy(null);
      }
    },
    []
  );

  const closeLandingPickers = useCallback(() => {
    setBranchPickerOpen(false);
    setTargetPickerOpen(false);
    setWorkspacePickerOpen(false);
    setWorkspaceQuery("");
  }, []);

  useEffect(() => {
    if (!branchPickerOpen && !targetPickerOpen && !workspacePickerOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeLandingPickers();
        return;
      }
      if (branchPickerRef.current?.contains(target)) return;
      if (workspacePickerRef.current?.contains(target)) return;
      if (targetPickerRef.current?.contains(target)) return;
      if (branchPopoverRef.current?.contains(target)) return;
      if (workspacePopoverRef.current?.contains(target)) return;
      if (targetPopoverRef.current?.contains(target)) return;
      closeLandingPickers();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closeLandingPickers();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [branchPickerOpen, closeLandingPickers, targetPickerOpen, workspacePickerOpen]);

  useEffect(() => {
    if (workspacePickerOpen) {
      setWorkspaceQuery("");
    }
  }, [workspacePickerOpen]);

  const handleInitializeGitRepo = useCallback(async () => {
    await runGitAction("git-init", async () => {
      await initializeGitRepo();
      setBranchPickerOpen(false);
      setBranchQuery("");
    });
  }, [initializeGitRepo, runGitAction]);

  const handleBranchSwitch = useCallback(
    async (branchName: string) => {
      await runGitAction(`switch:${branchName}`, async () => {
        await switchBranch(branchName);
        setBranchPickerOpen(false);
      });
    },
    [runGitAction, switchBranch]
  );

  const handleBranchWorktree = useCallback(
    async (branchName: string, localBranchName: string, localBranchExists: boolean) => {
      await runGitAction(`worktree:${branchName}`, async () => {
        await createWorktree({
          branch: localBranchName,
          baseBranch: branchName,
          newBranch: !localBranchExists,
        });
        setBranchPickerOpen(false);
      });
    },
    [createWorktree, runGitAction]
  );

  const handleNewBranchWorktree = useCallback(async () => {
    const name = window.prompt("New branch name");
    if (!name?.trim()) {
      return;
    }
    await runGitAction(`new:${name}`, async () => {
      await createWorktree({
        branch: name.trim(),
        baseBranch: gitStatus?.currentBranch ?? undefined,
        newBranch: true,
      });
      setBranchPickerOpen(false);
    });
  }, [createWorktree, gitStatus?.currentBranch, runGitAction]);

  useEffect(() => {
    const onShortcut = (e: Event) => {
      if (!isChatUiShortcutEvent(e)) return;
      if (e.detail.target !== "workspacePicker") return;
      if (!workspacePickerRef.current) return;
      setBranchPickerOpen(false);
      setTargetPickerOpen(false);
      setWorkspacePickerOpen(true);
    };
    window.addEventListener(CHAT_UI_SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(CHAT_UI_SHORTCUT_EVENT, onShortcut);
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        className={`flex w-full flex-col items-stretch gap-[2px] ${AGENT_CENTER_CONTENT_CLASS}`}
      >
        <div className="mx-0 flex min-w-0 flex-col gap-[2px] @min-[481px]:mx-[10px]">
          <div className="w-fit max-w-full self-start">
            <div className="flex max-w-full flex-wrap items-center gap-[6px]">
              <button
                ref={workspacePickerRef}
                type="button"
                aria-label="Open workspace picker"
                data-perf="agent-codebase-picker-button"
                onClick={() => {
                  setBranchPickerOpen(false);
                  setTargetPickerOpen(false);
                  setWorkspacePickerOpen((open) => !open);
                }}
                className="inline-flex min-w-0 max-w-[220px] items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                {activeWorkspaceAppearanceKey ? (
                  <WorkspacePickerIcon
                    appearances={workspaceRailAppearances}
                    workspaceKey={activeWorkspaceAppearanceKey}
                    isHome={isHomeWorkspace}
                  />
                ) : (
                  <Folder className="size-[13px] shrink-0" strokeWidth={1.5} />
                )}
                <span className="max-w-[260px] min-w-0 shrink truncate">
                  {activeWorkspaceGroup?.workspace.name ?? "Select workspace"}
                </span>
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              {!isHomeWorkspace ? (
              <button
                ref={branchPickerRef}
                type="button"
                aria-label="Open branch picker"
                data-perf="agent-branch-picker-button"
                onClick={() => {
                  setWorkspacePickerOpen(false);
                  setTargetPickerOpen(false);
                  setBranchPickerOpen((open) => !open);
                  void refreshGitStatus().catch(() => undefined);
                }}
                className="inline-flex min-w-0 max-w-[220px] items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                <GitBranch className="size-[13px] shrink-0" strokeWidth={1.5} />
                <span className="truncate">{activeBranchLabel}</span>
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              ) : null}
              {!isHomeWorkspace ? (
              <button
                ref={targetPickerRef}
                type="button"
                aria-label="Open local target picker"
                data-perf="agent-worktree-target-picker-button"
                onClick={() => {
                  setBranchPickerOpen(false);
                  setWorkspacePickerOpen(false);
                  setTargetPickerOpen((open) => !open);
                }}
                className="inline-flex items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                <Laptop className="size-[13px] shrink-0" strokeWidth={1.5} />
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              ) : null}
            </div>
            {gitActionError ? (
              <div className="mt-[6px] max-w-[520px] rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-card)] px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-primary)]">
                {gitActionError}
              </div>
            ) : null}
          </div>

          {!composerHiddenForExpanded ? (
            <>
              <ChatComposer
                key={composerDraftId}
                mode={draftMode}
                onModeChange={(next) => {
                  updateWorkspaceSession((current) => ({
                    ...current,
                    chat: { ...current.chat, mode: next },
                  }));
                }}
                model={draftModel}
                onModelChange={(next) => {
                  updateWorkspaceSession((current) => ({
                    ...current,
                    chat: { ...current.chat, model: next },
                  }));
                }}
                backendId={draftBackend?.id ?? workspaceSession.chat.backendId}
                backends={backends}
                onBackendChange={(next) => setDraftBackend(next)}
                models={draftModels}
                modeOptions={draftModeOptions}
                sessionConfigOptions={[]}
                onSessionConfigOptionChange={() => undefined}
                value={composerDraftText}
                onValueChange={(next) => {
                  upsertComposerDraft(composerDraftId, {
                    title: composerDraftTitle,
                    content: next,
                  });
                }}
                selection={composerSelection}
                onSelectionChange={(next) => setComposerSelection(composerDraftId, next)}
                agentShellDockHeightExpand
                busy={false}
                configLocked={false}
                onSubmit={handleSubmit}
                onCancel={() => undefined}
                gitSlashCommands={Boolean(gitStatus)}
                layout="empty-top"
                shellMxClass=""
                draftAttachments={composerDraftAttachments}
                onDraftAttachmentsChange={(next) =>
                  upsertComposerDraft(composerDraftId, {
                    title: composerDraftTitle,
                    content: composerDraftText,
                    attachments: next,
                  })
                }
                draftCaptures={composerDraftCaptures}
                onDraftCapturesChange={(next) =>
                  upsertComposerDraft(composerDraftId, {
                    title: composerDraftTitle,
                    content: composerDraftText,
                    captures: next,
                  })
                }
                draftTextReferences={composerDraftTextReferences}
                onDraftTextReferencesChange={(next) =>
                  upsertComposerDraft(composerDraftId, {
                    title: composerDraftTitle,
                    content: composerDraftText,
                    textReferences: next,
                  })
                }
              />
              <div className="mt-[10px] flex w-full min-w-0 flex-wrap items-center gap-[10px]">
                <button
                  type="button"
                  onClick={() => runCommand?.("workbench.action.focusChatPlanMode")}
                  className={QUICK_ACTION_BUTTON_CLASSNAME}
                >
                  Plan new idea{" "}
                  <span className="text-[var(--text-secondary)]">({planShortcutHint})</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRightPaneOpen(true);
                  }}
                  className={QUICK_ACTION_BUTTON_CLASSNAME}
                >
                  Open editor panel
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {workspacePickerOpen && workspacePickerPosition
        ? createPortal(
            <div
              ref={workspacePopoverRef}
              data-perf="agent-workspace-picker-popover"
              className="fixed z-[10002] w-[min(280px,calc(100vw-16px))] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
              style={{
                top: workspacePickerPosition.bottom + 6,
                left: Math.max(8, Math.min(workspacePickerPosition.left, window.innerWidth - 288)),
              }}
              data-ide-input-sink
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--border-card)] px-[10px] py-[7px]">
                <input
                  value={workspaceQuery}
                  onChange={(event) => setWorkspaceQuery(event.target.value)}
                  placeholder="Search workspaces..."
                  className="w-full bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                  autoFocus={shouldAutoFocusTextInput()}
                />
              </div>
              <VerticalFadedScroll
                measureKey={`${workspaceQuery}\0${filteredWorkspaceGroups.length}`}
                scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
              >
                {filteredWorkspaceGroups.map((group) => {
                  const groupKey = group.workspaceKey;
                  const current = groupKey === activeWorkspaceAppearanceKey;
                  const isHomeRow =
                    Boolean(homeWorkspaceId) && group.workspace.id === homeWorkspaceId;
                  return (
                    <div
                      key={groupKey}
                      className="group flex items-center gap-[6px] rounded-[var(--radius-tab)] px-[8px] py-[5px] font-sans text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void (async () => {
                            if (group.serverId && group.serverId !== activeServer.id) {
                              setActiveServer(group.serverId);
                            }
                            await openWorkspaceById(group.workspace.id);
                          })();
                          setWorkspacePickerOpen(false);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-[8px] truncate text-left"
                      >
                        <WorkspacePickerIcon
                          appearances={workspaceRailAppearances}
                          workspaceKey={groupKey}
                          isHome={isHomeRow}
                        />
                        <span className="min-w-0 flex-1 truncate">{group.workspace.name}</span>
                      </button>
                      {current ? (
                        <Check className="size-[13px] shrink-0" strokeWidth={2} />
                      ) : null}
                    </div>
                  );
                })}
                {filteredWorkspaceGroups.length === 0 ? (
                  <div className="px-[8px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
                    No workspaces found
                  </div>
                ) : null}
              </VerticalFadedScroll>
              <div className="border-t border-[var(--border-card)] p-[4px]">
                <button
                  type="button"
                  onClick={() => {
                    runCommand?.("workbench.action.createWorkspace");
                    setWorkspacePickerOpen(false);
                  }}
                  className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                >
                  <Plus className="size-[13px] shrink-0" strokeWidth={1.5} />
                  New workspace
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
      {branchPickerOpen && branchPickerPosition
        ? createPortal(
            <div
              ref={branchPopoverRef}
              data-perf="agent-branch-picker-popover"
              className="fixed z-[10002] w-[min(280px,calc(100vw-16px))] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
              style={{
                top: branchPickerPosition.bottom + 6,
                left: Math.max(8, Math.min(branchPickerPosition.left, window.innerWidth - 288)),
              }}
              data-ide-input-sink
              onPointerDown={(event) => event.stopPropagation()}
            >
              {gitStatus === null ? (
                <div className="px-[10px] py-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
                  Loading git status...
                </div>
              ) : gitStatus.isGitRepo ? (
                <>
                  <div className="border-b border-[var(--border-card)] px-[10px] py-[7px]">
                    <input
                      value={branchQuery}
                      onChange={(event) => setBranchQuery(event.target.value)}
                      placeholder="Search branches..."
                      className="w-full bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                      autoFocus={shouldAutoFocusTextInput()}
                    />
                  </div>
                  <VerticalFadedScroll
                    measureKey={`${branchQuery}\0${filteredBranchItems.length}`}
                    scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
                  >
                    {filteredBranchItems.map((item) => {
                      const Icon =
                        item.icon === "remote"
                          ? Cloud
                          : item.icon === "worktree"
                            ? FolderGit2
                            : null;
                      const busy =
                        gitActionBusy === `switch:${item.branch.name}` ||
                        gitActionBusy === `worktree:${item.branch.name}`;
                      return (
                        <div
                          key={item.key}
                          className="group flex items-center gap-[6px] rounded-[var(--radius-tab)] px-[8px] py-[5px] font-sans text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                        >
                          {Icon ? <Icon className="size-[13px] shrink-0" strokeWidth={1.5} /> : null}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              item.branch.type === "remote"
                                ? void handleBranchWorktree(
                                    item.branch.name,
                                    item.localBranchName,
                                    item.localBranchExists
                                  )
                                : void handleBranchSwitch(item.branch.name)
                            }
                            className="min-w-0 flex-1 truncate text-left disabled:cursor-not-allowed disabled:opacity-60"
                            title={
                              item.branch.type === "remote"
                                ? "Open this branch in a new worktree"
                                : item.worktree && !item.branch.current
                                  ? "Open this branch's worktree"
                                  : "Switch this workspace to this branch"
                            }
                          >
                            {item.branch.name}
                          </button>
                          {item.branch.current ? <Check className="size-[13px] shrink-0" strokeWidth={2} /> : null}
                        </div>
                      );
                    })}
                    {filteredBranchItems.length === 0 ? (
                      <div className="px-[8px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
                        No branches found
                      </div>
                    ) : null}
                  </VerticalFadedScroll>
                  <div className="border-t border-[var(--border-card)] p-[4px]">
                    <button
                      type="button"
                      disabled={gitActionBusy != null}
                      onClick={() => void handleNewBranchWorktree()}
                      className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
                    >
                      <GitFork className="size-[13px] shrink-0" strokeWidth={1.5} />
                      New branch in worktree...
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="px-[10px] py-[10px] font-sans text-[12.5px] leading-snug text-[var(--text-secondary)]">
                    This folder is not a git repository yet.
                  </div>
                  <div className="border-t border-[var(--border-card)] p-[4px]">
                    <button
                      type="button"
                      disabled={gitActionBusy != null}
                      onClick={() => void handleInitializeGitRepo()}
                      className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
                    >
                      <GitBranch className="size-[13px] shrink-0" strokeWidth={1.5} />
                      Initialize repository
                    </button>
                  </div>
                </>
              )}
            </div>,
            document.body
          )
        : null}
      {targetPickerOpen && targetPickerPosition
        ? createPortal(
            <div
              ref={targetPopoverRef}
              data-perf="agent-worktree-target-picker-popover"
              className="fixed z-[10002] w-[220px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
              style={{
                top: targetPickerPosition.bottom + 6,
                left: Math.max(8, Math.min(targetPickerPosition.left, window.innerWidth - 228)),
              }}
              data-ide-input-sink
              onPointerDown={(event) => event.stopPropagation()}
            >
              <VerticalFadedScroll
                measureKey={gitActionBusy ?? "idle"}
                scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
              >
                <div className="flex items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] font-sans text-[12.5px] text-[var(--text-primary)]">
                  <Laptop className="size-[14px] shrink-0" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1">This device</span>
                  <Check className="size-[13px] shrink-0" strokeWidth={2} />
                </div>
                <button
                  type="button"
                  disabled={!gitStatus?.isGitRepo || gitActionBusy != null}
                  onClick={() => void handleNewBranchWorktree()}
                  className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
                >
                  <GitFork className="size-[14px] shrink-0" strokeWidth={1.5} />
                  New worktree
                </button>
              </VerticalFadedScroll>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
