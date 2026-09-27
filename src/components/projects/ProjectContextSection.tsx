"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  Folder,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import {
  buildProjectContextTree,
  projectContextPreviewKind,
  type ProjectContextFile,
  type ProjectContextTreeNode,
} from "@cesium/core";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";
import {
  deleteProjectContextFile,
  listProjectContextFiles,
  readProjectContextFile,
  uploadProjectContextFile,
  writeProjectContextFile,
} from "@/lib/server-api";
import { ProjectContextMediaProvider, useProjectContextObjectUrl } from "./ProjectContextMedia";
import {
  projectButtonClass,
  projectDangerButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectHintTextClass,
  projectInputClass,
  projectPrimaryButtonClass,
} from "./project-ui";
import { useProjects } from "./ProjectsProvider";

const NOTES_PATH = "notes.md";
const POLL_MS = 5_000;
const DEFAULT_UPLOAD_FOLDER = "media";

type Listing = { files: ProjectContextFile[]; folders: string[] };

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** The Project context: notes.md, docs/, internal/, media/ and inbox/, with previews and uploads. */
export function ProjectContextSection({ projectId, contextRoot }: { projectId: string; contextRoot: string }) {
  const dialogs = useWorkbenchDialogs();
  const { focusedContextPath, openContextFile } = useProjects();
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<string>(focusedContextPath ?? NOTES_PATH);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["docs", "media"]));
  const [editing, setEditing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const result = await listProjectContextFiles(projectId);
      if (request === requestRef.current) {
        setListing({ files: result.files, folders: result.folders ?? [] });
        setError(null);
      }
    } catch (caught) {
      if (request === requestRef.current) {
        setError(projectErrorMessage(caught));
      }
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (editing != null) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [editing, load]);

  useEffect(() => {
    if (!focusedContextPath) {
      return;
    }
    setSelected(focusedContextPath);
    setEditing(null);
    setExpanded((current) => new Set([...current, ...ancestors(focusedContextPath), focusedContextPath]));
  }, [focusedContextPath]);

  const tree = useMemo(
    () => (listing ? buildProjectContextTree(listing.files, listing.folders) : []),
    [listing]
  );
  const selectedFile = listing?.files.find((file) => file.path === selected) ?? null;
  const selectedIsFolder =
    !selectedFile && (listing?.folders.includes(selected) || listing?.files.some((file) => file.path.startsWith(`${selected}/`)));
  const uploadFolder = selectedIsFolder ? selected : selectedFile ? parentFolder(selectedFile.path) || DEFAULT_UPLOAD_FOLDER : DEFAULT_UPLOAD_FOLDER;

  const select = (path: string) => {
    if (editing != null) {
      return;
    }
    setSelected(path);
  };

  const toggleFolder = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    select(path);
  };

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (list.length === 0) {
      return;
    }
    setError(null);
    try {
      let last: string | null = null;
      for (const file of list) {
        const path = uploadFolder ? `${uploadFolder}/${file.name}` : file.name;
        setUploading(path);
        last = (await uploadProjectContextFile(projectId, path, file)).path;
      }
      await load();
      if (last) {
        setExpanded((current) => new Set([...current, ...ancestors(last!)]));
        setSelected(last);
      }
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setUploading(null);
    }
  };

  const createFile = async () => {
    const path = await dialogs.prompt({
      title: "New Context file",
      message: "The coordinator and every agent can read it. docs/ is for you, internal/ for agents.",
      placeholder: "docs/spec.md",
      defaultValue: uploadFolder && uploadFolder !== DEFAULT_UPLOAD_FOLDER ? `${uploadFolder}/` : "docs/",
      confirmLabel: "Create",
      monospace: true,
      validate: (value) =>
        !value.trim() || value.endsWith("/")
          ? "Name the file."
          : value.startsWith("/") || /^[a-zA-Z]:/.test(value)
            ? "Use a path relative to the Project context."
            : value.split(/[\\/]/).some((segment) => segment === ".." || segment.startsWith("."))
              ? "Hidden files and .. are not allowed."
              : null,
    });
    if (!path) {
      return;
    }
    try {
      const existing = listing?.files.find((file) => file.path === path);
      if (!existing) {
        await writeProjectContextFile(projectId, { path, content: "" });
        await load();
      }
      setExpanded((current) => new Set([...current, ...ancestors(path)]));
      setSelected(path);
      setEditing(existing ? null : path);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  };

  const removeFile = async (path: string) => {
    const confirmed = await dialogs.confirm({
      title: `Delete ${path}?`,
      message: "Removes it from the Project context for the coordinator and every agent.",
      confirmLabel: "Delete file",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteProjectContextFile(projectId, path);
      setSelected(parentFolder(path) || NOTES_PATH);
      await load();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) {
      void upload(event.dataTransfer.files);
    }
  };

  return (
    <ProjectContextMediaProvider projectId={projectId} openInContext={openContextFile}>
      <div
        className={`relative flex min-h-full flex-col gap-[10px] px-[16px] py-[12px] ${dragging ? "outline-dashed outline-2 -outline-offset-4 outline-[var(--accent)]" : ""}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
        data-project-context
      >
        <div className="flex flex-wrap items-center gap-[6px]">
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading != null} className={projectButtonClass}>
            {uploading ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : <Upload className="size-[12px]" strokeWidth={1.7} aria-hidden />}
            Upload to {uploadFolder || "the root"}/
          </button>
          <button type="button" onClick={() => void createFile()} disabled={editing != null} className={projectButtonClass}>
            <FilePlus2 className="size-[12px]" strokeWidth={1.7} aria-hidden />
            New file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) {
                void upload(event.target.files);
              }
              event.target.value = "";
            }}
          />
        </div>
        {error ? <p className={projectErrorTextClass}>{error}</p> : null}
        {uploading ? <p className={projectHintTextClass}>Uploading {uploading}…</p> : null}
        <div className="max-h-[42%] min-h-[96px] shrink-0 overflow-y-auto rounded-[var(--radius-tab)] border border-[var(--border-subtle)] py-[4px]" role="tree" aria-label="Project context">
          {listing == null ? (
            <p className={`${projectHintTextClass} px-[10px] py-[4px]`}>Loading…</p>
          ) : (
            <ContextTreeLevel
              nodes={tree}
              depth={0}
              selected={selected}
              expanded={expanded}
              onSelect={select}
              onToggle={toggleFolder}
            />
          )}
        </div>
        {selectedFile ? (
          <ContextFilePreview
            key={selectedFile.path}
            projectId={projectId}
            file={selectedFile}
            editing={editing === selectedFile.path}
            onEdit={(on) => setEditing(on ? selectedFile.path : null)}
            onSaved={() => void load()}
            onDelete={selectedFile.path === NOTES_PATH ? null : () => void removeFile(selectedFile.path)}
          />
        ) : listing ? (
          <p className={projectHintTextClass}>
            {selectedIsFolder
              ? `Drop files here to upload them to ${selected}/.`
              : `${selected} is not in the Project context yet.`}
          </p>
        ) : null}
        <p className={`${projectHintTextClass} mt-auto border-t border-[var(--border-subtle)] pt-[8px]`}>
          The coordinator reads notes.md every turn. docs/ holds plans and reports for you, internal/ notes
          for agents, media/ screenshots and recordings, inbox/ raw GitHub and timer events.{" "}
          <span className="break-all font-mono">{contextRoot}</span>
        </p>
      </div>
    </ProjectContextMediaProvider>
  );
}

function ContextTreeLevel({
  nodes,
  depth,
  selected,
  expanded,
  onSelect,
  onToggle,
}: {
  nodes: ProjectContextTreeNode[];
  depth: number;
  selected: string;
  expanded: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <ul role={depth === 0 ? undefined : "group"}>
      {nodes.map((node) => {
        const active = node.path === selected;
        const open = node.type === "folder" && expanded.has(node.path);
        const kind = node.type === "file" ? projectContextPreviewKind(node.path, node.file.kind) : null;
        const Icon = node.type === "folder" ? Folder : kind === "image" ? ImageIcon : kind === "video" ? Video : FileText;
        return (
          <li key={node.path} role="treeitem" aria-selected={active} aria-expanded={node.type === "folder" ? open : undefined}>
            <button
              type="button"
              onClick={() => (node.type === "folder" ? onToggle(node.path) : onSelect(node.path))}
              className={`flex h-[24px] w-full min-w-0 items-center gap-[5px] pr-[8px] text-left font-sans text-[12.5px] ${
                active ? "bg-[var(--agent-card-bg)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {node.type === "folder" ? (
                <ChevronRight className={`size-[11px] shrink-0 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={2} aria-hidden />
              ) : (
                <span className="w-[11px] shrink-0" />
              )}
              <Icon className="size-[13px] shrink-0" strokeWidth={1.6} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.type === "folder" ? (
                <span className="shrink-0 font-sans text-[10.5px] tabular-nums text-[var(--text-disabled)]">{node.children.length || ""}</span>
              ) : null}
            </button>
            {node.type === "folder" && open ? (
              node.children.length > 0 ? (
                <ContextTreeLevel
                  nodes={node.children}
                  depth={depth + 1}
                  selected={selected}
                  expanded={expanded}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              ) : (
                <p className="py-[2px] font-sans text-[11.5px] italic text-[var(--text-disabled)]" style={{ paddingLeft: 38 + depth * 14 }}>
                  No files yet
                </p>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ContextFilePreview({
  projectId,
  file,
  editing,
  onEdit,
  onSaved,
  onDelete,
}: {
  projectId: string;
  file: ProjectContextFile;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onSaved: () => void;
  onDelete: (() => void) | null;
}) {
  const kind = projectContextPreviewKind(file.path, file.kind);
  const textual = kind === "markdown" || kind === "text";
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const media = useProjectContextObjectUrl(
    textual ? null : projectId,
    textual ? null : file.path,
    String(file.updatedAt)
  );

  useEffect(() => {
    if (!textual || editing) {
      return;
    }
    let cancelled = false;
    readProjectContextFile(projectId, file.path).then(
      (value) => {
        if (!cancelled) {
          setContent(value.content);
          setError(null);
        }
      },
      (caught: unknown) => {
        if (!cancelled) {
          setError(projectErrorMessage(caught));
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [editing, file.path, file.updatedAt, projectId, textual]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await writeProjectContextFile(projectId, { path: file.path, content: draft });
      setContent(draft);
      onEdit(false);
      onSaved();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[8px]" data-project-context-preview={file.path}>
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-sans text-[11px] text-[var(--text-disabled)]">
          {formatBytes(file.size)} · {formatAgentRailRelativeTime(file.updatedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        {textual && !editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(content ?? "");
              onEdit(true);
            }}
            disabled={content == null}
            className={projectButtonClass}
          >
            <Pencil className="size-[12px]" strokeWidth={1.7} aria-hidden />
            Edit
          </button>
        ) : null}
        {editing ? (
          <>
            <button type="button" onClick={() => onEdit(false)} disabled={saving} className={projectButtonClass}>
              Cancel
            </button>
            <button type="button" onClick={() => void save()} disabled={saving} className={projectPrimaryButtonClass}>
              {saving ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
              Save
            </button>
          </>
        ) : null}
        {!textual && media.url ? (
          <a href={media.url} download={file.path.split("/").pop()} className={projectButtonClass}>
            <Download className="size-[12px]" strokeWidth={1.7} aria-hidden />
            Download
          </a>
        ) : null}
        {onDelete && !editing ? (
          <button type="button" onClick={onDelete} className={projectDangerButtonClass} aria-label={`Delete ${file.path}`} title="Delete file">
            <Trash2 className="size-[12px]" strokeWidth={1.7} />
          </button>
        ) : null}
      </div>
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
      {editing ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          aria-label={`Edit ${file.path}`}
          spellCheck={false}
          className={`${projectInputClass} min-h-[260px] flex-1 resize-y font-mono text-[12px] leading-[1.5]`}
          autoFocus
        />
      ) : textual ? (
        content == null ? (
          !error ? <p className={projectHintTextClass}>Loading…</p> : null
        ) : !content.trim() ? (
          <p className={projectHintTextClass}>This file is empty.</p>
        ) : kind === "markdown" ? (
          <div className="min-w-0 select-text font-sans text-[13px]">
            <ChatMarkdown source={content} />
          </div>
        ) : (
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[8px] py-[6px] font-mono text-[11.5px] leading-[1.5] text-[var(--text-primary)]">
            {content}
          </pre>
        )
      ) : media.error ? (
        <p className={projectErrorTextClass}>{media.error}</p>
      ) : !media.url ? (
        <p className={`${projectHintTextClass} inline-flex items-center gap-[6px]`}>
          <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
          Loading…
        </p>
      ) : kind === "image" ? (
        <img src={media.url} alt={file.path} className="max-h-[520px] max-w-full self-start rounded-[8px] border border-[var(--border-card)] object-contain" />
      ) : kind === "video" ? (
        <video src={media.url} controls preload="metadata" className="max-h-[520px] max-w-full self-start rounded-[8px] border border-[var(--border-card)] bg-black" />
      ) : (
        <p className={projectHintTextClass}>No preview for this kind of file; download it to open it.</p>
      )}
    </div>
  );
}
