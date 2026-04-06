"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  FolderOpen,
  PanelLeft,
  PanelsRightBottom,
  SquareTerminal,
} from "lucide-react";
import { AgentWorkspaceRail } from "@/components/agent/AgentWorkspaceRail";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useViewport } from "@/hooks/useViewport";
import { fetchWorkspaceSession } from "@/lib/server-api";
import type { WorkspaceSessionState } from "@/lib/workspace-session";
import type { ChatTab } from "@/lib/types";
import { WorkbenchShellProviders } from "./WorkbenchShellProviders";

const AGENT_DEFAULT_LAYOUT = {
  workspaces: 24,
  chat: 44,
  tools: 32,
};

function useWorkspaceSessionPreviews(
  workspaces: Array<{ id: string }>,
  activeWorkspaceId: string | null,
  workspaceSession: WorkspaceSessionState
) {
  const [previewsByWorkspaceId, setPreviewsByWorkspaceId] = useState<
    Record<string, WorkspaceSessionState | null>
  >({});
  const lastFetchedKeyRef = useRef<string>("");

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setPreviewsByWorkspaceId((current) => ({
      ...current,
      [activeWorkspaceId]: workspaceSession,
    }));
  }, [activeWorkspaceId, workspaceSession]);

  useEffect(() => {
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    const nextKey = workspaceIds.join("|");
    if (workspaceIds.length === 0) {
      lastFetchedKeyRef.current = "";
      setPreviewsByWorkspaceId({});
      return;
    }
    if (lastFetchedKeyRef.current === nextKey) {
      return;
    }
    lastFetchedKeyRef.current = nextKey;

    let cancelled = false;
    void Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const result = await fetchWorkspaceSession(workspace.id);
          return [workspace.id, result.session] as const;
        } catch {
          return [workspace.id, null] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      const nextEntries = Object.fromEntries(entries);
      setPreviewsByWorkspaceId((current) => {
        const next: Record<string, WorkspaceSessionState | null> = {};
        for (const workspaceId of workspaceIds) {
          next[workspaceId] = nextEntries[workspaceId] ?? current[workspaceId] ?? null;
        }
        if (activeWorkspaceId) {
          next[activeWorkspaceId] = workspaceSession;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, workspaceSession, workspaces]);

  return [previewsByWorkspaceId, setPreviewsByWorkspaceId] as const;
}

function ResizeHandle() {
  return (
    <Separator className="group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

function activateChatTabs(tabs: ChatTab[], tabId: string): ChatTab[] {
  if (!tabs.some((tab) => tab.id === tabId)) {
    return tabs;
  }
  return tabs.map((tab) => ({
    ...tab,
    active: tab.id === tabId,
  }));
}

function AgentDesktopShell({
  editorDockOpen,
  setEditorDockOpen,
  workspaceRailOpen,
  setWorkspaceRailOpen,
}: {
  editorDockOpen: boolean;
  setEditorDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceRailOpen: boolean;
  setWorkspaceRailOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const {
    activeWorkspaceId,
    defaultWorkspaceId,
    loading,
    openWorkspaceById,
    recentWorkspaceIds,
    sessionReady,
    workspaceInfo,
    workspaceSession,
    updateWorkspaceSession,
    workspaces,
  } = useWorkspace();
  const bridgeRef = useEditorBridgeRef();
  const workspacePanelRef = usePanelRef();
  const toolsPanelRef = usePanelRef();
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [previewsByWorkspaceId, setPreviewsByWorkspaceId] = useWorkspaceSessionPreviews(
    workspaces,
    activeWorkspaceId,
    workspaceSession
  );

  const openEditorTabCount =
    workspaceSession.editor.leftTabs.length + workspaceSession.editor.rightTabs.length;
  const chatCount = workspaceSession.chat.tabs.length;
  const previousEditorTabCountRef = useRef(openEditorTabCount);

  useEffect(() => {
    previousEditorTabCountRef.current = openEditorTabCount;
  }, [activeWorkspaceId, openEditorTabCount]);

  useEffect(() => {
    const previousCount = previousEditorTabCountRef.current;
    if (openEditorTabCount > previousCount && !editorDockOpen) {
      setEditorDockOpen(true);
    }
    previousEditorTabCountRef.current = openEditorTabCount;
  }, [editorDockOpen, openEditorTabCount, setEditorDockOpen]);

  useLayoutEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) {
      return;
    }
    if (workspaceRailOpen) {
      if (panel.isCollapsed()) {
        panel.expand();
      }
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [workspacePanelRef, workspaceRailOpen]);

  useLayoutEffect(() => {
    const panel = toolsPanelRef.current;
    if (!panel) {
      return;
    }
    if (editorDockOpen) {
      if (panel.isCollapsed()) {
        panel.expand();
      }
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [editorDockOpen, toolsPanelRef]);

  const selectWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId || workspaceId === activeWorkspaceId) {
        return;
      }
      if (activeWorkspaceId) {
        setPreviewsByWorkspaceId((current) => ({
          ...current,
          [activeWorkspaceId]: workspaceSession,
        }));
      }
      setPendingWorkspaceId(workspaceId);
      try {
        await openWorkspaceById(workspaceId);
      } finally {
        setPendingWorkspaceId(null);
      }
    },
    [activeWorkspaceId, openWorkspaceById, setPreviewsByWorkspaceId, workspaceSession]
  );

  const selectWorkspaceChat = useCallback(
    async (workspaceId: string, chatTabId: string) => {
      if (!chatTabId) {
        return;
      }
      if (workspaceId !== activeWorkspaceId) {
        await selectWorkspace(workspaceId);
      }
      updateWorkspaceSession((current) => {
        const nextTabs = activateChatTabs(current.chat.tabs, chatTabId);
        return nextTabs === current.chat.tabs
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                tabs: nextTabs,
              },
            };
      });
    },
    [activeWorkspaceId, selectWorkspace, updateWorkspaceSession]
  );

  const openTerminal = useCallback(() => {
    setEditorDockOpen(true);
    const bridge = bridgeRef.current;
    if (!bridge) {
      return;
    }
    void bridge.openTerminalTab();
  }, [bridgeRef, setEditorDockOpen]);

  if (loading || !sessionReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
        Loading agent view...
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-main)] p-[14px]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Group
          orientation="horizontal"
          id="agent-panels"
          key={activeWorkspaceId ?? "agent-layout"}
          defaultLayout={workspaceSession.layout.agentDesktopLayout ?? AGENT_DEFAULT_LAYOUT}
          onLayoutChanged={(layout) => {
            updateWorkspaceSession((current) => ({
              ...current,
              layout: {
                ...current.layout,
                agentDesktopLayout: layout,
              },
            }));
          }}
        >
          <Panel
            id="workspaces"
            panelRef={workspacePanelRef}
            minSize="16%"
            maxSize="30%"
            collapsible
            collapsedSize="0%"
            className="min-h-0 overflow-visible"
          >
            <AgentWorkspaceRail
              activeWorkspaceId={activeWorkspaceId}
              defaultWorkspaceId={defaultWorkspaceId}
              recentWorkspaceIds={recentWorkspaceIds}
              workspaces={workspaces}
              previewsByWorkspaceId={previewsByWorkspaceId}
              pendingWorkspaceId={pendingWorkspaceId}
              onSelectWorkspace={(workspaceId) => {
                void selectWorkspace(workspaceId);
              }}
              onSelectWorkspaceChat={(workspaceId, chatTabId) => {
                void selectWorkspaceChat(workspaceId, chatTabId);
              }}
            />
          </Panel>

          <ResizeHandle />

          <Panel id="chat" minSize="38%" className="min-h-0 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col rounded-[28px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] p-[12px]">
              <div className="flex flex-wrap items-center gap-[8px] border-b border-[var(--border-card)] px-[4px] pb-[12px]">
                <button
                  type="button"
                  onClick={() => setWorkspaceRailOpen((current) => !current)}
                  className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <PanelLeft className="size-[14px]" strokeWidth={1.75} />
                  Workspaces
                </button>
                <button
                  type="button"
                  onClick={openTerminal}
                  className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <SquareTerminal className="size-[14px]" strokeWidth={1.75} />
                  New terminal
                </button>
                <button
                  type="button"
                  onClick={() => setEditorDockOpen((current) => !current)}
                  className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <PanelsRightBottom className="size-[14px]" strokeWidth={1.75} />
                  {editorDockOpen ? "Hide tools" : "Show tools"}
                </button>
                <Link
                  href="/editor"
                  className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <FolderOpen className="size-[14px]" strokeWidth={1.75} />
                  Open editor
                </Link>

                <div className="min-w-0 flex-1 text-right">
                  <div className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                    {workspaceInfo?.name ?? "Workspace"}
                  </div>
                  <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
                    {workspaceInfo?.root ?? "No workspace selected"}
                  </div>
                  <div className="font-sans text-[11px] text-[var(--text-secondary)]">
                    {chatCount} chat{chatCount === 1 ? "" : "s"} · {openEditorTabCount} tool tab
                    {openEditorTabCount === 1 ? "" : "s"}
                  </div>
                </div>
              </div>

              <div className="mt-[12px] min-h-0 flex-1 overflow-hidden rounded-[22px] border border-[var(--border-card)] bg-[var(--bg-panel)]">
                <ChatPanel />
              </div>
            </div>
          </Panel>

          <ResizeHandle />

          <Panel
            id="tools"
            panelRef={toolsPanelRef}
            minSize="22%"
            maxSize="42%"
            collapsible
            collapsedSize="0%"
            className="min-h-0 overflow-hidden"
          >
            <div className="flex h-full min-h-0 flex-col rounded-[28px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] p-[12px]">
              <div className="flex items-center justify-between gap-[10px] border-b border-[var(--border-card)] px-[4px] pb-[12px]">
                <div className="min-w-0">
                  <div className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                    Workspace tools
                  </div>
                  <div className="truncate font-sans text-[11px] text-[var(--text-secondary)]">
                    Files, terminals, browser tabs, transcripts, and drafts stay pinned here.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditorDockOpen(false)}
                  className="shrink-0 rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  Hide
                </button>
              </div>

              <div className="mt-[12px] min-h-0 flex-1 overflow-hidden rounded-[22px] border border-[var(--border-card)] bg-[var(--bg-main)]">
                <EditorPanel />
              </div>
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function AgentMobileShell({
  editorDockOpen,
  setEditorDockOpen,
}: {
  editorDockOpen: boolean;
  setEditorDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const {
    activeWorkspaceId,
    defaultWorkspaceId,
    loading,
    openWorkspaceById,
    recentWorkspaceIds,
    sessionReady,
    workspaceInfo,
    workspaceSession,
    updateWorkspaceSession,
    workspaces,
  } = useWorkspace();
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [previewsByWorkspaceId] = useWorkspaceSessionPreviews(
    workspaces,
    activeWorkspaceId,
    workspaceSession
  );

  const selectWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId || workspaceId === activeWorkspaceId) {
        return;
      }
      setPendingWorkspaceId(workspaceId);
      try {
        await openWorkspaceById(workspaceId);
      } finally {
        setPendingWorkspaceId(null);
      }
    },
    [activeWorkspaceId, openWorkspaceById]
  );

  const selectWorkspaceChat = useCallback(
    async (workspaceId: string, chatTabId: string) => {
      if (!chatTabId) {
        return;
      }
      if (workspaceId !== activeWorkspaceId) {
        await selectWorkspace(workspaceId);
      }
      updateWorkspaceSession((current) => {
        const nextTabs = activateChatTabs(current.chat.tabs, chatTabId);
        return nextTabs === current.chat.tabs
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                tabs: nextTabs,
              },
            };
      });
    },
    [activeWorkspaceId, selectWorkspace, updateWorkspaceSession]
  );

  if (loading || !sessionReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
        Loading agent view...
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col gap-[12px] overflow-hidden bg-[var(--bg-main)] p-[12px]">
      <div className="shrink-0 rounded-[24px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] p-[10px]">
        <div className="flex flex-wrap items-center gap-[8px] border-b border-[var(--border-card)] px-[4px] pb-[10px]">
          <button
            type="button"
            onClick={() => setEditorDockOpen((current) => !current)}
            className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)]"
          >
            <PanelsRightBottom className="size-[14px]" strokeWidth={1.75} />
            {editorDockOpen ? "Hide tools" : "Show tools"}
          </button>
          <Link
            href="/editor"
            className="flex h-[34px] items-center gap-[8px] rounded-full border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12px] text-[var(--text-secondary)]"
          >
            <FolderOpen className="size-[14px]" strokeWidth={1.75} />
            Open editor
          </Link>
          <div className="min-w-0 flex-1 text-right">
            <div className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
              {workspaceInfo?.name ?? "Workspace"}
            </div>
            <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
              {workspaceInfo?.root ?? "No workspace selected"}
            </div>
          </div>
        </div>
        <div className="mt-[10px] h-[240px] min-h-0 overflow-hidden">
          <AgentWorkspaceRail
            activeWorkspaceId={activeWorkspaceId}
            defaultWorkspaceId={defaultWorkspaceId}
            recentWorkspaceIds={recentWorkspaceIds}
            workspaces={workspaces}
            previewsByWorkspaceId={previewsByWorkspaceId}
            pendingWorkspaceId={pendingWorkspaceId}
            onSelectWorkspace={(workspaceId) => {
              void selectWorkspace(workspaceId);
            }}
            onSelectWorkspaceChat={(workspaceId, chatTabId) => {
              void selectWorkspaceChat(workspaceId, chatTabId);
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] p-[10px]">
        <div className="h-full overflow-hidden rounded-[18px] border border-[var(--border-card)] bg-[var(--bg-panel)]">
          <ChatPanel />
        </div>
      </div>

      {editorDockOpen ? (
        <div className="h-[38vh] shrink-0 overflow-hidden rounded-[24px] border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--bg-panel)_82%,transparent)] p-[10px]">
          <div className="h-full overflow-hidden rounded-[18px] border border-[var(--border-card)] bg-[var(--bg-main)]">
            <EditorPanel />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AgentLayout() {
  const { activeWorkspaceId, workspaceSession, updateWorkspaceSession } = useWorkspace();
  const { isMobile } = useViewport();
  const [editorDockOpen, setEditorDockOpen] = useState(
    workspaceSession.layout.agentEditorOpen
  );
  const [workspaceRailOpen, setWorkspaceRailOpen] = useState(true);

  useEffect(() => {
    setEditorDockOpen(workspaceSession.layout.agentEditorOpen);
  }, [workspaceSession.layout.agentEditorOpen]);

  useEffect(() => {
    updateWorkspaceSession((current) => {
      if (current.layout.agentEditorOpen === editorDockOpen) {
        return current;
      }
      return {
        ...current,
        layout: {
          ...current.layout,
          agentEditorOpen: editorDockOpen,
        },
      };
    });
  }, [editorDockOpen, updateWorkspaceSession]);

  useEffect(() => {
    setWorkspaceRailOpen(true);
  }, [activeWorkspaceId]);

  const workbench = useMemo(
    () => ({
      toggleSidebar: () => {
        setWorkspaceRailOpen((current) => !current);
      },
      toggleChat: () => {
        setEditorDockOpen((current) => !current);
      },
      revealExplorer: () => {
        setWorkspaceRailOpen(true);
      },
    }),
    []
  );

  return (
    <WorkbenchShellProviders workbench={workbench}>
      {isMobile ? (
        <AgentMobileShell
          editorDockOpen={editorDockOpen}
          setEditorDockOpen={setEditorDockOpen}
        />
      ) : (
        <AgentDesktopShell
          editorDockOpen={editorDockOpen}
          setEditorDockOpen={setEditorDockOpen}
          workspaceRailOpen={workspaceRailOpen}
          setWorkspaceRailOpen={setWorkspaceRailOpen}
        />
      )}
    </WorkbenchShellProviders>
  );
}
