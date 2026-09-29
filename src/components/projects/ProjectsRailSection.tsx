"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Network, Plus } from "lucide-react";
import { projectSummaryStatusLine, type ProjectListing } from "@cesium/core";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { projectListingServerLabel } from "@/lib/server-display-labels";
import { ProjectEngineBadge, ProjectStatusDot } from "./project-ui";
import { useProjects } from "./ProjectsProvider";

const COLLAPSED_KEY = "cesium.projects.railCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function ProjectRailRow({
  project,
  active,
  onOtherEngine,
  engineName,
}: {
  project: ProjectListing;
  active: boolean;
  onOtherEngine: boolean;
  engineName: string;
}) {
  const { openProject } = useProjects();
  const busy = project.workingCount > 0 || project.orchestratorStatus === "running";
  const bucket =
    project.attentionCount > 0 ? "needs_attention" : busy ? "working" : "idle";
  return (
    <li>
      <button
        type="button"
        onClick={() => void openProject(project)}
        className={`flex h-[var(--agent-rail-row-height)] w-full min-w-0 items-center gap-[8px] rounded-[var(--agent-control-radius)] px-[9px] text-left ${
          active ? "bg-[var(--agent-card-bg)]" : "hover:bg-[var(--agent-card-bg)]"
        }`}
        title={projectSummaryStatusLine(project)}
        aria-current={active ? "page" : undefined}
      >
        <Network
          className={`size-[14px] shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"}`}
          strokeWidth={1.6}
          aria-hidden
        />
        <span
          className={`min-w-0 flex-1 truncate font-sans text-[14px] ${
            active ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
          }`}
        >
          {project.name}
        </span>
        {onOtherEngine ? (
          <ProjectEngineBadge
            label={engineName}
            remote={false}
            title={`Lives on ${engineName}; opening it switches to that engine`}
          />
        ) : null}
        {project.agentCount > 0 || busy ? (
          <span className="flex shrink-0 items-center gap-[5px] font-sans text-[11px] tabular-nums text-[var(--text-disabled)]">
            {project.workingCount > 0 ? `${project.workingCount}/${project.agentCount}` : project.agentCount}
            <ProjectStatusDot bucket={bucket} />
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Projects at the top of the workspace rail; each row opens its Project page. */
export function ProjectsRailSection() {
  const { enabled, projects, loaded, error, activeProjectId, setNewProjectOpen } = useProjects();
  const { activeServer, servers, engineNameById } = useServerConnections();
  const appearances = useGlobalSettings().settings.general.serverRailAppearances;
  const [collapsed, setCollapsed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  if (!enabled) {
    return null;
  }

  const archivedCount = projects.filter((project) => project.archivedAt != null).length;
  const visible = projects.filter(
    (project) => project.archivedAt == null || showArchived || project.id === activeProjectId
  );
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Private mode: the section just forgets its state.
      }
      return next;
    });
  };

  return (
    <section className="pb-[12px]" data-testid="projects-rail-section">
      <div className="group flex items-center gap-[2px] px-px pb-[4px]">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="group/wshead flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[2px] text-left"
          aria-expanded={!collapsed}
        >
          <span className="relative grid size-[10px] shrink-0 place-items-center">
            <Network
              className="col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] group-hover/wshead:opacity-0"
              strokeWidth={2}
            />
            <ChevronRight
              className={`col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] opacity-0 group-hover/wshead:opacity-100 group-hover/wshead:text-[var(--text-secondary)] ${
                collapsed ? "" : "rotate-90"
              }`}
              strokeWidth={2}
            />
          </span>
          <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] group-hover/wshead:text-[var(--text-primary)]">
            Projects
          </span>
        </button>
        {archivedCount > 0 && !collapsed ? (
          <button
            type="button"
            onClick={() => setShowArchived((current) => !current)}
            className="shrink-0 rounded-[var(--agent-control-radius)] px-[5px] font-sans text-[10.5px] text-[var(--text-disabled)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
            aria-pressed={showArchived}
            title={showArchived ? "Hide archived Projects" : "Show archived Projects"}
          >
            {showArchived ? "Hide archived" : `Archived (${archivedCount})`}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
          aria-label="New Project"
          title="New Project"
        >
          <Plus className="size-[12px]" strokeWidth={1.5} />
        </button>
      </div>
      {!collapsed ? (
        error && visible.length === 0 ? (
          <p className="px-[9px] py-[4px] font-sans text-[11.5px] leading-[1.4] text-[var(--text-disabled)]">
            {error}
          </p>
        ) : !loaded ? (
          <p className="px-[9px] py-[4px] font-sans text-[11.5px] text-[var(--text-disabled)]">
            Loading Projects…
          </p>
        ) : visible.length === 0 ? (
          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            className="flex w-full items-center gap-[8px] rounded-[var(--agent-control-radius)] px-[9px] py-[5px] text-left font-sans text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
          >
            <Plus className="size-[13px] shrink-0" strokeWidth={1.6} aria-hidden />
            New Project
          </button>
        ) : (
          <ul className="flex flex-col gap-[1px]">
            {visible.map((project) => (
              <ProjectRailRow
                key={project.id}
                project={project}
                active={project.id === activeProjectId}
                onOtherEngine={project.serverId !== activeServer.id}
                engineName={projectListingServerLabel(project, servers, appearances, engineNameById)}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
