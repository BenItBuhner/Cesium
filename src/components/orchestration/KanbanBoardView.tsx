"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addOrchestrationIssueComment,
  buildOrchestrationWebSocketUrl,
  createOrchestrationIssue,
  deleteOrchestrationIssue,
  fetchOrchestrationBoardSnapshot,
  patchOrchestrationIssue,
} from "@/lib/server-api";
import {
  ORCHESTRATION_COLUMNS,
  type OrchestrationBoardSnapshot,
  type OrchestrationColumnId,
  type OrchestrationIssueRecord,
  type OrchestrationIssuePriority,
  type OrchestrationSocketServerMessage,
} from "@/lib/orchestration-types";
import { useWorkspace } from "@/contexts/WorkspaceContext";

const cardClass =
  "rounded-[var(--radius-card,var(--radius-tab))] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px] shadow-sm";
const smallButtonClass =
  "rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[8px] py-[4px] text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)]";

function formatTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

const WORKFLOW_COLUMNS: OrchestrationColumnId[] = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
];

function adjacentWorkflowColumn(
  columnId: OrchestrationColumnId,
  direction: -1 | 1
): OrchestrationColumnId | null {
  if (columnId === "blocked") {
    return direction === 1 ? "in_progress" : null;
  }
  const index = WORKFLOW_COLUMNS.indexOf(columnId);
  const next = WORKFLOW_COLUMNS[index + direction];
  return next ?? null;
}

function moveLabel(columnId: OrchestrationColumnId): string {
  switch (columnId) {
    case "ready":
      return "Move to ready";
    case "in_progress":
      return "Start work";
    case "review":
      return "Request review";
    case "done":
      return "Mark done";
    default:
      return `Move to ${columnId.replace("_", " ")}`;
  }
}

function IssueCard({
  issue,
  agents,
  onMove,
  onUpdate,
  onBlock,
  onDelete,
  onComment,
}: {
  issue: OrchestrationIssueRecord;
  agents: number;
  onMove: (columnId: OrchestrationColumnId) => void;
  onUpdate: (patch: {
    title?: string;
    description?: string;
    priority?: OrchestrationIssuePriority;
    acceptanceCriteria?: string[];
    blockedReason?: string | null;
  }) => void;
  onBlock: (blockerExplanation: string) => void;
  onDelete: () => void;
  onComment: (message: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blockerExplanation, setBlockerExplanation] = useState("");
  const [draftTitle, setDraftTitle] = useState(issue.title);
  const [draftDescription, setDraftDescription] = useState(issue.description);
  const [draftPriority, setDraftPriority] = useState<OrchestrationIssuePriority>(
    issue.priority
  );
  const [draftCriteria, setDraftCriteria] = useState(
    issue.acceptanceCriteria.join("\n")
  );
  const [draftBlockedReason, setDraftBlockedReason] = useState(
    issue.blockedReason ?? ""
  );
  const previous = adjacentWorkflowColumn(issue.columnId, -1);
  const next = adjacentWorkflowColumn(issue.columnId, 1);
  useEffect(() => {
    if (editing) return;
    setDraftTitle(issue.title);
    setDraftDescription(issue.description);
    setDraftPriority(issue.priority);
    setDraftCriteria(issue.acceptanceCriteria.join("\n"));
    setDraftBlockedReason(issue.blockedReason ?? "");
  }, [editing, issue.acceptanceCriteria, issue.blockedReason, issue.description, issue.priority, issue.title]);

  if (editing) {
    return (
      <article className={cardClass}>
        <form
          className="space-y-[8px]"
          onSubmit={(event) => {
            event.preventDefault();
            const title = draftTitle.trim();
            if (!title) return;
            onUpdate({
              title,
              description: draftDescription.trim(),
              priority: draftPriority,
              acceptanceCriteria: draftCriteria
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
              blockedReason: draftBlockedReason.trim() || null,
            });
            setEditing(false);
          }}
        >
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <textarea
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            rows={3}
            placeholder="Description"
            className="w-full resize-none rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          />
          <select
            value={draftPriority}
            onChange={(event) =>
              setDraftPriority(event.target.value as OrchestrationIssuePriority)
            }
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            {["none", "low", "medium", "high", "urgent"].map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
          <textarea
            value={draftCriteria}
            onChange={(event) => setDraftCriteria(event.target.value)}
            rows={3}
            placeholder="Acceptance criteria, one per line"
            className="w-full resize-none rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          />
          <textarea
            value={draftBlockedReason}
            onChange={(event) => setDraftBlockedReason(event.target.value)}
            rows={2}
            placeholder="Blocked reason"
            className="w-full resize-none rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          />
          <div className="flex flex-wrap gap-[6px]">
            <button type="submit" className={smallButtonClass}>
              Save
            </button>
            <button
              type="button"
              className={smallButtonClass}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${smallButtonClass} text-[var(--error-text,var(--text-secondary))]`}
              onClick={() => {
                if (window.confirm(`Delete issue "${issue.title}"?`)) {
                  onDelete();
                }
              }}
            >
              Delete
            </button>
          </div>
        </form>
      </article>
    );
  }

  return (
    <article className={cardClass}>
      <div className="flex items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <h4 className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {issue.title}
          </h4>
          {issue.description ? (
            <p className="mt-[4px] line-clamp-3 font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
              {issue.description}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full border border-[var(--border-subtle)] px-[6px] py-[2px] font-sans text-[10px] text-[var(--text-disabled)]">
          {issue.priority}
        </span>
      </div>
      {issue.acceptanceCriteria.length > 0 ? (
        <ul className="mt-[8px] list-disc space-y-[3px] pl-[16px] font-sans text-[11px] leading-snug text-[var(--text-secondary)]">
          {issue.acceptanceCriteria.slice(0, 3).map((item, index) => (
            <li key={`${issue.id}-criteria-${index}`}>{item}</li>
          ))}
        </ul>
      ) : null}
      {issue.columnId === "blocked" ? (
        <div className="mt-[8px] rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--warning,#d8a028)_35%,var(--border-card))] bg-[color-mix(in_srgb,var(--warning,#d8a028)_8%,var(--bg-card))] px-[8px] py-[7px]">
          <p className="font-sans text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--warning,#b77b00)]">
            Why this is blocked
          </p>
          <p className="mt-[3px] whitespace-pre-wrap font-sans text-[11px] leading-snug text-[var(--text-secondary)]">
            {issue.blockedReason || "This issue needs a blocker explanation before work can resume."}
          </p>
        </div>
      ) : null}
      <div className="mt-[10px] flex flex-wrap items-center gap-[6px] font-sans text-[11px] text-[var(--text-disabled)]">
        <span>{agents} agent{agents === 1 ? "" : "s"}</span>
        <span>Verification: {issue.verification.status}</span>
      </div>
      <div className="mt-[10px] flex flex-wrap gap-[6px]">
        <button
          type="button"
          className={smallButtonClass}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        {previous ? (
          <button type="button" className={smallButtonClass} onClick={() => onMove(previous)}>
            Back to {previous.replace("_", " ")}
          </button>
        ) : null}
        {next ? (
          <button type="button" className={smallButtonClass} onClick={() => onMove(next)}>
            {issue.columnId === "blocked" ? "Resume work" : moveLabel(next)}
          </button>
        ) : null}
        {issue.columnId !== "blocked" && issue.columnId !== "done" ? (
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => {
              setBlockerExplanation("");
              setBlocking(true);
            }}
          >
            Block
          </button>
        ) : null}
      </div>
      {blocking ? (
        <form
          className="mt-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[8px]"
          onSubmit={(event) => {
            event.preventDefault();
            const explanation = blockerExplanation.trim();
            if (!explanation) return;
            onBlock(explanation);
            setBlocking(false);
            setBlockerExplanation("");
          }}
        >
          <label className="font-sans text-[11px] font-medium text-[var(--text-primary)]">
            What is blocking progress?
          </label>
          <textarea
            autoFocus
            value={blockerExplanation}
            onChange={(event) => setBlockerExplanation(event.target.value)}
            rows={2}
            placeholder="Describe the blocker and what is needed to resume"
            className="mt-[6px] w-full resize-none rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          />
          <div className="mt-[6px] flex gap-[6px]">
            <button type="submit" className={smallButtonClass}>
              Mark blocked
            </button>
            <button type="button" className={smallButtonClass} onClick={() => setBlocking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <form
        className="mt-[10px] flex gap-[6px]"
        onSubmit={(event) => {
          event.preventDefault();
          const message = comment.trim();
          if (!message) return;
          setComment("");
          onComment(message);
        }}
      >
        <input
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Comment or nudge..."
          className="min-w-0 flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
        />
        <button type="submit" className={smallButtonClass}>
          Send
        </button>
      </form>
    </article>
  );
}

export function KanbanBoardView({ boardId }: { boardId: string }) {
  const { activeWorkspaceId } = useWorkspace();
  const containerRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<OrchestrationBoardSnapshot | null>(null);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueDescription, setNewIssueDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [compactLayout, setCompactLayout] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setCompactLayout(container.clientWidth < 760);
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchOrchestrationBoardSnapshot(boardId)
      .then(({ snapshot: next }) => {
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load board.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const socket = new WebSocket(buildOrchestrationWebSocketUrl(activeWorkspaceId));
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", boardIds: [boardId] }));
    });
    socket.addEventListener("message", (event) => {
      let message: OrchestrationSocketServerMessage | null = null;
      try {
        message = JSON.parse(String(event.data)) as OrchestrationSocketServerMessage;
      } catch {
        return;
      }
      if (
        (message.type === "snapshot" || message.type === "board") &&
        message.boardId === boardId
      ) {
        setSnapshot(message.snapshot);
        setError(null);
      }
      if (message.type === "error" && (!message.boardId || message.boardId === boardId)) {
        setError(message.message);
      }
    });
    socket.addEventListener("error", () => {
      setError("Live board updates disconnected.");
    });
    return () => {
      socket.close();
    };
  }, [activeWorkspaceId, boardId]);

  const assignmentsByIssue = useMemo(() => {
    const counts = new Map<string, number>();
    for (const assignment of snapshot?.assignments ?? []) {
      counts.set(assignment.issueId, (counts.get(assignment.issueId) ?? 0) + 1);
    }
    return counts;
  }, [snapshot?.assignments]);

  const events = snapshot?.events.slice(-18).reverse() ?? [];

  if (loading && !snapshot) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-[var(--text-secondary)]">
        Loading orchestration board...
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
        {error ?? "Board unavailable."}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]">
      <header className="flex shrink-0 items-start justify-between gap-[16px] border-b border-[var(--border-subtle)] px-[18px] py-[14px]">
        <div className="min-w-0">
          <h2 className="truncate font-sans text-[18px] font-semibold text-[var(--text-primary)]">
            {snapshot.board.title}
          </h2>
          <p className="mt-[3px] font-sans text-[12px] text-[var(--text-secondary)]">
            {snapshot.issues.length} issues · {snapshot.assignments.length} agent assignments
          </p>
        </div>
        {error ? (
          <p className="max-w-[360px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--error-text,var(--text-primary))]">
            {error}
          </p>
        ) : null}
      </header>
      <div
        className={
          compactLayout
            ? "flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto p-[12px]"
            : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-[12px] overflow-hidden p-[12px]"
        }
      >
        <div
          className={`flex gap-[10px] overflow-x-auto pb-[8px] ${
            compactLayout ? "min-h-[420px] shrink-0 snap-x snap-mandatory" : "min-h-0"
          }`}
        >
          {ORCHESTRATION_COLUMNS.map((column) => {
            const issues = snapshot.issues.filter((issue) => issue.columnId === column.id);
            return (
              <section
                key={column.id}
                className="flex min-h-0 w-[270px] shrink-0 snap-start flex-col rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-panel)]"
              >
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-[10px] py-[8px]">
                  <h3 className="font-sans text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                    {column.label}
                  </h3>
                  <span className="font-mono text-[11px] text-[var(--text-disabled)]">
                    {issues.length}
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-[8px] overflow-y-auto p-[8px]">
                  {issues.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      agents={assignmentsByIssue.get(issue.id) ?? 0}
                      onMove={(columnId) => {
                        patchOrchestrationIssue(boardId, issue.id, { columnId })
                          .then(({ snapshot: next }) => setSnapshot(next))
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "Move failed.")
                          );
                      }}
                      onUpdate={(patch) => {
                        patchOrchestrationIssue(boardId, issue.id, patch)
                          .then(({ snapshot: next }) => setSnapshot(next))
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "Update failed.")
                          );
                      }}
                      onBlock={(blockerExplanation) => {
                        patchOrchestrationIssue(boardId, issue.id, {
                          columnId: "blocked",
                          blockerExplanation,
                        })
                          .then(({ snapshot: next }) => setSnapshot(next))
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "Could not block issue.")
                          );
                      }}
                      onDelete={() => {
                        deleteOrchestrationIssue(boardId, issue.id)
                          .then(({ snapshot: next }) => setSnapshot(next))
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "Delete failed.")
                          );
                      }}
                      onComment={(message) => {
                        addOrchestrationIssueComment(boardId, issue.id, message)
                          .then(({ snapshot: next }) => setSnapshot(next))
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : "Comment failed.")
                          );
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <aside
          className={`flex flex-col gap-[12px] ${
            compactLayout ? "min-h-[460px] shrink-0" : "min-h-0 overflow-hidden"
          }`}
        >
          <form
            className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[10px]"
            onSubmit={(event) => {
              event.preventDefault();
              const title = newIssueTitle.trim();
              if (!title) return;
              createOrchestrationIssue(boardId, {
                title,
                description: newIssueDescription.trim(),
              })
                .then(({ snapshot: next }) => {
                  setSnapshot(next);
                  setNewIssueTitle("");
                  setNewIssueDescription("");
                })
                .catch((err) =>
                  setError(err instanceof Error ? err.message : "Issue creation failed.")
                );
            }}
          >
            <h3 className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
              Add issue
            </h3>
            <input
              value={newIssueTitle}
              onChange={(event) => setNewIssueTitle(event.target.value)}
              placeholder="Title"
              className="mt-[8px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[9px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
            />
            <textarea
              value={newIssueDescription}
              onChange={(event) => setNewIssueDescription(event.target.value)}
              placeholder="Description"
              rows={4}
              className="mt-[8px] w-full resize-none rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[9px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              className="mt-[8px] w-full rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[6px] font-sans text-[12px] font-medium text-[var(--bg-main)]"
            >
              Create issue
            </button>
          </form>
          <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
            <div className="border-b border-[var(--border-subtle)] px-[10px] py-[8px] font-sans text-[13px] font-medium text-[var(--text-primary)]">
              Activity
            </div>
            <div className="h-full overflow-y-auto p-[10px]">
              {events.length === 0 ? (
                <p className="font-sans text-[12px] text-[var(--text-disabled)]">
                  No board activity yet.
                </p>
              ) : (
                <div className="space-y-[8px]">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[9px] py-[7px]"
                    >
                      <p className="font-sans text-[12px] leading-snug text-[var(--text-primary)]">
                        {event.message}
                      </p>
                      <p className="mt-[3px] font-mono text-[10px] text-[var(--text-disabled)]">
                        {event.kind} · {formatTime(event.createdAt)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
