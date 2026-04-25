"use client";

import { ArrowLeft, Folder, FolderGit2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { browseWorkspaceHostDirectories } from "@/lib/server-api";
import type { WorkspaceRecord } from "@/lib/types";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";

const shell =
  "flex w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--palette-border)] bg-[var(--palette-surface)] shadow-[var(--palette-shadow)] max-h-[min(72vh,720px)]";

type Mode = "clone" | "browse" | "newfolder" | "remove";

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
    cloneWorkspaceFromGit,
    createWorkspace,
    deleteWorkspace,
    homeWorkspaceId,
    openFolder,
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

  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);

  const [removeBusy, setRemoveBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setToast(null);
  }, [open, initialMode]);

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
          const projects = data.roots.find((r) => r.label === "projects");
          setCloneParent(projects?.path ?? data.roots[0]!.path);
        }
      } catch {
        setCloneParent("");
      }
    })();
  }, [open, mode]);

  useEffect(() => {
    if (!open || mode !== "newfolder") return;
    void (async () => {
      try {
        const data = await browseWorkspaceHostDirectories();
        if ("roots" in data && data.roots[0]) {
          const projects = data.roots.find((r) => r.label === "projects");
          setNewFolderParent(projects?.path ?? data.roots[0]!.path);
        }
      } catch {
        setNewFolderParent("");
      }
    })();
  }, [open, mode]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const handleClone = async () => {
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
    if (!browseCurrent) return;
    try {
      await openFolder(browseCurrent);
      flash("Workspace opened.");
      onClose();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to open folder.");
    }
  };

  const handleNewFolder = async () => {
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

  const handleDelete = async (workspaceId: string) => {
    if (workspaceId === homeWorkspaceId) {
      flash("The Home workspace cannot be removed.");
      return;
    }
    const label =
      workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Remove workspace “${label}” from OpenCursor? This does not delete files on disk.`)
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
          onClose();
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
                  disabled={!browseCurrent || browseBusy}
                  onClick={() => void handleOpenBrowseFolder()}
                  className="rounded-[var(--radius-tab)] bg-[var(--text-primary)] px-3 py-2 text-[12px] font-semibold text-[var(--bg-deep)] disabled:opacity-40"
                >
                  Open this folder
                </button>
              </div>
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

          {mode === "remove" && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-[var(--text-secondary)]">
                Removes the workspace from OpenCursor’s list. Your files stay on disk. Home cannot be removed.
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
