"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FilePlus2, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import type { ProjectContextFile } from "@cesium/core";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { formatAgentRailRelativeTime } from "@/lib/agent-rail-status";
import {
  deleteProjectContextFile,
  listProjectContextFiles,
  readProjectContextFile,
  writeProjectContextFile,
} from "@/lib/server-api";
import {
  projectButtonClass,
  projectDangerButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectHintTextClass,
  projectInputClass,
  projectPrimaryButtonClass,
  projectSelectClass,
} from "./project-ui";

const NOTES_PATH = "notes.md";
const POLL_MS = 5_000;

type OpenFile = { path: string; content: string; updatedAt: number };

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
}

/** The Project context folder: notes.md first, plus any specs or reports kept beside it. */
export function ProjectNotesSection({
  projectId,
  contextRoot,
}: {
  projectId: string;
  contextRoot: string;
}) {
  const dialogs = useWorkbenchDialogs();
  const [files, setFiles] = useState<ProjectContextFile[] | null>(null);
  const [selected, setSelected] = useState(NOTES_PATH);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const [listing, opened] = await Promise.all([
        listProjectContextFiles(projectId),
        readProjectContextFile(projectId, selected).then(
          (value) => ({ value, failure: null }),
          (caught: unknown) => ({ value: null, failure: projectErrorMessage(caught) })
        ),
      ]);
      if (request !== requestRef.current) {
        return;
      }
      setFiles(listing.files);
      if (opened.value) {
        const { path, content, updatedAt } = opened.value;
        setFile({ path, content, updatedAt });
      }
      setError(opened.failure);
    } catch (caught) {
      if (request === requestRef.current) {
        setError(projectErrorMessage(caught));
      }
    }
  }, [projectId, selected]);

  const editOnOpenRef = useRef<string | null>(null);

  useEffect(() => {
    setFile(null);
    setDraft(editOnOpenRef.current === selected ? "" : null);
    editOnOpenRef.current = null;
    void load();
  }, [load, selected]);

  useEffect(() => {
    if (draft != null) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [draft, load]);

  const save = async () => {
    if (draft == null) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await writeProjectContextFile(projectId, { path: selected, content: draft });
      setDraft(null);
      await load();
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const createFile = async () => {
    const path = await dialogs.prompt({
      title: "New context file",
      message: "Agents and the orchestrator can read it. Paths are relative to the Project folder.",
      placeholder: "specs/api.md",
      confirmLabel: "Create",
      monospace: true,
      validate: (value) =>
        value.startsWith("/") || /^[a-zA-Z]:/.test(value)
          ? "Use a path relative to the Project folder."
          : value.split(/[\\/]/).some((segment) => segment === ".." || segment.startsWith("."))
            ? "Hidden files and .. are not allowed."
            : null,
    });
    if (!path) {
      return;
    }
    try {
      const existing = files?.find((entry) => entry.path === path);
      if (existing) {
        setSelected(existing.path);
        return;
      }
      const written = await writeProjectContextFile(projectId, { path, content: "" });
      editOnOpenRef.current = written.path;
      setSelected(written.path);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  };

  const removeFile = async () => {
    const confirmed = await dialogs.confirm({
      title: `Delete ${selected}?`,
      message: "Removes it from the Project context folder.",
      confirmLabel: "Delete file",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteProjectContextFile(projectId, selected);
      setSelected(NOTES_PATH);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    }
  };

  const ordered = [...(files ?? [])].sort((a, b) =>
    a.path === NOTES_PATH ? -1 : b.path === NOTES_PATH ? 1 : a.path.localeCompare(b.path)
  );
  const markdown = /\.(md|markdown|mdx)$/i.test(selected);
  const selectedMeta = files?.find((entry) => entry.path === selected);

  return (
    <div className="flex min-h-full flex-col gap-[10px] px-[16px] py-[12px]">
      <div className="flex flex-wrap items-center gap-[6px]">
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={draft != null}
          aria-label="Context file"
          className={`${projectSelectClass} w-auto min-w-[160px] max-w-full flex-1 font-mono text-[12px]`}
        >
          {ordered.length === 0 ? <option value={NOTES_PATH}>{NOTES_PATH}</option> : null}
          {ordered.map((entry) => (
            <option key={entry.path} value={entry.path}>
              {entry.path}
            </option>
          ))}
        </select>
        {draft == null ? (
          <>
            <button type="button" onClick={() => setDraft(file?.content ?? "")} className={projectButtonClass} disabled={!file}>
              <Pencil className="size-[12px]" strokeWidth={1.7} aria-hidden />
              Edit
            </button>
            <button type="button" onClick={() => void createFile()} className={projectButtonClass}>
              <FilePlus2 className="size-[12px]" strokeWidth={1.7} aria-hidden />
              New file
            </button>
            {selected !== NOTES_PATH ? (
              <button
                type="button"
                onClick={() => void removeFile()}
                className={projectDangerButtonClass}
                aria-label={`Delete ${selected}`}
                title="Delete file"
              >
                <Trash2 className="size-[12px]" strokeWidth={1.7} />
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" onClick={() => setDraft(null)} disabled={saving} className={projectButtonClass}>
              Cancel
            </button>
            <button type="button" onClick={() => void save()} disabled={saving} className={projectPrimaryButtonClass}>
              {saving ? <LoaderCircle className="size-[12px] animate-spin" aria-hidden /> : null}
              Save
            </button>
          </>
        )}
      </div>
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
      {draft != null ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          aria-label={`Edit ${selected}`}
          spellCheck={false}
          className={`${projectInputClass} min-h-[320px] flex-1 resize-y font-mono text-[12px] leading-[1.5]`}
          autoFocus
        />
      ) : file ? (
        file.content.trim() ? (
          markdown ? (
            <div className="min-w-0 select-text font-sans text-[13px]" data-project-notes>
              <ChatMarkdown source={file.content} />
            </div>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[8px] py-[6px] font-mono text-[11.5px] leading-[1.5] text-[var(--text-primary)]">
              {file.content}
            </pre>
          )
        ) : (
          <p className={projectHintTextClass}>This file is empty.</p>
        )
      ) : !error ? (
        <p className={projectHintTextClass}>Loading…</p>
      ) : null}
      <p className={`${projectHintTextClass} mt-auto border-t border-[var(--border-subtle)] pt-[8px]`}>
        The orchestrator reads {NOTES_PATH} every turn and keeps goals, decisions and the agent roster
        there.
        {selectedMeta
          ? ` ${selected} · ${formatBytes(selectedMeta.size)} · updated ${formatAgentRailRelativeTime(selectedMeta.updatedAt)}.`
          : ""}{" "}
        <span className="break-all font-mono">{contextRoot}</span>
      </p>
    </div>
  );
}
