"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Circle,
  FolderOpen,
  GitPullRequest,
  ListChecks,
  Radio,
  X,
} from "lucide-react";
import {
  parseProjectNotes,
  projectSubscriptionMeta,
  summarizeProjectNotes,
  type ProjectNotesLine,
  type ProjectSubscriptionSummary,
} from "@cesium/core";
import { deleteProjectSubscription, readProjectContextFile } from "@/lib/server-api";
import { projectErrorMessage, projectErrorTextClass } from "./project-ui";
import { useProjects, useProjectSnapshot } from "./ProjectsProvider";

const NOTES_PATH = "notes.md";
const NOTES_POLL_MS = 4_000;

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Private mode: the card just forgets.
  }
}

/** notes.md, kept current by the coordinator: the Project's live plan. */
function useProjectNotes(projectId: string): string | null {
  const [notes, setNotes] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      readProjectContextFile(projectId, NOTES_PATH).then(
        (file) => {
          if (!cancelled) {
            setNotes(file.content);
          }
        },
        () => {
          if (!cancelled) {
            setNotes("");
          }
        }
      );
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, NOTES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);
  return notes;
}

function NotesLineView({ line }: { line: ProjectNotesLine }) {
  if (line.kind === "heading") {
    return (
      <li className="pt-[4px] font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--text-secondary)]">
        {line.text}
      </li>
    );
  }
  if (line.kind === "text") {
    return <li className="font-sans text-[12.5px] text-[var(--text-secondary)]">{line.text}</li>;
  }
  const indent = { paddingLeft: line.depth * 14 };
  if (line.kind === "bullet") {
    return (
      <li className="flex items-start gap-[7px] font-sans text-[12.5px] text-[var(--text-secondary)]" style={indent}>
        <span className="mt-[7px] size-[3px] shrink-0 rounded-full bg-[var(--text-secondary)]" aria-hidden />
        <span className="min-w-0 break-words">{line.text}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-[7px] font-sans text-[12.5px]" style={indent}>
      {line.done ? (
        <Check className="mt-[2px] size-[13px] shrink-0 text-[var(--status-success)]" strokeWidth={2.2} aria-label="Done" />
      ) : (
        <Circle className="mt-[2px] size-[12px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.8} aria-label="To do" />
      )}
      <span
        className={`min-w-0 break-words ${line.done ? "text-[var(--text-secondary)] line-through decoration-[color-mix(in_srgb,var(--text-secondary)_50%,transparent)]" : "text-[var(--text-primary)]"}`}
      >
        {line.text}
      </span>
    </li>
  );
}

function NotesChecklist({ projectId }: { projectId: string }) {
  const { openContextFile } = useProjects();
  const notes = useProjectNotes(projectId);
  const collapsedKey = `cesium.projects.notesCollapsed.${projectId}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(readFlag(collapsedKey));
  }, [collapsedKey]);

  const lines = notes ? parseProjectNotes(notes) : [];
  const tasks = summarizeProjectNotes(notes ?? "");
  // A notes.md that is only its title is not a plan yet.
  if (lines.filter((line) => line.kind !== "heading").length === 0) {
    return null;
  }
  const toggle = () => {
    setCollapsed((current) => {
      writeFlag(collapsedKey, !current);
      return !current;
    });
  };
  return (
    <div
      className="overflow-hidden rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)]"
      data-project-notes-checklist
    >
      <div className="flex items-center gap-[6px] px-[10px] py-[6px]">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-[7px] text-left"
          aria-expanded={!collapsed}
        >
          <ListChecks className="size-[14px] shrink-0 text-[var(--accent)]" strokeWidth={1.7} aria-hidden />
          <span className="font-sans text-[12.5px] font-medium text-[var(--text-primary)]">Plan</span>
          {tasks.total > 0 ? (
            <span className="font-sans text-[11.5px] tabular-nums text-[var(--text-secondary)]">
              {tasks.done} of {tasks.total} done
            </span>
          ) : null}
          <ChevronDown
            className={`size-[13px] shrink-0 text-[var(--text-secondary)] transition-transform ${collapsed ? "-rotate-90" : ""}`}
            strokeWidth={1.8}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={() => openContextFile(NOTES_PATH)}
          className="shrink-0 font-sans text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          notes.md
        </button>
      </div>
      {!collapsed ? (
        <ul className="flex max-h-[180px] flex-col gap-[3px] overflow-y-auto border-t border-[var(--border-subtle)] px-[10px] pb-[8px] pt-[6px]">
          {lines.map((line, index) => (
            <NotesLineView key={index} line={line} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ListeningList({
  projectId,
  subscriptions,
  onClose,
}: {
  projectId: string;
  subscriptions: ProjectSubscriptionSummary[];
  onClose: () => void;
}) {
  const { refreshProject } = useProjects();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const remove = async (subscription: ProjectSubscriptionSummary) => {
    setRemoving(subscription.id);
    setError(null);
    try {
      await deleteProjectSubscription(projectId, subscription.id);
      await refreshProject(projectId);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setRemoving(null);
    }
  };

  const now = Date.now();
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Listening"
      className="absolute bottom-[calc(100%+6px)] left-0 z-40 w-[min(360px,calc(100vw-24px))] rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--bg-panel)] p-[8px] shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
    >
      <p className="px-[4px] pb-[6px] font-sans text-[11.5px] text-[var(--text-secondary)]">
        The coordinator wakes up when any of these has news.
      </p>
      {subscriptions.length === 0 ? (
        <p className="px-[4px] py-[4px] font-sans text-[12.5px] text-[var(--text-secondary)]">
          Nothing yet. Agent pull requests and their CI are followed as soon as they open.
        </p>
      ) : (
        <ul className="flex max-h-[260px] flex-col gap-[2px] overflow-y-auto">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className="flex items-start gap-[8px] rounded-[var(--radius-tab)] px-[4px] py-[5px] hover:bg-[var(--agent-card-bg)]">
              <div className="min-w-0 flex-1">
                <p className="truncate font-sans text-[12.5px] text-[var(--text-primary)]" title={subscription.detail ?? subscription.label}>
                  {subscription.label}
                </p>
                <p className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
                  {projectSubscriptionMeta(subscription, now)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(subscription)}
                disabled={removing != null}
                className="flex size-[22px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--status-error)] disabled:opacity-50"
                aria-label={`Stop listening to ${subscription.label}`}
                title="Stop listening"
              >
                <X className="size-[13px]" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className={`${projectErrorTextClass} px-[4px] pt-[4px]`}>{error}</p> : null}
    </div>
  );
}

const chipClass =
  "inline-flex shrink-0 items-center gap-[5px] rounded-[999px] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] px-[9px] py-[2px] font-sans text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]";

/**
 * Above the coordinator's composer: the live plan from notes.md, and one row
 * of chips for the Project's agents, pull requests, what it is listening to,
 * and its Context.
 */
export function ProjectCoordinatorDock({ projectId }: { projectId: string }) {
  const snapshot = useProjectSnapshot(projectId);
  const { setProjectTab } = useProjects();
  const [listeningOpen, setListeningOpen] = useState(false);
  const closeListening = useCallback(() => setListeningOpen(false), []);

  const live = snapshot?.children.filter((child) => child.deletedAt == null && child.archivedAt == null) ?? [];
  const workers = live.filter((child) => child.kind !== "helper");
  const working = workers.filter((child) => child.bucket === "working").length;
  const attention = live.filter((child) => child.bucket === "needs_attention").length;
  const openPrs = live.filter((child) => child.pr?.state === "open").length;
  const subscriptions = snapshot?.subscriptions ?? [];

  return (
    <div className="flex flex-col gap-[6px]" data-project-coordinator-dock>
      <NotesChecklist projectId={projectId} />
      <div className="relative flex flex-wrap items-center gap-[6px]" aria-label="Project overview">
        <button type="button" onClick={() => setProjectTab("agents")} className={chipClass}>
          <Bot className="size-[12px]" strokeWidth={1.8} aria-hidden />
          Agents {workers.length}
          {working > 0 ? <span className="text-[var(--accent)]">· {working} working</span> : null}
          {attention > 0 ? <span className="text-[var(--status-warning)]">· {attention} need you</span> : null}
        </button>
        <button type="button" onClick={() => setProjectTab("prs")} className={chipClass}>
          <GitPullRequest className="size-[12px]" strokeWidth={1.8} aria-hidden />
          PRs {openPrs}
        </button>
        <button
          type="button"
          onClick={() => setListeningOpen((current) => !current)}
          className={chipClass}
          aria-expanded={listeningOpen}
          aria-haspopup="dialog"
        >
          <Radio className={`size-[12px] ${subscriptions.length > 0 ? "text-[var(--accent)]" : ""}`} strokeWidth={1.8} aria-hidden />
          Listening ({subscriptions.length})
        </button>
        <button type="button" onClick={() => setProjectTab("context")} className={chipClass}>
          <FolderOpen className="size-[12px]" strokeWidth={1.8} aria-hidden />
          Context
        </button>
        {listeningOpen ? (
          <ListeningList projectId={projectId} subscriptions={subscriptions} onClose={closeListening} />
        ) : null}
      </div>
    </div>
  );
}

/** An empty coordinator chat: what a Project does and how to start it. */
export function ProjectCoordinatorWelcome({ name, onExample }: { name: string; onExample: (text: string) => void }) {
  const examples = [
    "Look at the checkout flow, find what's broken and fix it.",
    "Add a dark mode, with tests and screenshots.",
    "Every morning, check CI on main and tell me what failed.",
  ];
  return (
    <div className="flex flex-col items-center gap-[12px] px-[16px] text-center" data-project-welcome>
      <p className="font-sans text-[15px] font-medium text-[var(--text-primary)]">{name}</p>
      <p className="max-w-[460px] font-sans text-[13px] leading-[1.55] text-[var(--text-secondary)]">
        Tell the coordinator what you want done, as roughly as you like. It works out the plan, starts
        agents in parallel on their own branches, follows their pull requests and CI, and reports back
        here with what changed and the evidence.
      </p>
      <div className="flex max-w-[520px] flex-wrap justify-center gap-[6px]">
        {examples.map((example) => (
          <button key={example} type="button" onClick={() => onExample(example)} className={chipClass}>
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
