"use client";

import { ArrowLeft, Folder, FolderGit2, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  browseSshWorkspaceDirectories,
  browseWorkspaceHostDirectories,
  cloneGitRepositoryOnRemoteSsh,
  createSshWorkspaceDirectory,
  fetchSshWorkspaceMetadata,
  probeSshWorkspaceConnection,
  pullSshWorkspaceSelection,
  pushSshWorkspaceSelection,
  type SshWorkspaceMetadata,
} from "@/lib/server-api";
import type { WorkspaceRecord } from "@/lib/types";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";

const shell =
  "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--palette-border)] bg-[var(--palette-surface)] shadow-[var(--palette-shadow)] max-h-[min(72vh,720px)]";

type Mode = "clone" | "browse" | "newfolder" | "ssh" | "worktrees" | "remove";
type SshWizardStep = "connect" | "remote";
type SshRemoteSetupTab = "browse" | "clone" | "newfolder";

export function WorkspaceStudioModal({
  open,
  onClose,
  initialMode = "clone",
}: {
  open: boolean;
  onClose: () => void;
  initialMode?: Mode;
}) {
  const {
    activeWorkspaceId,
    cloneWorkspaceFromGit,
    createSshWorkspace,
    createWorkspace,
    deleteWorktree,
    gitStatus,
    refreshGitStatus,
    deleteWorkspace,
    homeWorkspaceId,
    openFolder,
    refreshTree,
    workspaces,
  } = useWorkspace();

  const titleId = useId();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [toast, setToast] = useState<string | null>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [cloneFolderName, setCloneFolderName] = useState("");
  const [cloneParent, setCloneParent] = useState("");
  const [cloneBusy, setCloneBusy] = useState(false);

  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseRoots, setBrowseRoots] = useState<{ path: string; label: string }[]>([]);
  const [browseEntries, setBrowseEntries] = useState<{ name: string; path: string }[]>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseCurrent, setBrowseCurrent] = useState<string | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseOpenBusy, setBrowseOpenBusy] = useState(false);

  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [sshTarget, setSshTarget] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");
  const [sshMirrorName, setSshMirrorName] = useState("");
  const [sshWorkspaceName, setSshWorkspaceName] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [sshBusy, setSshBusy] = useState(false);
  const [sshBrowseBusy, setSshBrowseBusy] = useState(false);
  const [sshNewDirectoryName, setSshNewDirectoryName] = useState("");
  const [sshRemoteParent, setSshRemoteParent] = useState<string | null>(null);
  const [sshRemoteEntries, setSshRemoteEntries] = useState<
    Array<{ name: string; path: string }>
  >([]);
  const [sshSyncBusy, setSshSyncBusy] = useState<"pull" | "push" | null>(null);
  const [sshWizardStep, setSshWizardStep] = useState<SshWizardStep>("connect");
  const [sshRemoteSetupTab, setSshRemoteSetupTab] = useState<SshRemoteSetupTab>("browse");
  const [sshProbeBusy, setSshProbeBusy] = useState(false);
  const [sshRemoteCloneBusy, setSshRemoteCloneBusy] = useState(false);
  const [sshRemoteRepoUrl, setSshRemoteRepoUrl] = useState("");
  const [sshRemoteCloneFolderName, setSshRemoteCloneFolderName] = useState("");
  const [sshConnectedLabel, setSshConnectedLabel] = useState<string | null>(null);
  const [activeSshMetadata, setActiveSshMetadata] =
    useState<SshWorkspaceMetadata | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);

  const [removeBusy, setRemoveBusy] = useState<string | null>(null);

  const preferredRoot = useCallback(
    (roots: { path: string; label: string }[]) =>
      roots.find((r) => /onedrive.*projects/i.test(r.label)) ??
      roots.find((r) => /projects/i.test(r.label)) ??
      roots.find((r) => /onedrive/i.test(r.label)) ??
      roots[0],
    []
  );

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setToast(null);
  }, [open, initialMode]);

  useEffect(() => {
    if (!open || mode !== "ssh") {
      return;
    }
    setSshWizardStep("connect");
    setSshRemoteSetupTab("browse");
    setSshConnectedLabel(null);
    setSshRemotePath("");
    setSshRemoteParent(null);
    setSshRemoteEntries([]);
    setSshNewDirectoryName("");
    setSshRemoteRepoUrl("");
    setSshRemoteCloneFolderName("");
  }, [open, mode]);

  useEffect(() => {
    if (!open || mode !== "browse") {
      return;
    }
    setBrowsePath(null);
  }, [open, mode]);

  const loadBrowse = useCallback(async (path: string | null) => {
    setBrowseBusy(true);
    try {
      if (!path) {
        const data = await browseWorkspaceHostDirectories();
        if (!("roots" in data)) {
          throw new Error("Invalid browse response.");
        }
        setBrowseRoots(data.roots);
        setBrowseEntries([]);
        setBrowseParent(null);
        setBrowseCurrent(null);
        setBrowsePath(null);
      } else {
        const data = await browseWorkspaceHostDirectories(path);
        if (!("entries" in data)) {
          throw new Error("Invalid browse response.");
        }
        setBrowseEntries(data.entries);
        setBrowseParent(data.parentPath);
        setBrowseCurrent(data.currentPath);
        setBrowsePath(path);
        setBrowseRoots([]);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Browse failed.");
    } finally {
      setBrowseBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open || mode !== "browse") {
      return;
    }
    void loadBrowse(browsePath);
  }, [open, mode, browsePath, loadBrowse]);

  useEffect(() => {
    if (!open || mode !== "clone") return;
    void (async () => {
      try {
        const data = await browseWorkspaceHostDirectories();
        if ("roots" in data && data.roots[0]) {
          setCloneParent(preferredRoot(data.roots)?.path ?? data.roots[0]!.path);
        }
      } catch {
        setCloneParent("");
      }
    })();
  }, [open, mode, preferredRoot]);

  useEffect(() => {
    if (!open || mode !== "newfolder") return;
    void (async () => {
      try {
        const data = await browseWorkspaceHostDirectories();
        if ("roots" in data && data.roots[0]) {
          setNewFolderParent(preferredRoot(data.roots)?.path ?? data.roots[0]!.path);
        }
      } catch {
        setNewFolderParent("");
      }
    })();
  }, [open, mode, preferredRoot]);

  useEffect(() => {
    if (!open || mode !== "worktrees") return;
    void refreshGitStatus().catch(() => undefined);
  }, [open, mode, refreshGitStatus]);

  useEffect(() => {
    if (!open || mode !== "ssh" || !activeWorkspaceId) {
      setActiveSshMetadata(null);
      return;
    }
    let cancelled = false;
    void fetchSshWorkspaceMetadata(activeWorkspaceId)
      .then((result) => {
        if (!cancelled) {
          setActiveSshMetadata(result.metadata);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveSshMetadata(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, mode, open]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const handleClone = async () => {
    if (cloneBusy) {
      return;
    }
    const url = repoUrl.trim();
    const parent = cloneParent.trim();
    if (!url || !parent) {
      flash("Repository URL and parent folder are required.");
      return;
    }
    setCloneBusy(true);
    try {
      await cloneWorkspaceFromGit({
        repoUrl: url,
        parentPath: parent,
        directoryName: cloneFolderName.trim() || undefined,
      });
      flash("Repository cloned and opened.");
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloneBusy(false);
    }
  };

  const handleOpenBrowseFolder = async () => {
    if (!browseCurrent || browseOpenBusy) return;
    setBrowseOpenBusy(true);
    try {
      await openFolder(browseCurrent);
      flash("Workspace opened.");
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to open folder.");
    } finally {
      setBrowseOpenBusy(false);
    }
  };

  const handleNewFolder = async () => {
    if (newFolderBusy) {
      return;
    }
    const parent = newFolderParent.trim();
    const name = newFolderName.trim();
    if (!parent || !name) {
      flash("Parent path and folder name are required.");
      return;
    }
    setNewFolderBusy(true);
    try {
      await createWorkspace({ parentPath: parent, directoryName: name, name });
      flash(`Created ${name}`);
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to create folder.");
    } finally {
      setNewFolderBusy(false);
    }
  };

  const handleSshWorkspace = async () => {
    if (sshBusy) {
      return;
    }
    if (sshWizardStep !== "remote") {
      flash("Connect to the host first.");
      return;
    }
    const target = sshTarget.trim();
    const remotePath = sshRemotePath.trim();
    if (!target || !remotePath) {
      flash("SSH target and remote folder are required.");
      return;
    }
    const parsedPort = sshPort.trim() ? Number.parseInt(sshPort.trim(), 10) : undefined;
    if (parsedPort != null && (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535)) {
      flash("SSH port must be between 1 and 65535.");
      return;
    }
    setSshBusy(true);
    try {
      await createSshWorkspace({
        target,
        ...(parsedPort ? { port: parsedPort } : {}),
        remotePath,
        mirrorName: sshMirrorName.trim() || undefined,
        name: sshWorkspaceName.trim() || undefined,
        keyPath: sshKeyPath.trim() || undefined,
        password: sshPassword.trim() || undefined,
      });
      flash("SSH workspace synced and opened.");
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "SSH workspace failed.");
    } finally {
      setSshBusy(false);
    }
  };

  const sshConnectionInput = () => {
    const parsedPort = sshPort.trim() ? Number.parseInt(sshPort.trim(), 10) : undefined;
    return {
      target: sshTarget.trim(),
      ...(parsedPort != null ? { port: parsedPort } : {}),
      keyPath: sshKeyPath.trim() || undefined,
      password: sshPassword.trim() || undefined,
    };
  };

  const handleSshProbeConnect = async () => {
    const target = sshTarget.trim();
    if (!target) {
      flash("SSH target is required.");
      return;
    }
    const parsedPort = sshPort.trim() ? Number.parseInt(sshPort.trim(), 10) : undefined;
    if (parsedPort != null && (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535)) {
      flash("SSH port must be between 1 and 65535.");
      return;
    }
    const connection = sshConnectionInput();
    if (!connection.target) {
      flash("SSH target is required.");
      return;
    }
    setSshProbeBusy(true);
    try {
      const result = await probeSshWorkspaceConnection(connection);
      setSshConnectedLabel(`${result.username} @ ${result.host}`);
      setSshWizardStep("remote");
      setSshRemoteSetupTab("browse");
      const listing = await browseSshWorkspaceDirectories({
        ...connection,
        remotePath: ".",
      });
      setSshRemotePath(listing.currentPath);
      setSshRemoteParent(listing.parentPath);
      setSshRemoteEntries(listing.entries);
      flash("Authenticated. Pick or prepare a folder on the host.");
    } catch (e) {
      flash(
        e instanceof Error
          ? e.message
          : "SSH connection failed. Add a password, key path, or use an agent."
      );
    } finally {
      setSshProbeBusy(false);
    }
  };

  const handleSshWizardBack = () => {
    setSshWizardStep("connect");
    setSshConnectedLabel(null);
  };

  const handleSshRemoteClone = async () => {
    const url = sshRemoteRepoUrl.trim();
    if (!url) {
      flash("Repository URL is required.");
      return;
    }
    const connection = sshConnectionInput();
    if (!connection.target) {
      flash("SSH target is required.");
      return;
    }
    setSshRemoteCloneBusy(true);
    try {
      const result = await cloneGitRepositoryOnRemoteSsh({
        ...connection,
        repoUrl: url,
        parentRemotePath: sshRemotePath.trim() || ".",
        directoryName: sshRemoteCloneFolderName.trim() || undefined,
      });
      setSshRemotePath(result.currentPath);
      setSshRemoteParent(result.parentPath);
      setSshRemoteEntries(result.entries);
      setSshRemoteRepoUrl("");
      setSshRemoteCloneFolderName("");
      flash("Cloned repository on remote host.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Remote clone failed.");
    } finally {
      setSshRemoteCloneBusy(false);
    }
  };

  const handleSshBrowse = async (pathOverride?: string) => {
    const connection = sshConnectionInput();
    if (!connection.target) {
      flash("SSH target is required.");
      return;
    }
    setSshBrowseBusy(true);
    try {
      const result = await browseSshWorkspaceDirectories({
        ...connection,
        remotePath: (pathOverride ?? sshRemotePath.trim()) || ".",
      });
      setSshRemotePath(result.currentPath);
      setSshRemoteParent(result.parentPath);
      setSshRemoteEntries(result.entries);
    } catch (e) {
      flash(e instanceof Error ? e.message : "SSH browse failed.");
    } finally {
      setSshBrowseBusy(false);
    }
  };

  const handleSshCreateDirectory = async () => {
    const directoryName = sshNewDirectoryName.trim();
    if (!directoryName) {
      flash("Remote folder name is required.");
      return;
    }
    const connection = sshConnectionInput();
    if (!connection.target) {
      flash("SSH target is required.");
      return;
    }
    setSshBrowseBusy(true);
    try {
      const result = await createSshWorkspaceDirectory({
        ...connection,
        remotePath: sshRemotePath.trim() || ".",
        directoryName,
      });
      setSshNewDirectoryName("");
      setSshRemotePath(result.currentPath);
      setSshRemoteParent(result.parentPath);
      setSshRemoteEntries(result.entries);
      flash(`Created ${directoryName}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Remote folder creation failed.");
    } finally {
      setSshBrowseBusy(false);
    }
  };

  const handleSshPull = async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setSshSyncBusy("pull");
    try {
      const result = await pullSshWorkspaceSelection(activeWorkspaceId);
      setActiveSshMetadata(result.metadata);
      await refreshTree();
      flash("Pulled remote changes into the local mirror.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "SSH pull failed.");
    } finally {
      setSshSyncBusy(null);
    }
  };

  const handleSshPush = async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setSshSyncBusy("push");
    try {
      const result = await pushSshWorkspaceSelection(activeWorkspaceId);
      setActiveSshMetadata(result.metadata);
      flash("Pushed local mirror changes to the remote host.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "SSH push failed.");
    } finally {
      setSshSyncBusy(null);
    }
  };

  const handleDelete = async (workspaceId: string) => {
    if (workspaceId === homeWorkspaceId) {
      flash("The Home workspace cannot be removed.");
      return;
    }
    const label =
      workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Remove workspace “${label}” from Cesium? This does not delete files on disk.`)
    ) {
      return;
    }
    setRemoveBusy(workspaceId);
    try {
      await deleteWorkspace(workspaceId);
      flash(`Removed ${label}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Remove failed.");
    } finally {
      setRemoveBusy(null);
    }
  };

  const handleOpenWorktree = async (root: string) => {
    if (worktreeBusy) {
      return;
    }
    setWorktreeBusy(root);
    try {
      await openFolder(root);
      flash("Worktree opened.");
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to open worktree.");
    } finally {
      setWorktreeBusy(null);
    }
  };

  const handleDeleteWorktree = async (root: string, force = false) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Remove git worktree at ${root}?`)
    ) {
      return;
    }
    setWorktreeBusy(root);
    try {
      await deleteWorktree({ path: root, force });
      flash("Worktree removed.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to remove worktree.");
    } finally {
      setWorktreeBusy(null);
    }
  };

  const tabClass = (m: Mode) =>
    `rounded-[var(--radius-tab)] px-3 py-1.5 text-[12px] font-medium transition-colors ${
      mode === m
        ? "bg-[var(--bg-card)] text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)]/60 hover:text-[var(--text-primary)]"
    }`;

  const removable = useMemo(
    () => workspaces.filter((w) => w.id !== homeWorkspaceId),
    [workspaces, homeWorkspaceId]
  );

  const workspaceOpenBusy =
    cloneBusy ||
    browseOpenBusy ||
    newFolderBusy ||
    sshBusy ||
    worktreeBusy !== null;

  const sshSubTabClass = (t: SshRemoteSetupTab) =>
    `rounded-[var(--radius-tab)] px-2 py-1 text-[11px] font-medium transition-colors ${
      sshRemoteSetupTab === t
        ? "bg-[var(--bg-card)] text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--bg-card)]/60"
    }`;

  if (!open) return null;

  return (
    <div
      data-ide-palette
      className="fixed inset-0 z-[10050] flex items-start justify-center px-4 pt-[10vh]"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-[var(--palette-backdrop)]"
        aria-hidden
        onPointerDown={(e) => {
          e.preventDefault();
          if (!workspaceOpenBusy) {
            onClose();
          }
        }}
      />
      <div className={`relative ${shell}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex flex-col gap-1 border-b border-[var(--palette-divider)] px-[10px] py-[8px]">
          <h2 id={titleId} className="font-sans text-[13px] font-semibold text-[var(--palette-input-text)]">
            Workspaces
          </h2>
          <p className="font-sans text-[11px] text-[var(--text-secondary)]">
            Clone a Git repo into an allowed folder, browse the host to open a folder, create a new empty project folder, or remove saved workspaces.
          </p>
          <div className="flex flex-wrap gap-1 pt-1">
            <button type="button" className={tabClass("clone")} onClick={() => setMode("clone")}>
              <span className="inline-flex items-center gap-1">
                <FolderGit2 className="size-[14px]" strokeWidth={1.5} />
                Clone Git URL
              </span>
            </button>
            <button type="button" className={tabClass("browse")} onClick={() => setMode("browse")}>
              <span className="inline-flex items-center gap-1">
                <Folder className="size-[14px]" strokeWidth={1.5} />
                Browse folders
              </span>
            </button>
            <button type="button" className={tabClass("newfolder")} onClick={() => setMode("newfolder")}>
              New empty folder
            </button>
            <button type="button" className={tabClass("ssh")} onClick={() => setMode("ssh")}>
              <span className="inline-flex items-center gap-1">
                <Server className="size-[14px]" strokeWidth={1.5} />
                SSH
              </span>
            </button>
            <button type="button" className={tabClass("worktrees")} onClick={() => setMode("worktrees")}>
              <span className="inline-flex items-center gap-1">
                <FolderGit2 className="size-[14px]" strokeWidth={1.5} />
                Worktrees
              </span>
            </button>
            <button type="button" className={tabClass("remove")} onClick={() => setMode("remove")}>
              <span className="inline-flex items-center gap-1">
                <Trash2 className="size-[14px]" strokeWidth={1.5} />
                Remove…
              </span>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[10px] py-[10px] font-sans text-[13px] text-[var(--palette-input-text)]">
          {mode === "clone" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-secondary)]">Git remote (https, http, or git@…)</span>
                <HardwareAwareTextInput
                  placeholder="https://github.com/org/repo.git"
                  value={repoUrl}
                  onChange={setRepoUrl}
                  onNativeKeyDown={() => {}}
                  surfaceKind="palette"
                  className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                  ariaLabel="Git remote URL"
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-secondary)]">Folder name (optional, inferred from URL if empty)</span>
                <HardwareAwareTextInput
                  placeholder="my-fork"
                  value={cloneFolderName}
                  onChange={setCloneFolderName}
                  onNativeKeyDown={() => {}}
                  surfaceKind="palette"
                  className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                  ariaLabel="Clone folder name"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-secondary)]">Parent directory (clone creates a subfolder here)</span>
                <HardwareAwareTextInput
                  placeholder="/home/you/projects"
                  value={cloneParent}
                  onChange={setCloneParent}
                  onNativeKeyDown={() => {}}
                  surfaceKind="palette"
                  className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                  ariaLabel="Parent directory for clone"
                />
              </label>
              <button
                type="button"
                disabled={cloneBusy}
                onClick={() => void handleClone()}
                className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
              >
                {cloneBusy ? "Cloning…" : "Clone and open"}
              </button>
            </div>
          )}

          {mode === "browse" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {browsePath && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-[var(--radius-tab)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"
                    onClick={() => setBrowsePath(null)}
                    disabled={browseBusy}
                  >
                    Roots
                  </button>
                )}
                {browseParent != null && browseParent !== "" && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-[var(--radius-tab)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"
                    onClick={() => setBrowsePath(browseParent)}
                    disabled={browseBusy}
                  >
                    <ArrowLeft className="size-[14px]" />
                    Up
                  </button>
                )}
                {!browsePath && (
                  <span className="text-[11px] text-[var(--text-secondary)]">Pick a root, then open a folder or go deeper.</span>
                )}
              </div>
              {browseCurrent ? (
                <div className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{browseCurrent}</div>
              ) : null}
              <div className="flex flex-col rounded-[var(--radius-tab)] border border-[var(--palette-border)]">
                {browseBusy ? (
                  <div className="px-3 py-4 text-[12px] text-[var(--text-secondary)]">Loading…</div>
                ) : !browsePath ? (
                  browseRoots.map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      className="flex items-center gap-2 border-b border-[var(--palette-border)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--bg-card)]"
                      onClick={() => setBrowsePath(r.path)}
                    >
                      <Folder className="size-[16px] shrink-0 text-[var(--text-secondary)]" />
                      <span>{r.label}</span>
                      <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">{r.path}</span>
                    </button>
                  ))
                ) : browseEntries.length === 0 ? (
                  <div className="px-3 py-4 text-[12px] text-[var(--text-secondary)]">No subfolders here.</div>
                ) : (
                  browseEntries.map((e) => (
                    <button
                      key={e.path}
                      type="button"
                      className="flex items-center gap-2 border-b border-[var(--palette-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--bg-card)]"
                      onClick={() => setBrowsePath(e.path)}
                    >
                      <ChevronRightIcon />
                      <span className="font-medium">{e.name}</span>
                    </button>
                  ))
                )}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled={!browseCurrent || browseBusy || browseOpenBusy}
                  onClick={() => void handleOpenBrowseFolder()}
                  className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-40"
                >
                  {browseOpenBusy ? "Opening…" : "Open this folder"}
                </button>
              </div>
            </div>
          )}

          {mode === "worktrees" && (
            <div className="flex flex-col gap-3">
              {!gitStatus?.isGitRepo ? (
                <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-4 text-[12px] text-[var(--text-secondary)]">
                  The active workspace is not a git repository.
                </div>
              ) : (
                <>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    Current branch:{" "}
                    <span className="font-mono text-[var(--text-primary)]">
                      {gitStatus.currentBranch ?? "detached"}
                    </span>
                    {gitStatus.dirty ? " (dirty)" : ""}
                  </div>
                  <div className="flex flex-col rounded-[var(--radius-tab)] border border-[var(--palette-border)]">
                    {gitStatus.worktrees.map((worktree) => (
                      <div
                        key={worktree.path}
                        className="flex items-center gap-2 border-b border-[var(--palette-border)] px-3 py-2 last:border-b-0"
                      >
                        <FolderGit2 className="size-[15px] shrink-0 text-[var(--text-secondary)]" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-[var(--text-primary)]">
                            {worktree.branch ?? "Detached"}
                            {worktree.current ? " · current" : ""}
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                            {worktree.path}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={worktreeBusy === worktree.path || worktree.current}
                          onClick={() => void handleOpenWorktree(worktree.path)}
                          className="rounded-[var(--radius-tab)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)] disabled:opacity-50"
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          disabled={worktreeBusy === worktree.path || worktree.current}
                          onClick={() => void handleDeleteWorktree(worktree.path)}
                          className="rounded-[var(--radius-tab)] px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {mode === "newfolder" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-secondary)]">Parent directory</span>
                <HardwareAwareTextInput
                  placeholder="/home/you/projects"
                  value={newFolderParent}
                  onChange={setNewFolderParent}
                  onNativeKeyDown={() => {}}
                  surfaceKind="palette"
                  className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                  ariaLabel="Parent directory for new folder"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--text-secondary)]">New folder name</span>
                <HardwareAwareTextInput
                  placeholder="my-app"
                  value={newFolderName}
                  onChange={setNewFolderName}
                  onNativeKeyDown={() => {}}
                  surfaceKind="palette"
                  className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                  ariaLabel="New folder name"
                  autoFocus
                />
              </label>
              <button
                type="button"
                disabled={newFolderBusy}
                onClick={() => void handleNewFolder()}
                className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
              >
                {newFolderBusy ? "Creating…" : "Create and open"}
              </button>
            </div>
          )}

          {mode === "ssh" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <span
                  className={
                    sshWizardStep === "connect"
                      ? "font-semibold text-[var(--text-primary)]"
                      : ""
                  }
                >
                  1 · Connect
                </span>
                <span aria-hidden className="text-[var(--text-secondary)] opacity-70">
                  →
                </span>
                <span
                  className={
                    sshWizardStep === "remote"
                      ? "font-semibold text-[var(--text-primary)]"
                      : ""
                  }
                >
                  2 · Remote folder
                </span>
              </div>

              {sshWizardStep === "connect" ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSshProbeConnect();
                  }}
                >
                  <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)]/60 px-3 py-2 text-[12px] leading-5 text-[var(--text-secondary)]">
                    We open a temporary SSH/SFTP channel to validate your login. Keys, passwords,
                    or a local SSH agent may be tried depending on how the host is locked down.
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">SSH target</span>
                    <HardwareAwareTextInput
                      placeholder="you@192.168.1.42"
                      value={sshTarget}
                      onChange={setSshTarget}
                      onNativeKeyDown={() => {}}
                      surfaceKind="palette"
                      className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                      ariaLabel="SSH target"
                      autoFocus
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">Port</span>
                    <HardwareAwareTextInput
                      placeholder="22"
                      value={sshPort}
                      onChange={setSshPort}
                      onNativeKeyDown={() => {}}
                      surfaceKind="palette"
                      className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                      ariaLabel="SSH port"
                    />
                  </label>
                  <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-2">
                    <div className="mb-2 text-[11px] font-medium text-[var(--text-primary)]">
                      Authentication
                    </div>
                    <p className="mb-3 text-[11px] leading-5 text-[var(--text-secondary)]">
                      If connecting fails without these, paste a password, set your private key
                      path, or configure an SSH agent—the host may require credentials before the
                      next step.
                    </p>
                    <label className="mb-3 flex flex-col gap-1">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        Password (optional)
                      </span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={sshPassword}
                        onChange={(event) => setSshPassword(event.target.value)}
                        placeholder="SSH password when required"
                        className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                        aria-label="SSH password"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        SSH private key path (optional)
                      </span>
                      <HardwareAwareTextInput
                        placeholder="C:\\Users\\you\\.ssh\\id_ed25519"
                        value={sshKeyPath}
                        onChange={setSshKeyPath}
                        onNativeKeyDown={() => {}}
                        surfaceKind="palette"
                        className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                        ariaLabel="SSH key path"
                      />
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={sshProbeBusy}
                    className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
                  >
                    {sshProbeBusy ? "Connecting…" : "Connect & continue"}
                  </button>
                </form>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={sshProbeBusy || sshBrowseBusy || sshRemoteCloneBusy}
                      onClick={() => handleSshWizardBack()}
                      className="inline-flex items-center gap-1 rounded-[var(--radius-tab)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] disabled:opacity-50"
                    >
                      <ArrowLeft className="size-[13px]" />
                      Different host
                    </button>
                    {sshConnectedLabel ? (
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        Signed in as <span className="font-medium">{sshConnectedLabel}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)]/60 px-3 py-2 text-[12px] leading-5 text-[var(--text-secondary)]">
                    Mirrors a remote folder into a local sandbox workspace and keeps edits synced
                    with push/pull commands. Activities below affect the SSH host—not this machine&apos;s local folder browser.
                  </div>
                  <div className="break-all rounded-[var(--radius-tab)] border border-dashed border-[var(--palette-border)] px-2 py-1.5 font-mono text-[10.5px] text-[var(--text-secondary)]">
                    Current folder:{" "}
                    <span className="text-[var(--text-primary)]">{sshRemotePath || "—"}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={sshSubTabClass("browse")}
                      onClick={() => setSshRemoteSetupTab("browse")}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Folder className="size-[13px]" strokeWidth={1.5} />
                        Browse folders
                      </span>
                    </button>
                    <button
                      type="button"
                      className={sshSubTabClass("newfolder")}
                      onClick={() => setSshRemoteSetupTab("newfolder")}
                    >
                      New folder
                    </button>
                    <button
                      type="button"
                      className={sshSubTabClass("clone")}
                      onClick={() => setSshRemoteSetupTab("clone")}
                    >
                      <span className="inline-flex items-center gap-1">
                        <FolderGit2 className="size-[13px]" strokeWidth={1.5} />
                        Clone Git URL
                      </span>
                    </button>
                  </div>

                  {sshRemoteSetupTab === "browse" ? (
                    <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)]">
                      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--palette-border)] px-3 py-2">
                        <button
                          type="button"
                          disabled={sshBrowseBusy}
                          onClick={() => void handleSshBrowse()}
                          className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)] disabled:opacity-50"
                        >
                          {sshBrowseBusy ? "Loading…" : "Refresh listing"}
                        </button>
                        {sshRemoteParent ? (
                          <button
                            type="button"
                            disabled={sshBrowseBusy}
                            onClick={() => void handleSshBrowse(sshRemoteParent)}
                            className="inline-flex items-center gap-1 rounded-[var(--radius-tab)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] disabled:opacity-50"
                          >
                            <ArrowLeft className="size-[13px]" />
                            Up
                          </button>
                        ) : null}
                      </div>
                      {sshRemoteEntries.length > 0 ? (
                        <div className="max-h-[220px] overflow-y-auto">
                          {sshRemoteEntries.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              disabled={sshBrowseBusy}
                              onClick={() => void handleSshBrowse(entry.path)}
                              className="flex w-full items-center gap-2 border-b border-[var(--palette-border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--bg-card)] disabled:opacity-50"
                            >
                              <ChevronRightIcon />
                              <span className="truncate text-[12px]">{entry.name}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="px-3 py-3 text-[11px] text-[var(--text-secondary)]">
                          No folders listed yet—tap refresh.
                        </div>
                      )}
                    </div>
                  ) : null}

                  {sshRemoteSetupTab === "newfolder" ? (
                    <div className="flex flex-col gap-2 rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-3">
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        Adds an empty subdirectory under the current folder ({sshRemotePath || "."}
                        ).
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <HardwareAwareTextInput
                          placeholder="new-empty-folder"
                          value={sshNewDirectoryName}
                          onChange={setSshNewDirectoryName}
                          onNativeKeyDown={() => {}}
                          surfaceKind="palette"
                          className="box-border min-w-0 flex-1 rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[12px] outline-none"
                          ariaLabel="New remote folder name"
                        />
                        <button
                          type="button"
                          disabled={
                            sshBrowseBusy || sshRemoteCloneBusy || !sshNewDirectoryName.trim()
                          }
                          onClick={() => void handleSshCreateDirectory()}
                          className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-1.5 text-[11px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
                        >
                          Create
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {sshRemoteSetupTab === "clone" ? (
                    <div className="flex flex-col gap-2 rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-3">
                      <p className="text-[11px] leading-5 text-[var(--text-secondary)]">
                        Runs <code className="font-mono text-[10px]">git clone</code> on the SSH
                        host inside the highlighted folder ({sshRemotePath || "."}). Git must exist
                        on that machine.
                      </p>
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-[var(--text-secondary)]">
                          Git remote
                        </span>
                        <HardwareAwareTextInput
                          placeholder="https://github.com/org/repo.git"
                          value={sshRemoteRepoUrl}
                          onChange={setSshRemoteRepoUrl}
                          onNativeKeyDown={() => {}}
                          surfaceKind="palette"
                          className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                          ariaLabel="Remote git clone URL"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-[11px] text-[var(--text-secondary)]">
                          Folder name (optional)
                        </span>
                        <HardwareAwareTextInput
                          placeholder="my-fork"
                          value={sshRemoteCloneFolderName}
                          onChange={setSshRemoteCloneFolderName}
                          onNativeKeyDown={() => {}}
                          surfaceKind="palette"
                          className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                          ariaLabel="Remote clone folder name"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={sshRemoteCloneBusy || !sshRemoteRepoUrl.trim()}
                        onClick={() => void handleSshRemoteClone()}
                        className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
                      >
                        {sshRemoteCloneBusy ? "Cloning…" : "Clone into current folder"}
                      </button>
                    </div>
                  ) : null}

                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      Remote workspace path (edit or drill using Browse)
                    </span>
                    <HardwareAwareTextInput
                      placeholder="/home/you/project"
                      value={sshRemotePath}
                      onChange={setSshRemotePath}
                      onNativeKeyDown={() => {}}
                      surfaceKind="palette"
                      className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 font-mono text-[12px] outline-none"
                      ariaLabel="Remote folder for workspace mirror"
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        Workspace name (optional)
                      </span>
                      <HardwareAwareTextInput
                        placeholder="Production API"
                        value={sshWorkspaceName}
                        onChange={setSshWorkspaceName}
                        onNativeKeyDown={() => {}}
                        surfaceKind="palette"
                        className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                        ariaLabel="SSH workspace name"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        Local mirror folder (optional)
                      </span>
                      <HardwareAwareTextInput
                        placeholder="api-prod"
                        value={sshMirrorName}
                        onChange={setSshMirrorName}
                        onNativeKeyDown={() => {}}
                        surfaceKind="palette"
                        className="box-border w-full rounded-[var(--radius-tab)] border border-[var(--palette-border)] bg-[var(--bg-deep)] px-2 py-1.5 text-[13px] outline-none"
                        ariaLabel="SSH local mirror folder"
                      />
                    </label>
                  </div>

                  {activeSshMetadata ? (
                    <div className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-2">
                      <div className="text-[11px] font-medium text-[var(--text-primary)]">
                        Active SSH mirror
                      </div>
                      <div className="mt-1 break-all font-mono text-[10.5px] text-[var(--text-secondary)]">
                        {activeSshMetadata.target}:{activeSshMetadata.remotePath}
                      </div>
                      <div className="mt-1 break-all font-mono text-[10.5px] text-[var(--text-secondary)]">
                        {activeSshMetadata.localRoot}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={sshSyncBusy !== null}
                          onClick={() => void handleSshPull()}
                          className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)] disabled:opacity-50"
                        >
                          {sshSyncBusy === "pull" ? "Pulling…" : "Pull remote"}
                        </button>
                        <button
                          type="button"
                          disabled={sshSyncBusy !== null}
                          onClick={() => void handleSshPush()}
                          className="rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)] disabled:opacity-50"
                        >
                          {sshSyncBusy === "push" ? "Pushing…" : "Push local"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    disabled={sshBusy}
                    onClick={() => void handleSshWorkspace()}
                    className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-50"
                  >
                    {sshBusy ? "Syncing…" : "Mirror & open workspace"}
                  </button>
                </div>
              )}
            </div>
          )}

          {mode === "remove" && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-[var(--text-secondary)]">
                Removes the workspace from Cesium’s list. Your files stay on disk. Home cannot be removed.
              </p>
              {removable.length === 0 ? (
                <p className="text-[12px] text-[var(--text-secondary)]">No removable workspaces.</p>
              ) : (
                removable.map((w: WorkspaceRecord) => (
                  <div
                    key={w.id}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius-tab)] border border-[var(--palette-border)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{w.name}</div>
                      <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]">{w.root}</div>
                    </div>
                    <button
                      type="button"
                      disabled={removeBusy !== null}
                      onClick={() => void handleDelete(w.id)}
                      className="shrink-0 rounded-[var(--radius-tab)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                    >
                      {removeBusy === w.id ? "…" : "Remove"}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {toast ? (
          <div className="border-t border-[var(--palette-divider)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
            {toast}
          </div>
        ) : (
          <div className="border-t border-[var(--palette-divider)] px-[10px] py-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
            Tip: allowed roots come from <code className="font-mono text-[10px]">WORKSPACE_ALLOWED_ROOTS</code> or your
            home / <code className="font-mono text-[10px]">WORKSPACE_ROOT</code> / repo root.
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronRightIcon() {
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center text-[var(--text-secondary)]">
      ›
    </span>
  );
}
