"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, LoaderCircle, Network, Pencil, Trash2 } from "lucide-react";
import {
  PROJECT_PAGE_TABS,
  projectChildBucket,
  projectChildBucketLabel,
  projectSummaryStatusLine,
  type ProjectPageTab,
  type ProjectSnapshot,
} from "@cesium/core";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { deleteProject, patchProject } from "@/lib/server-api";
import { ProjectAgentsSection } from "./ProjectAgentsSection";
import { ProjectContextSection } from "./ProjectContextSection";
import { ProjectPullRequestsSection } from "./ProjectPullRequestsSection";
import { ProjectSetupSection } from "./ProjectSetupSection";
import {
  ProjectStatusDot,
  projectButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectIconButtonClass,
} from "./project-ui";
import { useProjects, useProjectSnapshot } from "./ProjectsProvider";

const TAB_LABELS: Record<ProjectPageTab, string> = {
  agents: "Agents",
  prs: "Pull requests",
  context: "Context",
  setup: "Setup",
};

/** The Project page's side pane: the Project's agents, pull requests, Context and setup. */
export function ProjectSidePane({ projectId }: { projectId: string }) {
  const snapshot = useProjectSnapshot(projectId);
  const { refreshProject } = useProjects();
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setFailed(!(await refreshProject(projectId)));
  }, [projectId, refreshProject]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!snapshot) {
    return failed ? (
      <div className="flex h-full flex-col items-center justify-center gap-[10px] px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        <p>This Project could not be loaded from its engine.</p>
        <button type="button" onClick={() => void load()} className={projectButtonClass}>
          Retry
        </button>
      </div>
    ) : (
      <div className="flex h-full items-center justify-center gap-[8px] font-sans text-[13px] text-[var(--text-secondary)]">
        <LoaderCircle className="size-[16px] animate-spin" strokeWidth={1.6} aria-hidden />
        Loading Project…
      </div>
    );
  }
  return <ProjectSidePaneBody snapshot={snapshot} />;
}

function ProjectSidePaneBody({ snapshot }: { snapshot: ProjectSnapshot }) {
  const dialogs = useWorkbenchDialogs();
  const { startNewConversation } = useAgentShellState();
  const { projectTab, setProjectTab, refresh, refreshProject } = useProjects();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const live = snapshot.children.filter((child) => child.deletedAt == null && child.archivedAt == null);
  const workers = live.filter((child) => child.kind !== "helper");
  const attentionCount = live.filter((child) => child.bucket === "needs_attention").length;
  const openPrs = live.filter((child) => child.pr?.state === "open").length;
  const statusLine = projectSummaryStatusLine({
    agentCount: workers.length,
    workingCount: workers.filter((child) => child.bucket === "working").length,
    attentionCount,
  });
  const coordinatorBucket = projectChildBucket({ status: snapshot.orchestrator.status });
  const archived = snapshot.archivedAt != null;

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(projectErrorMessage(caught));
    } finally {
      setPending(false);
    }
  };

  const rename = async () => {
    const name = await dialogs.prompt({
      title: "Rename Project",
      defaultValue: snapshot.name,
      confirmLabel: "Rename",
    });
    if (!name || name === snapshot.name) {
      return;
    }
    await run(async () => {
      await patchProject(snapshot.id, { name });
      await Promise.all([refresh(), refreshProject(snapshot.id)]);
    });
  };

  const toggleArchived = () =>
    run(async () => {
      await patchProject(snapshot.id, { archived: !archived });
      await Promise.all([refresh(), refreshProject(snapshot.id)]);
    });

  const remove = async () => {
    const confirmed = await dialogs.confirm({
      title: `Delete ${snapshot.name}?`,
      message:
        "Stops and deletes every agent, the coordinator chat and the Project context. Repositories, pushed branches and pull requests are not touched.",
      confirmLabel: "Delete Project",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    await run(async () => {
      await deleteProject(snapshot.id);
      startNewConversation();
      await refresh();
    });
  };

  const tabCount = (tab: ProjectPageTab): number | null =>
    tab === "agents" ? workers.length : tab === "prs" ? openPrs : null;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-project-side-pane>
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-[16px] pt-[14px]">
        <div className="flex items-start justify-between gap-[12px] pr-[28px]">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-[8px]">
              <Network className="size-[15px] shrink-0 text-[var(--accent)]" strokeWidth={1.75} aria-hidden />
              <h2 className="min-w-0 truncate font-sans text-[15px] font-semibold text-[var(--text-primary)]">
                {snapshot.name}
              </h2>
              {archived ? (
                <span className="shrink-0 rounded-[4px] bg-[var(--bg-card)] px-[6px] py-[1px] font-sans text-[10.5px] text-[var(--text-secondary)]">
                  Archived
                </span>
              ) : null}
            </div>
            <div className="mt-[4px] flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-[5px]">
                <ProjectStatusDot bucket={coordinatorBucket} />
                Coordinator · {projectChildBucketLabel(coordinatorBucket).toLowerCase()}
              </span>
              <span>{statusLine}</span>
              <span>
                {snapshot.repos.length} {snapshot.repos.length === 1 ? "repository" : "repositories"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[2px]">
            <button
              type="button"
              onClick={() => void rename()}
              disabled={pending}
              className={projectIconButtonClass}
              aria-label="Rename Project"
              title="Rename"
            >
              <Pencil className="size-[13px]" strokeWidth={1.7} />
            </button>
            <button
              type="button"
              onClick={() => void toggleArchived()}
              disabled={pending}
              className={projectIconButtonClass}
              aria-label={archived ? "Restore Project" : "Archive Project"}
              title={archived ? "Restore" : "Archive"}
            >
              {archived ? (
                <ArchiveRestore className="size-[13px]" strokeWidth={1.7} />
              ) : (
                <Archive className="size-[13px]" strokeWidth={1.7} />
              )}
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={pending}
              className={`${projectIconButtonClass} hover:text-[var(--status-error)]`}
              aria-label="Delete Project"
              title="Delete"
            >
              <Trash2 className="size-[13px]" strokeWidth={1.7} />
            </button>
          </div>
        </div>
        {actionError ? <p className={`${projectErrorTextClass} mt-[6px]`}>{actionError}</p> : null}
        <div role="tablist" aria-label="Project" className="mt-[10px] flex gap-[14px] overflow-x-auto">
          {PROJECT_PAGE_TABS.map((tab) => {
            const selected = tab === projectTab;
            const count = tabCount(tab);
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`project-tab-${tab}`}
                aria-selected={selected}
                aria-controls="project-tab-panel"
                onClick={() => setProjectTab(tab)}
                className={`-mb-px inline-flex shrink-0 items-center gap-[6px] border-b-2 pb-[7px] font-sans text-[12.5px] transition-colors ${
                  selected
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {TAB_LABELS[tab]}
                {count ? (
                  <span
                    className={`rounded-[8px] px-[5px] font-sans text-[10px] tabular-nums leading-[15px] ${
                      tab === "agents" && attentionCount > 0
                        ? "bg-[color-mix(in_srgb,var(--status-warning)_20%,transparent)] text-[var(--status-warning)]"
                        : "bg-[var(--bg-card)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        role="tabpanel"
        id="project-tab-panel"
        aria-labelledby={`project-tab-${projectTab}`}
      >
        {projectTab === "agents" ? (
          <ProjectAgentsSection snapshot={snapshot} />
        ) : projectTab === "prs" ? (
          <ProjectPullRequestsSection snapshot={snapshot} />
        ) : projectTab === "context" ? (
          <ProjectContextSection projectId={snapshot.id} contextRoot={snapshot.contextRoot} />
        ) : (
          <ProjectSetupSection snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
