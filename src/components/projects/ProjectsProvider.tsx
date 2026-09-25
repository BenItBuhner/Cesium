"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  diffProjectChildren,
  isProjectChildRemote,
  mergeProjectListings,
  projectChildChangeNotice,
  type ProjectChildChange,
  type ProjectChildMark,
  type ProjectChildSummary,
  type ProjectListing,
  type ProjectServerListing,
  type ProjectSnapshot,
  type ProjectSummary,
} from "@cesium/core";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import { resolveRailFetchServers } from "@/lib/rail-fetch";
import { fetchProject, listProjects, toServerRequestContext } from "@/lib/server-api";
import type { ServerConnection } from "@/lib/server-connections";

const LIST_POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 3_000;
const NOTICE_DISMISS_MS = 12_000;

type ProjectOpenTarget = Pick<
  ProjectSummary,
  "id" | "name" | "orchestratorConversationId" | "orchestratorWorkspaceId" | "createdAt" | "updatedAt"
> & {
  orchestratorStatus?: ProjectSummary["orchestratorStatus"];
  /** Engine the Project lives on; defaults to the one that listed it, then the active one. */
  serverId?: string;
};

type ProjectsContextValue = {
  enabled: boolean;
  /** Projects from every connected engine, each tagged with the engine it lives on. */
  projects: ProjectListing[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Project whose orchestrator is the selected conversation. */
  activeProjectId: string | null;
  openProject: (project: ProjectOpenTarget) => Promise<void>;
  openProjectById: (projectId: string) => Promise<void>;
  /**
   * Opens a child's own conversation. It runs on the Project's engine unless
   * `server` names the peer engine it was placed on.
   */
  openChildConversation: (
    projectId: string,
    child: ProjectChildSummary,
    server?: { id: string; label: string }
  ) => Promise<void>;
  snapshots: Record<string, ProjectSnapshot>;
  /** Keeps a snapshot fresh while the caller is mounted. */
  watchProject: (projectId: string) => () => void;
  refreshProject: (projectId: string) => Promise<ProjectSnapshot | null>;
  newProjectOpen: boolean;
  setNewProjectOpen: (open: boolean) => void;
};

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

function conversationSummary(input: {
  id: string;
  workspaceId: string;
  title: string;
  backendId: AgentRailConversationSummary["backendId"];
  status: AgentRailConversationSummary["status"];
  createdAt: number;
  updatedAt: number;
  serverId: string;
  serverLabel: string;
}): AgentRailConversationSummary {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastEventSeq: 0,
    status: input.status,
    archivedAt: null,
    backendId: input.backendId,
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    serverId: input.serverId,
    serverLabel: input.serverLabel,
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    conversationKey: `${input.serverId}:${input.id}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same engines the conversation rail reads, with the active one first so it wins duplicates. */
function projectListServers(input: {
  activeServer: ServerConnection;
  onlineServers: ServerConnection[];
  serverStatusById: Parameters<typeof resolveRailFetchServers>[0]["serverStatusById"];
}): ServerConnection[] {
  const servers = resolveRailFetchServers(input);
  return [
    ...servers.filter((server) => server.id === input.activeServer.id),
    ...servers.filter((server) => server.id !== input.activeServer.id),
  ];
}

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { projects: enabled } = useUserPreferences();
  const { activeServer, servers, onlineServers, serverStatusById } = useServerConnections();
  const {
    openConversationSummary,
    selectedConversationId,
    setRightPaneOpen,
  } = useAgentShellState();
  const editorBridgeRef = useEditorBridgeRef();
  const { pushNotification } = useWorkbenchNotifications();

  const [projects, setProjects] = useState<ProjectListing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSnapshot>>({});
  const [watchCounts, setWatchCounts] = useState<Record<string, number>>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [pendingTab, setPendingTab] = useState<{
    projectId: string;
    conversationId: string;
    title: string;
  } | null>(null);

  // Opening a peer engine's conversation makes that engine active, so the list
  // spans every connected engine instead of following the active one.
  const listServers = useMemo(
    () => projectListServers({ activeServer, onlineServers, serverStatusById }),
    [activeServer, onlineServers, serverStatusById]
  );
  const listServersKey = listServers.map((server) => server.id).join("\n");
  const listServersRef = useRef(listServers);
  const serversRef = useRef(servers);
  const activeServerRef = useRef(activeServer);
  const listGenerationRef = useRef(0);
  const marksRef = useRef(new Map<string, Map<string, ProjectChildMark>>());
  const summaryTurnsRef = useRef(new Map<string, string>());
  const selectedConversationIdRef = useRef(selectedConversationId);
  const projectsRef = useRef(projects);
  const openProjectByIdRef = useRef<(projectId: string) => Promise<void>>(async () => {});
  const openChildRef = useRef<
    (projectId: string, child: ProjectChildSummary) => Promise<void>
  >(async () => {});

  useEffect(() => {
    listServersRef.current = listServers;
    serversRef.current = servers;
    activeServerRef.current = activeServer;
  }, [activeServer, listServers, servers]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  /** The engine a Project lives on: an explicit id, else whichever engine listed it, else the active one. */
  const serverForProject = useCallback(
    (projectId: string, serverId?: string): ServerConnection => {
      const listedOn =
        serverId ?? projectsRef.current.find((project) => project.id === projectId)?.serverId;
      return (
        (listedOn ? serversRef.current.find((server) => server.id === listedOn) : undefined) ??
        activeServerRef.current
      );
    },
    []
  );

  const announce = useCallback(
    (snapshot: ProjectSnapshot, changes: ProjectChildChange[]) => {
      const watching = selectedConversationIdRef.current;
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      for (const change of changes) {
        const { child } = change;
        if (
          visible &&
          (watching === snapshot.orchestrator.conversationId || watching === child.conversationId)
        ) {
          continue;
        }
        const notice = projectChildChangeNotice(change);
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: notice.severity,
          title: `${snapshot.name} · ${notice.title}`,
          message: notice.message,
          autoDismissMs: NOTICE_DISMISS_MS,
          compact: true,
          actions: [
            {
              id: "open-project",
              label: "Open Project",
              primary: true,
              onClick: () => void openProjectByIdRef.current(snapshot.id),
            },
            ...(isProjectChildRemote(child)
              ? []
              : [
                  {
                    id: "open-agent",
                    label: "Open agent",
                    onClick: () => void openChildRef.current(snapshot.id, child),
                  },
                ]),
          ],
        });
      }
    },
    [pushNotification]
  );

  const ingestSnapshot = useCallback(
    (snapshot: ProjectSnapshot) => {
      const { changes, marks } = diffProjectChildren(
        marksRef.current.get(snapshot.id),
        snapshot.children
      );
      marksRef.current.set(snapshot.id, marks);
      setSnapshots((current) => ({ ...current, [snapshot.id]: snapshot }));
      if (changes.length > 0) {
        announce(snapshot, changes);
      }
    },
    [announce]
  );

  const refreshProject = useCallback(
    async (projectId: string): Promise<ProjectSnapshot | null> => {
      try {
        const snapshot = await fetchProject(projectId, {
          server: toServerRequestContext(serverForProject(projectId)),
        });
        ingestSnapshot(snapshot);
        return snapshot;
      } catch {
        return null;
      }
    },
    [ingestSnapshot, serverForProject]
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const generation = ++listGenerationRef.current;
    const results = await Promise.all(
      listServersRef.current.map(async (server): Promise<ProjectServerListing> => {
        try {
          const listed = await listProjects({ server: toServerRequestContext(server) });
          return { serverId: server.id, serverLabel: server.label, projects: listed };
        } catch (caught) {
          return {
            serverId: server.id,
            serverLabel: server.label,
            projects: null,
            error: errorMessage(caught),
          };
        }
      })
    );
    if (generation !== listGenerationRef.current) {
      return;
    }
    const merged = mergeProjectListings(projectsRef.current, results);
    projectsRef.current = merged.projects;
    setProjects(merged.projects);
    setError(merged.error);
    setLoaded(true);
    const stale: string[] = [];
    for (const project of merged.projects) {
      const signature = `${project.turnsCompleted}:${project.attentionCount}`;
      if (summaryTurnsRef.current.get(project.id) !== signature) {
        summaryTurnsRef.current.set(project.id, signature);
        stale.push(project.id);
      }
    }
    await Promise.all(stale.map((projectId) => refreshProject(projectId)));
  }, [enabled, refreshProject]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer: number | null = null;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await refresh();
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), LIST_POLL_MS);
      }
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh, listServersKey]);

  const watchedIds = useMemo(
    () => Object.keys(watchCounts).filter((projectId) => (watchCounts[projectId] ?? 0) > 0),
    [watchCounts]
  );

  useEffect(() => {
    if (!enabled || watchedIds.length === 0) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await Promise.all(watchedIds.map((projectId) => refreshProject(projectId)));
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), SNAPSHOT_POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [enabled, refreshProject, watchedIds]);

  const watchProject = useCallback((projectId: string) => {
    setWatchCounts((current) => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
    return () => {
      setWatchCounts((current) => {
        const next = { ...current, [projectId]: (current[projectId] ?? 1) - 1 };
        if ((next[projectId] ?? 0) <= 0) {
          delete next[projectId];
        }
        return next;
      });
    };
  }, []);

  const openProject = useCallback(
    async (project: ProjectOpenTarget) => {
      const server = serverForProject(project.id, project.serverId);
      setPendingTab({
        projectId: project.id,
        conversationId: project.orchestratorConversationId,
        title: project.name,
      });
      await openConversationSummary(
        conversationSummary({
          id: project.orchestratorConversationId,
          workspaceId: project.orchestratorWorkspaceId,
          title: project.name,
          backendId: "cesium-agent",
          status:
            project.orchestratorStatus && project.orchestratorStatus !== "unknown"
              ? project.orchestratorStatus
              : "idle",
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          serverId: server.id,
          serverLabel: server.label,
        })
      );
    },
    [openConversationSummary, serverForProject]
  );

  const openProjectById = useCallback(
    async (projectId: string) => {
      const known = projectsRef.current.find((project) => project.id === projectId);
      if (known) {
        await openProject(known);
        return;
      }
      const snapshot = await fetchProject(projectId);
      await openProject({
        id: snapshot.id,
        name: snapshot.name,
        orchestratorConversationId: snapshot.orchestrator.conversationId,
        orchestratorWorkspaceId: snapshot.orchestrator.workspaceId,
        orchestratorStatus: snapshot.orchestrator.status,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      });
    },
    [openProject]
  );

  const openChildConversation = useCallback(
    async (
      projectId: string,
      child: ProjectChildSummary,
      peer?: { id: string; label: string }
    ) => {
      const server = peer ?? serverForProject(projectId);
      await openConversationSummary(
        conversationSummary({
          id: child.conversationId,
          workspaceId: child.workspaceId,
          title: child.name,
          backendId: child.backendId as AgentRailConversationSummary["backendId"],
          status: child.status === "unknown" ? "idle" : child.status,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt ?? child.createdAt,
          serverId: server.id,
          serverLabel: server.label,
        })
      );
    },
    [openConversationSummary, serverForProject]
  );

  useEffect(() => {
    openProjectByIdRef.current = openProjectById;
    openChildRef.current = openChildConversation;
  }, [openChildConversation, openProjectById]);

  // The side pane's editor remounts per conversation, so the Project tab opens
  // once the orchestrator is the selected conversation and its editor exists.
  useEffect(() => {
    if (!pendingTab || selectedConversationId !== pendingTab.conversationId) {
      return;
    }
    const timer = window.setTimeout(() => {
      editorBridgeRef.current?.openProjectTab({
        projectId: pendingTab.projectId,
        title: pendingTab.title,
      });
      setRightPaneOpen(true);
      setPendingTab(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editorBridgeRef, pendingTab, selectedConversationId, setRightPaneOpen]);

  const activeProjectId = useMemo(
    () =>
      projects.find((project) => project.orchestratorConversationId === selectedConversationId)
        ?.id ?? null,
    [projects, selectedConversationId]
  );

  const value = useMemo<ProjectsContextValue>(
    () => ({
      enabled,
      projects,
      loaded,
      error,
      refresh,
      activeProjectId,
      openProject,
      openProjectById,
      openChildConversation,
      snapshots,
      watchProject,
      refreshProject,
      newProjectOpen,
      setNewProjectOpen,
    }),
    [
      activeProjectId,
      enabled,
      error,
      loaded,
      newProjectOpen,
      openChildConversation,
      openProject,
      openProjectById,
      projects,
      refresh,
      refreshProject,
      snapshots,
      watchProject,
    ]
  );

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsContextValue {
  const context = useContext(ProjectsContext);
  if (!context) {
    throw new Error("useProjects must be used within ProjectsProvider");
  }
  return context;
}

/** Subscribes to one Project's snapshot for as long as the caller is mounted. */
export function useProjectSnapshot(projectId: string | null): ProjectSnapshot | null {
  const { snapshots, watchProject } = useProjects();
  useEffect(() => {
    if (!projectId) {
      return;
    }
    return watchProject(projectId);
  }, [projectId, watchProject]);
  return projectId ? (snapshots[projectId] ?? null) : null;
}
