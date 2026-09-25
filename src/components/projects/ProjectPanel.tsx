"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  LoaderCircle,
  MessagesSquare,
  Network,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  projectChildBucket,
  projectChildBucketLabel,
  projectSummaryStatusLine,
  type ProjectSnapshot,
} from "@cesium/core";
import { useWorkbenchDialogs } from "@/components/dialogs/WorkbenchDialogProvider";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { deleteProject, patchProject } from "@/lib/server-api";
import { ProjectAgentsSection } from "./ProjectAgentsSection";
import { ProjectNotesSection } from "./ProjectNotesSection";
import { ProjectSetupSection } from "./ProjectSetupSection";
import {
  ProjectStatusDot,
  projectButtonClass,
  projectErrorMessage,
  projectErrorTextClass,
  projectIconButtonClass,
} from "./project-ui";
import { useProjects, useProjectSnapshot } from "./ProjectsProvider";

type ProjectSection = "agents" | "notes" | "setup";

const SECTIONS: Array<{ id: ProjectSection; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "notes", label: "Notes" },
  { id: "setup", label: "Setup" },
];

/** Projects Beta: the side-pane tab for one Project (agents, notes, setup). */
export function ProjectPanel({ projectId }: { projectId: string }) {
  const snapshot = useProjectSnapshot(projectId);
  const { refreshProject } = useProjects();
  const [failed, setFailed] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setFailed(!(await refreshProject(projectId)));
  }, [projectId, refreshProject]);

  useEffect(() => {
    void load();
  }, [load]);

  if (deleted) {
    return (
      <div className="flex h-full items-center justify-center px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        This Project was deleted.
      </div>
    );
  }

  if (!snapshot) {
    return failed ? (
      <div className="flex h-full flex-col items-center justify-center gap-[10px] px-[24px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
        <p>This Project could not be loaded from the current engine.</p>
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

  return <ProjectPanelBody snapshot={snapshot} onDeleted={() => setDeleted(true)} />;
}

function ProjectPanelBody({
  snapshot,
  onDeleted,
}: {
  snapshot: ProjectSnapshot;
  onDeleted: () => void;
}) {
  const dialogs = useWorkbenchDialogs();
  const editorBridgeRef = useEditorBridgeRef();
  const { activeProjectId, openProjectById, refresh, refreshProject } = useProjects();
  const [section, setSection] = useState<ProjectSection>("agents");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const live = snapshot.children.filter((child) => child.deletedAt == null);
  const attentionCount = live.filter((child) => child.bucket === "needs_attention").length;
  const statusLine = projectSummaryStatusLine({
    agentCount: live.length,
    workingCount: live.filter((child) => child.bucket === "working").length,
    attentionCount,
  });
  const orchestratorBucket = projectChildBucket({ status: snapshot.orchestrator.status });
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
      editorBridgeRef.current?.openProjectTab({ projectId: snapshot.id, title: name });
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
        "Stops and deletes every agent, the orchestrator chat and the Project notes. Repository files are not touched.",
      confirmLabel: "Delete Project",
      tone: "danger",
    });
    if (!confirmed) {
      return;
    }
    await run(async () => {
      await deleteProject(snapshot.id);
      onDeleted();
      await refresh();
      const bridge = editorBridgeRef.current;
      const state = bridge?.getState();
      const tabId = `project:${snapshot.id}`;
      const group = state?.leftTabs.some((tab) => tab.id === tabId)
        ? "left"
        : state?.rightTabs.some((tab) => tab.id === tabId)
          ? "right"
          : null;
      if (bridge && group) {
        bridge.requestCloseTab(group, tabId);
      }
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]" data-project-panel>
      <div className="shrink-0 border-b border-[var(--border-subtle)] px-[16px] pt-[14px]">
        <div className="flex items-start justify-between gap-[12px]">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-[8px]">
              <Network className="size-[15px] shrink-0 text-[var(--accent)]" strokeWidth={1.75} aria-hidden />
              <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold text-[var(--text-primary)]">
                {snapshot.name}
              </h1>
              {archived ? (
                <span className="shrink-0 rounded-[4px] bg-[var(--bg-card)] px-[6px] py-[1px] font-sans text-[10.5px] text-[var(--text-secondary)]">
                  Archived
                </span>
              ) : null}
            </div>
            <div className="mt-[4px] flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-[4px] font-sans text-[11.5px] text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-[5px]">
                <ProjectStatusDot bucket={orchestratorBucket} />
                Orchestrator · {projectChildBucketLabel(orchestratorBucket).toLowerCase()}
              </span>
              <span>{statusLine}</span>
              <span>
                {snapshot.repos.length} {snapshot.repos.length === 1 ? "repository" : "repositories"}
              </span>
              {snapshot.orchestrator.modelName || snapshot.orchestrator.modelId ? (
                <code className="truncate rounded-[5px] bg-[var(--accent-bg)] px-[6px] py-[1px] font-mono text-[10.5px]">
                  {snapshot.orchestrator.modelName ?? snapshot.orchestrator.modelId}
                </code>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[2px]">
            {activeProjectId !== snapshot.id ? (
              <button
                type="button"
                onClick={() => void openProjectById(snapshot.id)}
                className={`${projectButtonClass} mr-[4px]`}
              >
                <MessagesSquare className="size-[13px]" strokeWidth={1.7} aria-hidden />
                Open chat
              </button>
            ) : null}
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
        <div role="tablist" aria-label="Project sections" className="mt-[10px] flex gap-[14px]">
          {SECTIONS.map((entry) => {
            const selected = entry.id === section;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setSection(entry.id)}
                className={`-mb-px inline-flex items-center gap-[6px] border-b-2 pb-[7px] font-sans text-[12.5px] transition-colors ${
                  selected
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {entry.label}
                {entry.id === "agents" && live.length > 0 ? (
                  <span
                    className={`rounded-[8px] px-[5px] font-sans text-[10px] tabular-nums leading-[15px] ${
                      attentionCount > 0
                        ? "bg-[color-mix(in_srgb,var(--status-warning)_20%,transparent)] text-[var(--status-warning)]"
                        : "bg-[var(--bg-card)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {live.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
        {section === "agents" ? (
          <ProjectAgentsSection snapshot={snapshot} />
        ) : section === "notes" ? (
          <ProjectNotesSection projectId={snapshot.id} contextRoot={snapshot.contextRoot} />
        ) : (
          <ProjectSetupSection snapshot={snapshot} />
        )}
      </div>
    </div>
  );
}
