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
  Import,
  MessageSquare,
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
import {
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { usePersistHomeWorkspaceRailAppearances } from "@/hooks/usePersistHomeWorkspaceRailAppearances";
import { useAgentDraftComposer } from "@/hooks/useAgentDraftComposer";
import type {
  AgentConversationCreateInput,
  AgentImportResult,
} from "@/lib/agent-types";
import { ImportConversationDialog } from "./ImportConversationDialog";
import { NewChatWidgets } from "./NewChatWidgets";
import { WorkspacePickerMenu, WorkspacePickerRowIcon } from "@/components/agent/rail/WorkspacePickerMenu";
import type {
  GitBranchInfo,
  GitWorktreeInfo,
  ImageAttachment,
} from "@/lib/types";
import { isStandaloneChatWorkspace } from "@/lib/types";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { useAgentShellState } from "./AgentShellStateContext";
import {
  CHAT_UI_SHORTCUT_EVENT,
  isChatUiShortcutEvent,
} from "@/lib/chat-ui-shortcut-events";
import { resolveGroupWorkspaceAppearanceKey } from "@/lib/workspace-rail-appearance";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import { sortDirectoryWorkspaces } from "@/lib/multi-server-workspaces";

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


export function AgentNewChatLanding({
  onInstantSubmit,
}: {
  /**
   * Optimistic first-prompt path provided by AgentCenterPane: switches to the
   * conversation view immediately (with the composer split animation) and
   * finishes the server round-trip in the background.
   */
  onInstantSubmit?: (
    input: AgentConversationCreateInput,
    text: string,
    attachments?: ImageAttachment[]
  ) => boolean;
}) {
  const {
    setExpandedComposerController,
    openAgentConversation,
  } = useOpenInEditor();
  const {
    workspaceInfo,
    workspaceSession,
    openWorkspaceById,
    gitStatus,
    refreshGitStatus,
    initializeGitRepo,
    switchBranch,
    createWorktree,
    homeWorkspaceId,
  } = useWorkspace();
  const {
    activeWorkspaceGroup,
    expandedComposerDraftId,
    groups,
    refreshConversationGroups,
    setStandaloneDraftActive,
  } = useAgentShellState();
  const { settings, updateSettings } = useGlobalSettings();
  const { activeServer, servers, setActiveServer } = useServerConnections();
  const { workspaces: directoryWorkspaces } = useWorkspaceDirectory();

  const {
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
    handleSubmit,
  } = useAgentDraftComposer({ onInstantSubmit });

  const isHomeWorkspace = Boolean(
    homeWorkspaceId && activeWorkspaceGroup?.workspace.id === homeWorkspaceId
  );
  const workspaceRailAppearances = settings.general.workspaceRailAppearances;

  useRegisterDesignCaptureComposer(composerDraftId, 9);
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const branchPickerRef = useRef<HTMLButtonElement>(null);
  const workspacePickerRef = useRef<HTMLButtonElement>(null);
  const branchPopoverRef = useRef<HTMLDivElement>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [gitActionBusy, setGitActionBusy] = useState<string | null>(null);
  const [gitActionError, setGitActionError] = useState<string | null>(null);

  const expandedComposerState = useMemo(() => {
    if (expandedComposerDraftId !== composerDraftId) {
      return null;
    }
    return {
      draftId: composerDraftId,
      title: composerDraftTitle,
      mode: draftMode,
      onModeChange: setDraftMode,
      model: draftModel,
      onModelChange: (next: typeof draftModel) => setDraftModel(next),
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
    setDraftMode,
    setDraftModel,
    workspaceSession.chat.backendId,
  ]);

  useEffect(() => {
    if (!isHomeWorkspace) {
      return;
    }
    setBranchPickerOpen(false);
  }, [isHomeWorkspace]);

  useEffect(() => {
    setExpandedComposerController(expandedComposerState);
    return () => {
      setExpandedComposerController(null);
    };
  }, [expandedComposerState, setExpandedComposerController]);

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
    const fromDirectory = directoryWorkspaces.filter(
      (workspace) => !isStandaloneChatWorkspace(workspace)
    );
    if (fromDirectory.length > 0) {
      return sortDirectoryWorkspaces(fromDirectory, settings.general.workspaceSortMode);
    }
    const fromGroups = groups
      .filter((group) => !isStandaloneChatWorkspace(group.workspace))
      .map((group) => ({
        ...group.workspace,
        serverId: group.serverId ?? activeServer.id,
        serverLabel: group.serverLabel ?? activeServer.label,
        serverBaseUrl:
          servers.find((server) => server.id === group.serverId)?.baseUrl ??
          activeServer.baseUrl,
        workspaceKey: resolveGroupWorkspaceAppearanceKey(group, activeServer.id),
        repository: group.repository,
      }));
    return sortDirectoryWorkspaces(fromGroups, settings.general.workspaceSortMode);
  }, [
    activeServer.baseUrl,
    activeServer.id,
    activeServer.label,
    directoryWorkspaces,
    groups,
    servers,
    settings.general.workspaceSortMode,
  ]);

  const homeAppearancePersistEntries = useMemo(
    () =>
      workspacePickerOptions.map((group) => ({
        workspaceKey: group.workspaceKey,
        isHome: Boolean(
          homeWorkspaceId &&
          group.id === homeWorkspaceId &&
          group.serverId === activeServer.id
        ),
      })),
    [activeServer.id, workspacePickerOptions, homeWorkspaceId]
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

  const activeBranchLabel = gitStatus?.isGitRepo
    ? gitStatus.currentBranch ?? "Detached"
    : "No git repo";

  const branchPickerPosition = branchPickerOpen && branchPickerRef.current
    ? branchPickerRef.current.getBoundingClientRect()
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
    setWorkspacePickerOpen(false);
  }, []);

  useEffect(() => {
    if (!branchPickerOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeLandingPickers();
        return;
      }
      if (branchPickerRef.current?.contains(target)) return;
      if (branchPopoverRef.current?.contains(target)) return;
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
  }, [branchPickerOpen, closeLandingPickers]);

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
                  setWorkspacePickerOpen((open) => !open);
                }}
                className="inline-flex min-w-0 max-w-[220px] items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                {noWorkspaceDraft ? (
                  <MessageSquare className="size-[13px] shrink-0" strokeWidth={1.5} />
                ) : activeWorkspaceAppearanceKey ? (
                  <WorkspacePickerRowIcon
                    appearances={workspaceRailAppearances}
                    workspaceKey={activeWorkspaceAppearanceKey}
                    isHome={isHomeWorkspace}
                  />
                ) : (
                  <Folder className="size-[13px] shrink-0" strokeWidth={1.5} />
                )}
                <span className="max-w-[260px] min-w-0 shrink truncate">
                  {noWorkspaceDraft
                    ? "No workspace"
                    : // The rail-derived group can lag behind a freshly created /
                      // opened workspace (cached rail payload); the active
                      // workspace's own name is always current.
                      (activeWorkspaceGroup?.workspace.name ??
                        workspaceInfo?.name ??
                        "Select workspace")}
                </span>
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              {!noWorkspaceDraft && !isHomeWorkspace ? (
              <button
                ref={branchPickerRef}
                type="button"
                aria-label="Open branch picker"
                data-perf="agent-branch-picker-button"
                onClick={() => {
                  setWorkspacePickerOpen(false);
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
              {!noWorkspaceDraft ? (
                <button
                  type="button"
                  aria-label="Import conversation from another harness"
                  title="Import a conversation from Claude Code, Codex, OpenCode, Gemini CLI, or Pi"
                  data-perf="agent-import-conversation-button"
                  onClick={() => {
                    setWorkspacePickerOpen(false);
                    setBranchPickerOpen(false);
                    setImportDialogOpen(true);
                  }}
                  className="inline-flex items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                >
                  <Import className="size-[13px] shrink-0" strokeWidth={1.5} />
                  <span className="whitespace-nowrap">Import</span>
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
                onModeChange={setDraftMode}
                model={draftModel}
                onModelChange={(next) => {
                  setDraftModel(next);
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
              <NewChatWidgets noWorkspaceDraft={noWorkspaceDraft} />
            </>
          ) : null}
        </div>
      </div>
      <WorkspacePickerMenu
        open={workspacePickerOpen}
        onClose={() => setWorkspacePickerOpen(false)}
        anchorRef={workspacePickerRef}
        workspaces={workspacePickerOptions}
        appearances={workspaceRailAppearances}
        homeWorkspaceId={homeWorkspaceId}
        activeServerId={activeServer.id}
        selectedWorkspaceKey={noWorkspaceDraft ? null : activeWorkspaceAppearanceKey}
        onSelectWorkspace={(workspace) => {
          setStandaloneDraftActive(false);
          if (workspace.serverId !== activeServer.id) {
            setActiveServer(workspace.serverId);
          }
          void openWorkspaceById(workspace.id);
        }}
      />
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
      <ImportConversationDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
        onImported={(result: AgentImportResult) => {
          void refreshConversationGroups().catch(() => undefined);
          openAgentConversation({
            conversationId: result.conversationId,
            title: result.title,
          });
        }}
        onOpenExisting={(conversationId, title) => {
          openAgentConversation({ conversationId, title });
        }}
      />
    </div>
  );
}
