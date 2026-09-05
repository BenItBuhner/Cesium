"use client";

import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  CircleUserRound,
  Cloud,
  Folder,
  FolderGit2,
  GitBranch,
  GitFork,
  Github,
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
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
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
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ServerPickerPopover } from "@/components/preferences/ServerPickerPopover";
import { CodespaceSetupWizard } from "@/components/preferences/CodespaceSetupWizard";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useCloudExecutionDevice } from "@/hooks/useCloudExecutionDevice";
import { useGithubCodespaces } from "@/hooks/useGithubCodespaces";
import {
  CODESPACE_DEVICE_LABEL,
  codespaceRepoWorkspaceName,
  codespaceRepoWorkspaceRoot,
  type CodespaceDevice,
} from "@/lib/github-codespaces";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { useAgentShellState } from "./AgentShellStateContext";
import {
  CHAT_UI_SHORTCUT_EVENT,
  isChatUiShortcutEvent,
} from "@/lib/chat-ui-shortcut-events";
import { resolveGroupWorkspaceAppearanceKey, WorkspaceFolderIcon } from "@/lib/workspace-rail-appearance";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
} from "@/lib/server-rail-appearance";
import {
  getLastWorkspaceForServer,
  rememberLastWorkspaceForServer,
} from "@/lib/per-server-workspace-memory";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import {
  NO_WORKSPACE_PICKER_LABEL,
  sortDirectoryWorkspaces,
} from "@/lib/multi-server-workspaces";
import { useLandingPickerCondenseTier } from "./landing-picker-overflow";

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

/**
 * Width stand-in for one picker pill inside the hidden measurement probes:
 * 13px icon square, optional (max-width-capped) label, optional 13px chevron
 * square, mirroring the live pills' gaps/padding. Omitting `label` measures
 * the icon-only condensed form.
 */
function LandingPickerProbePill({
  label,
  trailingChevron = true,
}: {
  label?: string;
  trailingChevron?: boolean;
}) {
  return (
    <span className="inline-flex max-w-[220px] shrink-0 items-center gap-[5px] px-[6px]">
      <span className="block size-[13px] shrink-0" />
      {label !== undefined ? (
        <span className="min-w-0 max-w-[260px] truncate">{label}</span>
      ) : null}
      {trailingChevron ? <span className="block size-[13px] shrink-0" /> : null}
    </span>
  );
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
    openWorkspaceById,
    openFolder,
    gitStatus,
    refreshGitStatus,
    initializeGitRepo,
    switchBranch,
    createWorktree,
    homeWorkspaceId,
    activeWorkspaceId,
  } = useWorkspace();
  const dialogs = useWorkbenchDialogs();
  const {
    activeWorkspaceGroup,
    expandedComposerDraftId,
    groups,
    refreshConversationGroups,
    setStandaloneDraftActive,
    railFilters,
    setRailFilters,
  } = useAgentShellState();
  const { settings, updateSettings } = useGlobalSettings();
  const { activeServer, servers, serverStatusById, setActiveServer } = useServerConnections();
  const { workspaces: directoryWorkspaces, byServerId: directoryByServerId } =
    useWorkspaceDirectory();

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
    activeCloudDevice,
    composer,
  } = useAgentDraftComposer({ onInstantSubmit });
  const { cloudDevices, setActiveCloudDeviceId } = useCloudExecutionDevice(backends);
  const codespaces = useGithubCodespaces();
  const { pushNotification } = useWorkbenchNotifications();

  const isHomeWorkspace = Boolean(
    homeWorkspaceId && activeWorkspaceGroup?.workspace.id === homeWorkspaceId
  );
  const workspaceRailAppearances = settings.general.workspaceRailAppearances;
  const serverRailAppearances = settings.general.serverRailAppearances;
  const activeServerAppearance = useMemo(
    () =>
      getServerRailAppearance(
        serverRailAppearances,
        activeServer.id,
        servers.findIndex((server) => server.id === activeServer.id)
      ),
    [activeServer.id, serverRailAppearances, servers]
  );
  // The active server is a paired GitHub Codespace when a codespace device
  // resolves to it. Its stored label is the repo (owner/name); the pill
  // should say what kind of machine it is and let the workspace pill carry
  // the repository name.
  const activeCodespaceDevice = useMemo(
    () =>
      codespaces.devices.find((device) => device.localServerId === activeServer.id) ??
      null,
    [activeServer.id, codespaces.devices]
  );
  const activeDeviceLabel =
    activeCloudDevice?.label ??
    (activeCodespaceDevice
      ? CODESPACE_DEVICE_LABEL
      : getServerDisplayLabel(activeServer, activeServerAppearance));
  const activeDeviceTitle = activeCodespaceDevice
    ? `${CODESPACE_DEVICE_LABEL} · ${activeCodespaceDevice.repoFullName}`
    : activeDeviceLabel;

  /**
   * Switch servers, then land in a workspace. Without a hint this restores
   * the last workspace used on that server (or its first one). Codespace
   * devices pass `workspace` so the repository checkout at
   * `/workspaces/<repo>` is registered on that engine (idempotent - reuses
   * an existing registration) and opened, instead of dropping the user into
   * "No workspace".
   */
  const handleActiveServerChange = useCallback(
    (
      serverId: string,
      options?: { workspace?: { root: string; name: string } }
    ) => {
      if (activeCloudDevice) {
        // Leaving the cloud device view: stop hiding local conversations.
        setRailFilters({
          ...railFilters,
          hiddenEnvironments: railFilters.hiddenEnvironments.filter(
            (key) => key !== "local"
          ),
        });
      }
      setActiveCloudDeviceId(null);
      setDevicePickerOpen(false);
      const workspaceHint = options?.workspace;
      const openHintedWorkspace = async () => {
        if (!workspaceHint) return;
        // Let React commit the server switch so the request targets the
        // newly active engine.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await openFolder(workspaceHint.root, workspaceHint.name);
        // A "No workspace" draft would otherwise keep masking the workspace
        // we just opened.
        setStandaloneDraftActive(false);
      };
      if (serverId === activeServer.id) {
        if (workspaceHint && !activeWorkspaceId) {
          void openHintedWorkspace().catch(() => undefined);
        }
        return;
      }
      if (activeWorkspaceId) {
        rememberLastWorkspaceForServer(activeServer.id, activeWorkspaceId);
      }
      setActiveServer(serverId);
      if (workspaceHint) {
        void openHintedWorkspace().catch(() => {
          // Folder missing or engine refused: fall back to whatever the
          // engine already has registered.
          const first = (directoryByServerId.get(serverId) ?? [])[0]?.id;
          if (first) void openWorkspaceById(first).catch(() => undefined);
        });
        return;
      }
      const restoredWorkspaceId = getLastWorkspaceForServer(serverId);
      const serverWorkspaces = directoryByServerId.get(serverId) ?? [];
      const targetWorkspaceId =
        restoredWorkspaceId &&
        serverWorkspaces.some((workspace) => workspace.id === restoredWorkspaceId)
          ? restoredWorkspaceId
          : serverWorkspaces[0]?.id;
      if (targetWorkspaceId) {
        void openWorkspaceById(targetWorkspaceId).catch(() => undefined);
      }
    },
    [
      activeCloudDevice,
      activeServer.id,
      activeWorkspaceId,
      directoryByServerId,
      openFolder,
      openWorkspaceById,
      railFilters,
      setActiveCloudDeviceId,
      setActiveServer,
      setRailFilters,
      setStandaloneDraftActive,
    ]
  );

  const codespaceWorkspaceHint = useCallback(
    (repoFullName: string) => ({
      workspace: {
        root: codespaceRepoWorkspaceRoot(repoFullName),
        name: codespaceRepoWorkspaceName(repoFullName),
      },
    }),
    []
  );

  useRegisterDesignCaptureComposer(composerDraftId, 9);
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const branchPickerRef = useRef<HTMLButtonElement>(null);
  const workspacePickerRef = useRef<HTMLButtonElement>(null);
  const devicePickerRef = useRef<HTMLButtonElement>(null);
  const branchPopoverRef = useRef<HTMLDivElement>(null);
  const pickerRowContainerRef = useRef<HTMLDivElement>(null);
  const pickerProbeFullRef = useRef<HTMLDivElement>(null);
  const pickerProbeNoImportRef = useRef<HTMLDivElement>(null);
  const pickerProbeCondensedDeviceRef = useRef<HTMLDivElement>(null);
  const pickerCondenseTier = useLandingPickerCondenseTier(
    pickerRowContainerRef,
    pickerProbeFullRef,
    pickerProbeNoImportRef,
    pickerProbeCondensedDeviceRef
  );
  const importPillHidden = pickerCondenseTier >= 1;
  const devicePillCondensed = pickerCondenseTier >= 2;
  const branchPillCondensed = pickerCondenseTier >= 3;
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [codespaceWizardOpen, setCodespaceWizardOpen] = useState(false);
  const [codespaceRecreateDevice, setCodespaceRecreateDevice] =
    useState<CodespaceDevice | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // The picker shows each codespace's cached GitHub state; re-read it lazily
  // (throttled inside the provider) whenever the picker opens so "Asleep" vs
  // "Stopped" vs "Deleted" reflects reality instead of the last connect.
  const refreshCodespaceStates = codespaces.refreshDeviceStates;
  const codespaceCount = codespaces.devices.length;
  useEffect(() => {
    if (!devicePickerOpen || codespaceCount === 0) {
      return;
    }
    void refreshCodespaceStates();
  }, [codespaceCount, devicePickerOpen, refreshCodespaceStates]);

  // Selecting a codespace device wakes it first (start + engine health +
  // session), with progress rendered inline in the picker; only a successful
  // wake runs the normal server switch.
  const handleSelectCodespaceDevice = useCallback(
    (device: CodespaceDevice) => {
      void codespaces.connectDevice(device).then((localServerId) => {
        if (localServerId) {
          const warning = codespaces.getLastWakeWarning();
          if (warning) {
            pushNotification({
              kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
              severity: "warning",
              title: "Codespace Keep-Alive Warning",
              message: warning,
              autoDismissMs: 15_000,
              compact: true,
            });
          }
          handleActiveServerChange(
            localServerId,
            codespaceWorkspaceHint(device.repoFullName)
          );
        }
      });
    },
    [codespaceWorkspaceHint, codespaces, handleActiveServerChange, pushNotification]
  );

  const handleRecreateCodespaceDevice = useCallback(
    (device: CodespaceDevice) => {
      codespaces.dismissFailure();
      setCodespaceRecreateDevice(device);
      setCodespaceWizardOpen(true);
      setDevicePickerOpen(false);
    },
    [codespaces]
  );
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
      backendId: draftBackend?.id ?? composer.backendId,
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
    composer.backendId,
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

  const workspacePickerLabel = noWorkspaceDraft
    ? NO_WORKSPACE_PICKER_LABEL
    : // The rail-derived group can lag behind a freshly created / opened
      // workspace (cached rail payload); the active workspace's own name is
      // always current.
      (activeWorkspaceGroup?.workspace.name ??
        workspaceInfo?.name ??
        "Select workspace");
  const showBranchPill = !noWorkspaceDraft && !isHomeWorkspace;
  const showImportPill = !noWorkspaceDraft;

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
    const name = await dialogs.prompt({
      title: "New branch worktree",
      message: gitStatus?.currentBranch
        ? `A new worktree is created for the branch, based on ${gitStatus.currentBranch}.`
        : "A new worktree is created for the branch.",
      placeholder: "feature/my-change",
      inputLabel: "Branch name",
      monospace: true,
      confirmLabel: "Create",
    });
    if (!name) {
      return;
    }
    await runGitAction(`new:${name}`, async () => {
      await createWorktree({
        branch: name,
        baseBranch: gitStatus?.currentBranch ?? undefined,
        newBranch: true,
      });
      setBranchPickerOpen(false);
    });
  }, [createWorktree, dialogs, gitStatus?.currentBranch, runGitAction]);

  useEffect(() => {
    const onShortcut = (e: Event) => {
      if (!isChatUiShortcutEvent(e)) return;
      if (e.detail.target !== "workspacePicker") return;
      if (!workspacePickerRef.current) return;
      setBranchPickerOpen(false);
      setDevicePickerOpen(false);
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
        <div
          ref={pickerRowContainerRef}
          className="relative mx-0 flex min-w-0 flex-col gap-[2px] @min-[481px]:mx-[10px]"
        >
          {/*
            Invisible measurement rows mirroring the picker pills at full size
            for each condensation step (full row, Import hidden, Import hidden
            + icon-only device). The live row condenses off these probes - not
            its own width - so condensing can never feed back into the
            measurement and oscillate.
          */}
          <div
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden font-sans text-[13px]"
          >
            <div
              ref={pickerProbeFullRef}
              className="flex w-max items-center gap-[6px] whitespace-nowrap"
            >
              <LandingPickerProbePill label={workspacePickerLabel} />
              {showBranchPill ? <LandingPickerProbePill label={activeBranchLabel} /> : null}
              <LandingPickerProbePill label={activeDeviceLabel} />
              {showImportPill ? (
                <LandingPickerProbePill label="Import" trailingChevron={false} />
              ) : null}
            </div>
            <div
              ref={pickerProbeNoImportRef}
              className="flex w-max items-center gap-[6px] whitespace-nowrap"
            >
              <LandingPickerProbePill label={workspacePickerLabel} />
              {showBranchPill ? <LandingPickerProbePill label={activeBranchLabel} /> : null}
              <LandingPickerProbePill label={activeDeviceLabel} />
            </div>
            <div
              ref={pickerProbeCondensedDeviceRef}
              className="flex w-max items-center gap-[6px] whitespace-nowrap"
            >
              <LandingPickerProbePill label={workspacePickerLabel} />
              {showBranchPill ? <LandingPickerProbePill label={activeBranchLabel} /> : null}
              <LandingPickerProbePill />
            </div>
          </div>
          <div className="w-fit max-w-full self-start">
            <div className="flex max-w-full items-center gap-[6px]">
              <button
                ref={workspacePickerRef}
                type="button"
                aria-label="Open workspace picker"
                data-perf="agent-codebase-picker-button"
                onClick={() => {
                  setBranchPickerOpen(false);
                  setDevicePickerOpen(false);
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
                  {workspacePickerLabel}
                </span>
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              {showBranchPill ? (
              <button
                ref={branchPickerRef}
                type="button"
                aria-label="Open branch picker"
                title={branchPillCondensed ? activeBranchLabel : undefined}
                data-perf="agent-branch-picker-button"
                onClick={() => {
                  setWorkspacePickerOpen(false);
                  setDevicePickerOpen(false);
                  setBranchPickerOpen((open) => !open);
                  void refreshGitStatus().catch(() => undefined);
                }}
                className="inline-flex min-w-0 max-w-[220px] shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                <GitBranch className="size-[13px] shrink-0" strokeWidth={1.5} />
                {!branchPillCondensed ? (
                  <span className="truncate">{activeBranchLabel}</span>
                ) : null}
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              ) : null}
              <button
                ref={devicePickerRef}
                type="button"
                aria-label={`Switch device (${activeDeviceTitle})`}
                title={devicePillCondensed || activeCodespaceDevice ? activeDeviceTitle : undefined}
                aria-expanded={devicePickerOpen}
                aria-haspopup="menu"
                data-perf="agent-device-picker-button"
                onClick={() => {
                  setWorkspacePickerOpen(false);
                  setBranchPickerOpen(false);
                  setDevicePickerOpen((open) => !open);
                }}
                className="inline-flex min-w-0 max-w-[220px] shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                {activeCloudDevice ? (
                  <Cloud className="size-[13px] shrink-0" strokeWidth={1.5} aria-hidden />
                ) : activeCodespaceDevice ? (
                  <Github className="size-[13px] shrink-0" strokeWidth={1.5} aria-hidden />
                ) : isLocalDeviceServer(activeServer) ? (
                  <CircleUserRound className="size-[13px] shrink-0" strokeWidth={1.5} aria-hidden />
                ) : (
                  <WorkspaceFolderIcon
                    iconName={activeServerAppearance.icon}
                    color={activeServerAppearance.color}
                    className="size-[13px] shrink-0"
                    strokeWidth={1.5}
                  />
                )}
                {!devicePillCondensed ? (
                  <span className="max-w-[260px] min-w-0 shrink truncate">{activeDeviceLabel}</span>
                ) : null}
                <ChevronDown className="size-[13px] shrink-0" strokeWidth={1.5} />
              </button>
              {showImportPill && !importPillHidden ? (
                <button
                  type="button"
                  aria-label="Import conversation from another harness"
                  title="Import a conversation from Claude Code, Codex, OpenCode, Gemini CLI, or Pi"
                  data-perf="agent-import-conversation-button"
                  onClick={() => {
                    setWorkspacePickerOpen(false);
                    setBranchPickerOpen(false);
                    setDevicePickerOpen(false);
                    setImportDialogOpen(true);
                  }}
                  className="inline-flex shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] px-[6px] py-[4px] font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
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
              {activeCloudDevice ? (
                <div className="mb-[6px] inline-flex items-center gap-[6px] self-start rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
                  <Cloud className="size-[12px] shrink-0" strokeWidth={1.5} aria-hidden />
                  <span>
                    New chats run on <span className="text-[var(--text-primary)]">{activeCloudDevice.label}</span>
                  </span>
                </div>
              ) : null}
              <ChatComposer
                key={composerDraftId}
                mode={draftMode}
                onModeChange={setDraftMode}
                model={draftModel}
                onModelChange={(next) => {
                  setDraftModel(next);
                }}
                backendId={draftBackend?.id ?? composer.backendId}
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
                  // Do not pass `content` here - submit clears text then
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
      <ServerPickerPopover
        open={devicePickerOpen}
        onClose={() => setDevicePickerOpen(false)}
        anchorRef={devicePickerRef}
        label="Switch device"
        selectedServerId={activeServer.id}
        servers={servers}
        serverStatusById={serverStatusById}
        serverRailAppearances={serverRailAppearances}
        onSelect={handleActiveServerChange}
        placement="below"
        variant="device"
        cloudDevices={cloudDevices}
        selectedCloudDeviceId={activeCloudDevice?.id ?? null}
        onSelectCloudDevice={(cloudDeviceId) => {
          setActiveCloudDeviceId(cloudDeviceId);
          // Cloud device view narrows the rail to cloud executions.
          setRailFilters({
            ...railFilters,
            hiddenEnvironments: railFilters.hiddenEnvironments.includes("local")
              ? railFilters.hiddenEnvironments
              : [...railFilters.hiddenEnvironments, "local"],
          });
          setDevicePickerOpen(false);
        }}
        codespaceDevices={codespaces.available ? codespaces.devices : []}
        codespaceWakeStatus={codespaces.wakeStatus}
        codespaceWakeFailure={codespaces.wakeFailure}
        onSelectCodespaceDevice={
          codespaces.available ? handleSelectCodespaceDevice : undefined
        }
        onRecreateCodespaceDevice={handleRecreateCodespaceDevice}
        onSetupCodespace={
          codespaces.available
            ? () => {
                setCodespaceRecreateDevice(null);
                setCodespaceWizardOpen(true);
                setDevicePickerOpen(false);
              }
            : undefined
        }
      />
      <CodespaceSetupWizard
        open={codespaceWizardOpen}
        onClose={() => {
          setCodespaceWizardOpen(false);
          setCodespaceRecreateDevice(null);
        }}
        onConnected={(localServerId, connected) =>
          handleActiveServerChange(
            localServerId,
            codespaceWorkspaceHint(connected.repoFullName)
          )
        }
        devices={codespaces.devices}
        recreateDevice={codespaceRecreateDevice}
      />
      <WorkspacePickerMenu
        open={workspacePickerOpen}
        onClose={() => setWorkspacePickerOpen(false)}
        anchorRef={workspacePickerRef}
        workspaces={workspacePickerOptions}
        appearances={workspaceRailAppearances}
        homeWorkspaceId={homeWorkspaceId}
        activeServerId={activeServer.id}
        selectedWorkspaceKey={noWorkspaceDraft ? null : activeWorkspaceAppearanceKey}
        noWorkspaceSelected={noWorkspaceDraft}
        onSelectNoWorkspace={() => setStandaloneDraftActive(true)}
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
