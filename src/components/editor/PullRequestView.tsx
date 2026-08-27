"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { fetchWorkspacePullRequestReview } from "@/lib/server-api";
import type {
  PullRequestReview,
  PullRequestReviewCommit,
  PullRequestReviewFile,
} from "@/lib/types";
import { SimpleMarkdownPreview } from "./SimpleMarkdownPreview";

type SectionId = "overview" | "commits" | "files";

function relativeTime(epochMs: number): string {
  if (!epochMs) {
    return "";
  }
  const deltaSeconds = Math.round((Date.now() - epochMs) / 1000);
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function stateChip(review: PullRequestReview): {
  label: string;
  Icon: typeof GitPullRequest;
  className: string;
} {
  const github = review.github;
  if (github.available) {
    if (github.state === "MERGED") {
      return {
        label: "Merged",
        Icon: GitMerge,
        className: "bg-[#8957e5]/15 text-[#a371f7] border-[#8957e5]/40",
      };
    }
    if (github.state === "CLOSED") {
      return {
        label: "Closed",
        Icon: GitPullRequestClosed,
        className: "bg-[#f85149]/10 text-[#f85149] border-[#f85149]/40",
      };
    }
    if (github.isDraft) {
      return {
        label: "Draft",
        Icon: GitPullRequestDraft,
        className:
          "bg-[color-mix(in_srgb,var(--text-secondary)_12%,transparent)] text-[var(--text-secondary)] border-[var(--border-card)]",
      };
    }
    return {
      label: "Open",
      Icon: GitPullRequest,
      className: "bg-[#3fb950]/10 text-[#3fb950] border-[#3fb950]/40",
    };
  }
  return {
    label: "Local branch",
    Icon: GitBranch,
    className:
      "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
  };
}

function fileStatusBadge(file: PullRequestReviewFile): { label: string; className: string } {
  switch (file.status) {
    case "added":
      return { label: "A", className: "text-[#3fb950]" };
    case "deleted":
      return { label: "D", className: "text-[#f85149]" };
    case "renamed":
      return { label: "R", className: "text-[#a371f7]" };
    case "copied":
      return { label: "C", className: "text-[#a371f7]" };
    case "modified":
      return { label: "M", className: "text-[#d29922]" };
    default:
      return { label: "?", className: "text-[var(--text-secondary)]" };
  }
}

type DiffRow = {
  kind: "hunk" | "add" | "del" | "context" | "meta";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

/** Turns raw unified diff text into displayable rows with old/new line numbers. */
function parsePatchRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = Number.parseInt(match[1] ?? "1", 10);
        newLine = Number.parseInt(match[2] ?? "1", 10);
      }
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("copy from") ||
      line.startsWith("copy to") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldLine: null, newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine, newLine: null, text: line.slice(1) });
      oldLine += 1;
      continue;
    }
    rows.push({ kind: "context", oldLine, newLine, text: line.startsWith(" ") ? line.slice(1) : line });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

function DiffRowLine({ row }: { row: DiffRow }) {
  if (row.kind === "hunk") {
    return (
      <div className="flex bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] font-mono text-[11px] leading-[19px] text-[var(--accent)]">
        <span className="w-[84px] shrink-0" />
        <span className="whitespace-pre px-[10px]">{row.text}</span>
      </div>
    );
  }
  const rowBg =
    row.kind === "add"
      ? "bg-[#3fb950]/10"
      : row.kind === "del"
        ? "bg-[#f85149]/10"
        : "";
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  const markerColor =
    row.kind === "add"
      ? "text-[#3fb950]"
      : row.kind === "del"
        ? "text-[#f85149]"
        : "text-transparent";
  return (
    <div className={`flex font-mono text-[11px] leading-[19px] ${rowBg}`}>
      <span className="w-[38px] shrink-0 select-none pr-[6px] text-right text-[var(--text-disabled)]">
        {row.oldLine ?? ""}
      </span>
      <span className="w-[38px] shrink-0 select-none pr-[6px] text-right text-[var(--text-disabled)]">
        {row.newLine ?? ""}
      </span>
      <span className={`w-[8px] shrink-0 select-none ${markerColor}`}>{marker}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-[10px] text-[var(--text-primary)]">
        {row.text}
      </span>
    </div>
  );
}

function FileDiffCard({
  file,
  defaultExpanded,
}: {
  file: PullRequestReviewFile;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const badge = fileStatusBadge(file);
  const rows = useMemo(
    () => (expanded && file.patch ? parsePatchRows(file.patch) : []),
    [expanded, file.patch]
  );
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-[8px] px-[10px] py-[7px] text-left transition-colors hover:bg-[var(--accent-bg)]"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
        ) : (
          <ChevronRight className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
        )}
        <span className={`w-[12px] shrink-0 text-center font-mono text-[11px] font-semibold ${badge.className}`}>
          {badge.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]">
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {file.binary ? (
            <span className="text-[var(--text-disabled)]">binary</span>
          ) : (
            <>
              <span className="text-[#3fb950]">+{file.additions}</span>{" "}
              <span className="text-[#f85149]">−{file.deletions}</span>
            </>
          )}
        </span>
      </button>
      {expanded ? (
        file.patch ? (
          <div className="overflow-x-auto border-t border-[var(--border-subtle)] py-[4px]">
            {rows.map((row, index) => (
              <DiffRowLine key={index} row={row} />
            ))}
            {file.patchTruncated ? (
              <div className="px-[10px] py-[6px] font-sans text-[11px] italic text-[var(--text-disabled)]">
                Diff truncated - open the file to see the full change.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="border-t border-[var(--border-subtle)] px-[10px] py-[8px] font-sans text-[11px] italic text-[var(--text-disabled)]">
            {file.binary ? "Binary file not rendered." : "Diff too large to display."}
          </div>
        )
      ) : null}
    </div>
  );
}

function CommitRow({ commit }: { commit: PullRequestReviewCommit }) {
  const [showBody, setShowBody] = useState(false);
  return (
    <div className="flex items-start gap-[10px] border-b border-[var(--border-subtle)] px-[12px] py-[8px] last:border-b-0">
      <GitCommitHorizontal
        className="mt-[2px] size-[14px] shrink-0 text-[var(--text-secondary)]"
        strokeWidth={1.6}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => commit.body && setShowBody((current) => !current)}
          className={`block max-w-full truncate text-left font-sans text-[12.5px] text-[var(--text-primary)] ${commit.body ? "cursor-pointer hover:underline" : "cursor-default"}`}
          title={commit.subject}
        >
          {commit.subject}
        </button>
        {showBody && commit.body ? (
          <pre className="mt-[6px] whitespace-pre-wrap rounded-[6px] bg-[var(--accent-bg)] p-[8px] font-mono text-[11px] leading-[16px] text-[var(--text-secondary)]">
            {commit.body}
          </pre>
        ) : null}
        <div className="mt-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
          {commit.authorName} · {relativeTime(commit.authoredAt)}
        </div>
      </div>
      <code className="shrink-0 rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[2px] font-mono text-[11px] text-[var(--text-secondary)]">
        {commit.shortSha}
      </code>
    </div>
  );
}

export function PullRequestView({ initialBaseRef }: { initialBaseRef?: string }) {
  const { activeWorkspaceId } = useWorkspace();
  const [review, setReview] = useState<PullRequestReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState<string | undefined>(initialBaseRef);
  const [section, setSection] = useState<SectionId>("overview");

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      if (!activeWorkspaceId) {
        setLoading(false);
        setLoadError("No active workspace.");
        return;
      }
      if (options?.background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setLoadError(null);
      try {
        const { review: next } = await fetchWorkspacePullRequestReview(activeWorkspaceId, {
          baseRef,
        });
        setReview(next);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load pull request data.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [activeWorkspaceId, baseRef]
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !review) {
    return (
      <div className="flex h-full items-center justify-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
        <LoaderCircle className="size-[16px] animate-spin" strokeWidth={1.6} aria-hidden />
        Building pull request review…
      </div>
    );
  }

  if (loadError && !review) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[10px] px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        <p>{loadError}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!review) {
    return null;
  }

  if (!review.isGitRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[8px] px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        <GitPullRequest className="size-[22px] text-[var(--text-disabled)]" strokeWidth={1.5} aria-hidden />
        <p>This workspace is not a git repository, so there is nothing to review.</p>
      </div>
    );
  }

  const chip = stateChip(review);
  const github = review.github;
  const title =
    (github.available && github.title) ||
    review.headBranch ||
    (review.detached ? "Detached HEAD" : "Pull Request");
  const baseLabel = (github.available && github.baseRefName) || review.baseBranch || "\u2014";
  const headLabel =
    (github.available && github.headRefName) || review.headBranch || review.headSha?.slice(0, 7) || "\u2014";
  const comments = github.comments ?? [];

  const sections: Array<{ id: SectionId; label: string; count?: number }> = [
    { id: "overview", label: "Overview" },
    { id: "commits", label: "Commits", count: review.commits.length },
    { id: "files", label: "Files changed", count: review.totals.files },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-[16px] pb-0 pt-[14px]">
        <div className="flex items-start justify-between gap-[12px]">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-[8px]">
              <h1 className="min-w-0 truncate font-sans text-[16px] font-semibold text-[var(--text-primary)]">
                {title}
              </h1>
              {github.available && github.number != null ? (
                <span className="shrink-0 font-sans text-[14px] text-[var(--text-disabled)]">
                  #{github.number}
                </span>
              ) : null}
            </div>
            <div className="mt-[6px] flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[6px] font-sans text-[11.5px] text-[var(--text-secondary)]">
              <span
                className={`inline-flex shrink-0 items-center gap-[5px] rounded-full border px-[8px] py-[2px] text-[11px] font-medium ${chip.className}`}
              >
                <chip.Icon className="size-[12px]" strokeWidth={1.8} aria-hidden />
                {chip.label}
              </span>
              <span className="flex min-w-0 items-center gap-[5px]">
                <code className="truncate rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[2px] font-mono text-[11px]">
                  {baseLabel}
                </code>
                <span aria-hidden>←</span>
                <code className="truncate rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[2px] font-mono text-[11px]">
                  {headLabel}
                </code>
              </span>
              {github.available && github.author ? <span>by {github.author}</span> : null}
              {review.aheadOfBase > 0 || review.behindBase > 0 ? (
                <span className="tabular-nums">
                  {review.aheadOfBase} ahead
                  {review.behindBase > 0 ? `, ${review.behindBase} behind` : ""}
                </span>
              ) : null}
              <span className="tabular-nums">
                <span className="text-[#3fb950]">+{review.totals.additions}</span>{" "}
                <span className="text-[#f85149]">−{review.totals.deletions}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[6px]">
            {review.candidateBases.length > 1 ? (
              <select
                value={baseRef ?? review.baseBranch ?? ""}
                onChange={(event) => setBaseRef(event.target.value)}
                aria-label="Comparison base branch"
                className="h-[26px] rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[6px] font-sans text-[11px] text-[var(--text-secondary)] outline-none"
              >
                {review.candidateBases.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            ) : null}
            {github.available && github.url ? (
              <a
                href={github.url}
                target="_blank"
                rel="noreferrer"
                title="Open on GitHub"
                className="flex h-[26px] items-center gap-[5px] rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              >
                <ExternalLink className="size-[12px]" strokeWidth={1.7} aria-hidden />
                GitHub
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => void load({ background: true })}
              title="Refresh"
              aria-label="Refresh pull request data"
              className="flex size-[26px] items-center justify-center rounded-[6px] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw
                className={`size-[13px] ${refreshing ? "animate-spin" : ""}`}
                strokeWidth={1.7}
                aria-hidden
              />
            </button>
          </div>
        </div>

        {/* Section tabs */}
        <div className="mt-[10px] flex items-center gap-[4px]">
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-[6px] rounded-t-[6px] border-b-[2px] px-[10px] py-[6px] font-sans text-[12px] transition-colors ${
                section === item.id
                  ? "border-[var(--accent)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {item.label}
              {item.count != null ? (
                <span className="rounded-full bg-[var(--accent-bg)] px-[6px] py-[1px] text-[10.5px] tabular-nums text-[var(--text-secondary)]">
                  {item.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[16px] py-[14px]">
        {section === "overview" ? (
          <div className="mx-auto flex max-w-[860px] flex-col gap-[14px]">
            {review.uncommitted.dirty ? (
              <div className="flex items-center gap-[8px] rounded-[var(--radius-card)] border border-[#d29922]/40 bg-[#d29922]/10 px-[12px] py-[8px] font-sans text-[12px] text-[#d29922]">
                <CircleDot className="size-[13px] shrink-0" strokeWidth={1.8} aria-hidden />
                {review.uncommitted.files} uncommitted{" "}
                {review.uncommitted.files === 1 ? "file" : "files"} (
                <span className="tabular-nums">+{review.uncommitted.additions}</span>,{" "}
                <span className="tabular-nums">−{review.uncommitted.deletions}</span>) not included
                in this review.
              </div>
            ) : null}
            {!github.available && github.reason ? (
              <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[8px] font-sans text-[11.5px] text-[var(--text-disabled)]">
                GitHub metadata unavailable: {github.reason}
              </div>
            ) : null}
            {review.error ? (
              <div className="rounded-[var(--radius-card)] border border-[#f85149]/40 bg-[#f85149]/10 px-[12px] py-[8px] font-sans text-[12px] text-[#f85149]">
                {review.error}
              </div>
            ) : null}
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[12px]">
              <div className="mb-[8px] font-sans text-[12px] font-semibold text-[var(--text-primary)]">
                Description
              </div>
              {github.available && github.body?.trim() ? (
                <SimpleMarkdownPreview source={github.body} />
              ) : (
                <p className="font-sans text-[12px] italic text-[var(--text-disabled)]">
                  {github.available
                    ? "This pull request has no description."
                    : "No GitHub pull request found for this branch - showing the local branch review."}
                </p>
              )}
            </div>
            {review.commits.length > 0 ? (
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
                <div className="border-b border-[var(--border-subtle)] px-[12px] py-[8px] font-sans text-[12px] font-semibold text-[var(--text-primary)]">
                  Latest commits
                </div>
                {review.commits.slice(0, 5).map((commit) => (
                  <CommitRow key={commit.sha} commit={commit} />
                ))}
              </div>
            ) : (
              <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
                No commits ahead of {review.baseBranch ?? "the base branch"}.
              </div>
            )}
            {comments.length > 0 ? (
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
                <div className="flex items-center gap-[6px] border-b border-[var(--border-subtle)] px-[12px] py-[8px] font-sans text-[12px] font-semibold text-[var(--text-primary)]">
                  <MessageSquare className="size-[13px]" strokeWidth={1.7} aria-hidden />
                  Comments ({comments.length})
                </div>
                {comments.map((comment, index) => (
                  <div
                    key={index}
                    className="border-b border-[var(--border-subtle)] px-[12px] py-[9px] last:border-b-0"
                  >
                    <div className="mb-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
                      <span className="font-medium text-[var(--text-primary)]">{comment.author}</span>{" "}
                      · {relativeTime(comment.createdAt)}
                    </div>
                    <div className="whitespace-pre-wrap font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
                      {comment.body}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {section === "commits" ? (
          <div className="mx-auto max-w-[860px]">
            {review.commits.length === 0 ? (
              <p className="py-[24px] text-center font-sans text-[12.5px] text-[var(--text-secondary)]">
                No commits ahead of {review.baseBranch ?? "the base branch"}.
              </p>
            ) : (
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
                {review.commits.map((commit) => (
                  <CommitRow key={commit.sha} commit={commit} />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {section === "files" ? (
          <div className="mx-auto flex max-w-[980px] flex-col gap-[8px]">
            {review.files.length === 0 ? (
              <p className="py-[24px] text-center font-sans text-[12.5px] text-[var(--text-secondary)]">
                <FileDiff className="mx-auto mb-[6px] size-[18px] text-[var(--text-disabled)]" strokeWidth={1.5} aria-hidden />
                No file changes between {review.baseBranch ?? "base"} and{" "}
                {review.headBranch ?? "HEAD"}.
              </p>
            ) : (
              review.files.map((file) => (
                <FileDiffCard
                  key={`${file.path}:${file.previousPath ?? ""}`}
                  file={file}
                  defaultExpanded={review.files.length <= 8}
                />
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
