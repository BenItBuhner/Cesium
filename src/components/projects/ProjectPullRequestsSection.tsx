"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, GitMerge, GitPullRequest, Images, LoaderCircle, RefreshCw } from "lucide-react";
import {
  projectPullRequestCiBadge,
  projectPullRequestMergeBlocker,
  projectPullRequestReviewBadge,
  projectPullRequestStateBadge,
  projectRelativeTime,
  type ProjectBadge,
  type ProjectPullRequestListing,
  type ProjectSnapshot,
} from "@cesium/core";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import {
  listProjectPullRequests,
  mergeProjectPullRequest,
  refreshProjectPullRequests,
} from "@/lib/server-api";
import {
  projectButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectHintTextClass,
  projectPrimaryButtonClass,
  projectSectionLabelClass,
} from "./project-ui";
import { useProjects } from "./ProjectsProvider";

const POLL_MS = 15_000;

const BADGE_TONE: Record<ProjectBadge["tone"], string> = {
  neutral: "bg-[var(--bg-card)] text-[var(--text-secondary)]",
  accent: "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]",
  success: "bg-[color-mix(in_srgb,var(--status-success)_16%,transparent)] text-[var(--status-success)]",
  warning: "bg-[color-mix(in_srgb,var(--status-warning)_18%,transparent)] text-[var(--status-warning)]",
  error: "bg-[color-mix(in_srgb,var(--status-error)_16%,transparent)] text-[var(--status-error)]",
};

export function ProjectBadgePill({ badge }: { badge: ProjectBadge }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-[4px] px-[5px] py-[0.5px] font-sans text-[10.5px] leading-[15px] ${BADGE_TONE[badge.tone]}`}>
      {badge.label}
    </span>
  );
}

/** Every pull request the Project tracks: its agents' own and the ones it was told to follow. */
export function ProjectPullRequestsSection({ snapshot }: { snapshot: ProjectSnapshot }) {
  const dialogs = useWorkbenchDialogs();
  const { openContextFile, refreshProject } = useProjects();
  const [prs, setPrs] = useState<ProjectPullRequestListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const requestRef = useRef(0);
  const projectId = snapshot.id;

  const load = useCallback(
    async (fresh: boolean) => {
      const request = ++requestRef.current;
      try {
        const listed = fresh ? await refreshProjectPullRequests(projectId) : await listProjectPullRequests(projectId);
        if (request === requestRef.current) {
          setPrs(listed);
          setError(null);
        }
      } catch (caught) {
        if (request === requestRef.current) {
          setError(projectErrorMessage(caught));
        }
      }
    },
    [projectId]
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load(false);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  const merge = async (pr: ProjectPullRequestListing) => {
    const ref = `${pr.repo}#${pr.number}`;
    const confirmed = await dialogs.confirm({
      title: `Merge ${ref}?`,
      message: `Squash-merges it into ${pr.baseRef} as "${pr.title} (#${pr.number})". The branch is kept.`,
      confirmLabel: "Merge",
    });
    if (!confirmed) {
      return;
    }
    setMerging(ref);
    setError(null);
    try {
      await mergeProjectPullRequest(projectId, ref);
      await Promise.all([load(false), refreshProject(projectId)]);
    } catch (caught) {
      setError(projectErrorMessage(caught));
    } finally {
      setMerging(null);
    }
  };

  const now = Date.now();
  const open = (prs ?? []).filter((pr) => pr.state === "open");
  const done = (prs ?? []).filter((pr) => pr.state !== "open");

  return (
    <div className="flex flex-col gap-[10px] px-[16px] py-[12px]">
      <div className="flex items-center gap-[10px]">
        <span className={`${projectSectionLabelClass} flex-1`}>Pull requests</span>
        <button type="button" onClick={() => void refresh()} disabled={refreshing} className={projectButtonClass}>
          <RefreshCw className={`size-[12px] ${refreshing ? "animate-spin" : ""}`} strokeWidth={1.7} aria-hidden />
          Check now
        </button>
      </div>
      <p className={projectHintTextClass}>
        {snapshot.settings.mergePolicy === "when_green"
          ? "The coordinator merges green pull requests on its own."
          : "The coordinator merges only when you tell it to."}{" "}
        Merging here squashes as “title (#N)” and keeps the branch.
      </p>
      {error ? <p className={projectErrorTextClass}>{error}</p> : null}
      {prs == null ? (
        !error ? (
          <p className={`${projectHintTextClass} inline-flex items-center gap-[6px]`}>
            <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
            Loading…
          </p>
        ) : null
      ) : prs.length === 0 ? (
        <p className={`${projectHintTextClass} py-[8px]`}>
          No pull requests yet. Agents working in a repository push their branch and open one when they
          finish; the Project follows it and its CI from then on.
        </p>
      ) : (
        <>
          <PullRequestList prs={open} now={now} merging={merging} onMerge={merge} onEvidence={(agent) => openContextFile(`media/${agent}`)} />
          {done.length > 0 ? (
            <>
              <span className={`${projectSectionLabelClass} pt-[6px]`}>Merged and closed</span>
              <PullRequestList prs={done} now={now} merging={merging} onMerge={merge} onEvidence={(agent) => openContextFile(`media/${agent}`)} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function PullRequestList({
  prs,
  now,
  merging,
  onMerge,
  onEvidence,
}: {
  prs: ProjectPullRequestListing[];
  now: number;
  merging: string | null;
  onMerge: (pr: ProjectPullRequestListing) => void;
  onEvidence: (agent: string) => void;
}) {
  if (prs.length === 0) {
    return <p className={projectHintTextClass}>None open.</p>;
  }
  return (
    <ul className="flex flex-col gap-[8px]" data-testid="project-pr-list">
      {prs.map((pr) => {
        const ref = `${pr.repo}#${pr.number}`;
        const blocker = projectPullRequestMergeBlocker(pr);
        const ci = projectPullRequestCiBadge(pr);
        const review = projectPullRequestReviewBadge(pr);
        return (
          <li
            key={ref}
            className="flex flex-col gap-[6px] rounded-[var(--agent-card-radius)] border border-[var(--agent-border)] bg-[var(--agent-card-bg)] px-[10px] py-[8px]"
          >
            <div className="flex min-w-0 items-start gap-[8px]">
              <GitPullRequest className="mt-[2px] size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.7} aria-hidden />
              <div className="min-w-0 flex-1">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-sans text-[13px] font-medium text-[var(--text-primary)] hover:underline"
                  title={pr.title}
                >
                  {pr.title}
                </a>
                <p className="truncate font-sans text-[11.5px] text-[var(--text-secondary)]">
                  {ref}
                  {pr.agent ? ` · ${pr.agent}` : ""} · {pr.headRef} → {pr.baseRef} · updated{" "}
                  {projectRelativeTime(pr.updatedAt, now)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-[5px]">
              <ProjectBadgePill badge={projectPullRequestStateBadge(pr)} />
              {ci ? <ProjectBadgePill badge={ci} /> : null}
              {review ? <ProjectBadgePill badge={review} /> : null}
              {pr.openedByProject ? <ProjectBadgePill badge={{ label: "Opened by the Project", tone: "neutral" }} /> : null}
              <span className="flex-1" />
              {pr.agent ? (
                <button type="button" onClick={() => onEvidence(pr.agent!)} className={projectButtonClass} title={`Screenshots and recordings from ${pr.agent}`}>
                  <Images className="size-[12px]" strokeWidth={1.7} aria-hidden />
                  Evidence
                </button>
              ) : null}
              <a href={pr.url} target="_blank" rel="noreferrer" className={projectButtonClass}>
                <ExternalLink className="size-[12px]" strokeWidth={1.7} aria-hidden />
                GitHub
              </a>
              {pr.state === "open" ? (
                <button
                  type="button"
                  onClick={() => onMerge(pr)}
                  disabled={blocker != null || merging != null}
                  className={projectPrimaryButtonClass}
                  title={blocker ?? `Squash-merge ${ref}`}
                >
                  {merging === ref ? (
                    <LoaderCircle className="size-[12px] animate-spin" aria-hidden />
                  ) : (
                    <GitMerge className="size-[12px]" strokeWidth={1.8} aria-hidden />
                  )}
                  Merge
                </button>
              ) : null}
            </div>
            {pr.state === "open" && blocker ? (
              <p className={projectHintTextClass}>Can&apos;t merge yet: {blocker.toLowerCase()}.</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
