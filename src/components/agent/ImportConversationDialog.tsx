"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  AgentBackendId,
  AgentImportResult,
  AgentImportSessionSummary,
  AgentImportSourceInfo,
} from "@/lib/agent-types";
import {
  importAgentHarnessSession,
  listAgentImportSessions,
  listAgentImportSources,
} from "@/lib/server-api";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";

type ImportConversationDialogProps = {
  open: boolean;
  onClose: () => void;
  onImported: (result: AgentImportResult) => void;
  /** Open a session that is already imported — it stays in sync automatically. */
  onOpenExisting: (conversationId: string, title: string) => void;
};

function formatRelativeTime(epochMs: number | null): string {
  if (!epochMs) {
    return "";
  }
  const delta = Date.now() - epochMs;
  if (delta < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Date(epochMs).toLocaleDateString();
}

export function ImportConversationDialog({
  open,
  onClose,
  onImported,
  onOpenExisting,
}: ImportConversationDialogProps) {
  const [sources, setSources] = useState<AgentImportSourceInfo[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [selectedBackendId, setSelectedBackendId] = useState<AgentBackendId | null>(null);
  const [sessions, setSessions] = useState<AgentImportSessionSummary[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSources(null);
    setSourcesError(null);
    setSelectedBackendId(null);
    setSessions(null);
    setQuery("");
    setImportError(null);
    let cancelled = false;
    listAgentImportSources()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setSources(result.sources);
        const firstAvailable =
          result.sources.find((source) => source.available && source.sessionCount > 0) ??
          result.sources.find((source) => source.available) ??
          null;
        if (firstAvailable) {
          setSelectedBackendId(firstAvailable.backendId);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSourcesError(error instanceof Error ? error.message : "Failed to load import sources.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const loadSessions = useCallback(async (backendId: AgentBackendId) => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const result = await listAgentImportSessions(backendId);
      setSessions(result.sessions);
    } catch (error) {
      setSessions([]);
      setSessionsError(error instanceof Error ? error.message : "Failed to list sessions.");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedBackendId) {
      return;
    }
    setSessions(null);
    void loadSessions(selectedBackendId);
  }, [open, selectedBackendId, loadSessions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  const filteredSessions = useMemo(() => {
    if (!sessions) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return sessions;
    }
    return sessions.filter((session) =>
      [session.title, session.cwd ?? "", session.preview ?? "", session.id]
        .join("\n")
        .toLowerCase()
        .includes(needle)
    );
  }, [sessions, query]);

  const selectedSource = useMemo(
    () => sources?.find((source) => source.backendId === selectedBackendId) ?? null,
    [sources, selectedBackendId]
  );

  const handleImport = useCallback(
    async (session: AgentImportSessionSummary) => {
      if (!selectedBackendId || importingSessionId) {
        return;
      }
      setImportingSessionId(session.id);
      setImportError(null);
      try {
        const result = await importAgentHarnessSession(selectedBackendId, session.id);
        onImported(result);
        onClose();
      } catch (error) {
        setImportError(error instanceof Error ? error.message : "Import failed.");
      } finally {
        setImportingSessionId(null);
      }
    },
    [selectedBackendId, importingSessionId, onImported, onClose]
  );

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[10050] flex items-start justify-center px-4 pt-[8vh]" role="presentation">
      <div
        className="absolute inset-0 bg-[var(--palette-backdrop)]"
        aria-hidden
        onPointerDown={(event) => {
          event.preventDefault();
          if (!importingSessionId) {
            onClose();
          }
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Import conversation"
        className="relative flex h-[min(560px,80vh)] w-[min(860px,94vw)] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-2xl"
      >
        <div className="flex items-center justify-between gap-[8px] border-b border-[var(--palette-divider)] px-[14px] py-[10px]">
          <div className="flex min-w-0 flex-col gap-[2px]">
            <h2 className="font-sans text-[14px] font-semibold text-[var(--text-primary)]">
              Import conversation
            </h2>
            <p className="font-sans text-[12px] text-[var(--text-secondary)]">
              Migrate a session from another agent harness. The native session is preserved
              verbatim, keeps resuming in its original harness, and stays in sync automatically.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <X className="size-[14px]" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[240px] shrink-0 flex-col gap-[2px] overflow-y-auto border-r border-[var(--palette-divider)] p-[8px]">
            {sources === null && !sourcesError ? (
              <div className="flex items-center gap-[6px] px-[6px] py-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
                <Loader2 className="size-[13px] animate-spin" strokeWidth={1.8} />
                Scanning harnesses…
              </div>
            ) : null}
            {sourcesError ? (
              <div className="px-[6px] py-[8px] font-sans text-[12px] text-[var(--status-error)]">
                {sourcesError}
              </div>
            ) : null}
            {sources?.map((source) => {
              const active = source.backendId === selectedBackendId;
              const disabled = !source.available;
              return (
                <button
                  key={source.backendId}
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelectedBackendId(source.backendId)}
                  title={source.reason ?? source.label}
                  className={`flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left transition-colors ${
                    active
                      ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--accent-bg)_60%,transparent)] hover:text-[var(--text-primary)]"
                  } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <AgentBackendIcon backendId={source.backendId} className="size-[15px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px]">
                    {source.label}
                  </span>
                  {source.available ? (
                    <span className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--accent-bg)] px-[6px] py-[1px] font-sans text-[11px] text-[var(--text-secondary)]">
                      {source.sessionCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {sources?.every((source) => !source.available) ? (
              <p className="px-[6px] py-[8px] font-sans text-[12px] leading-relaxed text-[var(--text-secondary)]">
                No harness session storage detected on this machine yet. Create a conversation
                with Claude Code, Codex, OpenCode, Gemini CLI, or Pi first, then re-open this
                dialog.
              </p>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-[8px] border-b border-[var(--palette-divider)] px-[12px] py-[8px]">
              {selectedBackendId ? (
                <button
                  type="button"
                  aria-label="Reload sessions"
                  title="Reload sessions"
                  onClick={() => void loadSessions(selectedBackendId)}
                  className="flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                >
                  <RefreshCw className="size-[13px]" strokeWidth={1.8} />
                </button>
              ) : (
                <ArrowLeft className="size-[13px] text-transparent" strokeWidth={1.8} />
              )}
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-[8px] top-1/2 size-[13px] -translate-y-1/2 text-[var(--text-disabled)]" strokeWidth={1.8} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    selectedSource ? `Search ${selectedSource.label} sessions…` : "Search sessions…"
                  }
                  className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] py-[5px] pl-[26px] pr-[8px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-[8px]">
              {sessionsLoading ? (
                <div className="flex items-center gap-[6px] px-[6px] py-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={1.8} />
                  Reading sessions…
                </div>
              ) : null}
              {sessionsError ? (
                <div className="px-[6px] py-[8px] font-sans text-[12px] text-[var(--status-error)]">
                  {sessionsError}
                </div>
              ) : null}
              {!sessionsLoading && !sessionsError && filteredSessions.length === 0 ? (
                <div className="px-[6px] py-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
                  {selectedSource?.available
                    ? "No sessions found for this harness."
                    : (selectedSource?.reason ?? "Select an available harness on the left.")}
                </div>
              ) : null}
              {filteredSessions.map((session) => {
                const alreadyImported = Boolean(session.importedConversationId);
                const busy = importingSessionId === session.id;
                return (
                  <div
                    key={session.id}
                    className="group flex w-full items-center gap-[10px] rounded-[var(--radius-tab)] px-[8px] py-[7px] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-bg)_60%,transparent)]"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-[1px]">
                      <span className="truncate font-sans text-[13px] text-[var(--text-primary)]">
                        {session.title}
                      </span>
                      <span className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
                        {[
                          session.cwd,
                          formatRelativeTime(session.updatedAt),
                          `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
                          session.id,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {alreadyImported ? (
                      <button
                        type="button"
                        disabled={importingSessionId !== null}
                        onClick={() => {
                          onOpenExisting(session.importedConversationId!, session.title);
                          onClose();
                        }}
                        title="Already imported — stays in sync with the harness automatically"
                        className="flex shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] bg-[color-mix(in_srgb,var(--accent-bg)_60%,transparent)] px-[10px] py-[4px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Check className="size-[12px]" strokeWidth={2} />
                        Open
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || importingSessionId !== null}
                        onClick={() => void handleImport(session)}
                        className="flex shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] bg-[var(--accent-bg)] px-[10px] py-[4px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="size-[12px] animate-spin" strokeWidth={1.8} />
                        ) : (
                          <Download className="size-[12px]" strokeWidth={1.8} />
                        )}
                        Import
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {importError ? (
              <div className="border-t border-[var(--palette-divider)] px-[12px] py-[8px] font-sans text-[12px] text-[var(--status-error)]">
                {importError}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
