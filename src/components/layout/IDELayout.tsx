"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useViewport } from "@/hooks/useViewport";
import { PanelLeft } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useTheme } from "@/components/theme/ThemeProvider";
import { WorkbenchShellProviders } from "./WorkbenchShellProviders";

function ResizeHandle() {
  return (
    <Separator className="group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

type MobilePanel = "sidebar" | "editor" | "chat";

/** Stable reference — Group must not receive a new defaultLayout object every render. */
const DESKTOP_DEFAULT_LAYOUT = {
  sidebar: 15,
  editor: 56,
  chat: 29,
};

export function IDELayout() {
  const { themeConfig } = useTheme();
  const { showSidebar, showChat, isMobile } = useViewport();
  const { activeWorkspaceId, loading, sessionReady, workspaceSession, updateWorkspaceSession } =
    useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(workspaceSession.layout.sidebarOpen);
  const [chatOpen, setChatOpen] = useState(workspaceSession.layout.chatOpen);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(workspaceSession.layout.mobilePanel);
  const sidebarPanelRef = usePanelRef();
  const chatPanelRef = usePanelRef();

  useEffect(() => {
    setSidebarOpen(workspaceSession.layout.sidebarOpen);
    setChatOpen(workspaceSession.layout.chatOpen);
    setMobilePanel(workspaceSession.layout.mobilePanel);
  }, [workspaceSession.layout.chatOpen, workspaceSession.layout.mobilePanel, workspaceSession.layout.sidebarOpen]);

  useEffect(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      layout: {
        ...current.layout,
        sidebarOpen,
        chatOpen,
        mobilePanel,
      },
    }));
  }, [chatOpen, mobilePanel, sidebarOpen, updateWorkspaceSession]);

  const workbench = useMemo(
    () => ({
      toggleSidebar: () => {
        if (isMobile) {
          setMobilePanel((p) => (p === "sidebar" ? "editor" : "sidebar"));
        } else {
          setSidebarOpen((o) => !o);
        }
      },
      toggleChat: () => {
        if (isMobile) {
          setMobilePanel((p) => (p === "chat" ? "editor" : "chat"));
        } else {
          setChatOpen((o) => !o);
        }
      },
      revealExplorer: () => {
        if (isMobile) setMobilePanel("sidebar");
        else setSidebarOpen(true);
      },
    }),
    [isMobile]
  );

  const sidebarVisible = isMobile
    ? mobilePanel === "sidebar"
    : showSidebar && sidebarOpen;
  const chatVisible = isMobile ? mobilePanel === "chat" : showChat && chatOpen;

  // Keep sidebar / chat in the tree at all times so the group layout does not
  // remount panels or redistribute percentages when toggling — only collapse/expand.
  useLayoutEffect(() => {
    if (isMobile) return;
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarVisible) {
      if (panel.isCollapsed()) panel.expand();
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [isMobile, sidebarVisible, sidebarPanelRef]);

  useLayoutEffect(() => {
    if (isMobile) return;
    const panel = chatPanelRef.current;
    if (!panel) return;
    if (chatVisible) {
      if (panel.isCollapsed()) panel.expand();
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [isMobile, chatVisible, chatPanelRef]);

  if (loading || !sessionReady) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
        Loading workspace...
      </div>
    );
  }

  return (
    <WorkbenchShellProviders workbench={workbench}>
          {isMobile ? (
            <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-main)]">
              <div className="min-h-0 flex-1 overflow-hidden">
                {mobilePanel === "sidebar" && <FileExplorer />}
                {mobilePanel === "editor" && <EditorPanel />}
                {mobilePanel === "chat" && <ChatPanel />}
              </div>
              <nav className="flex h-[44px] shrink-0 items-center justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
                <button
                  type="button"
                  onClick={() => setMobilePanel("sidebar")}
                  className="px-4 py-2 font-sans text-[12px] transition-colors"
                  style={{
                    color:
                      mobilePanel === "sidebar"
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                  }}
                >
                  Files
                </button>
                <button
                  type="button"
                  onClick={() => setMobilePanel("editor")}
                  className="px-4 py-2 font-sans text-[12px] transition-colors"
                  style={{
                    color:
                      mobilePanel === "editor"
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                  }}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setMobilePanel("chat")}
                  className="px-4 py-2 font-sans text-[12px] transition-colors"
                  style={{
                    color:
                      mobilePanel === "chat"
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                  }}
                >
                  Chat
                </button>
              </nav>
            </div>
          ) : (
            <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-main)]">
              <div className="flex min-h-0 flex-1 overflow-hidden">
              {!sidebarVisible && themeConfig.showFloatingSidebarReveal ? (
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Show primary sidebar"
                  title="Show primary sidebar"
                  className="absolute left-2 top-2 z-20 rounded-[var(--radius-tab)] bg-[var(--bg-panel)] p-1.5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <PanelLeft className="size-[18px]" strokeWidth={1.5} />
                </button>
              ) : null}

              <Group
                orientation="horizontal"
                id="ide-panels"
                key={activeWorkspaceId ?? "workspace-layout"}
                defaultLayout={workspaceSession.layout.desktopLayout ?? DESKTOP_DEFAULT_LAYOUT}
                onLayoutChanged={(layout) => {
                  updateWorkspaceSession((current) => ({
                    ...current,
                    layout: {
                      ...current.layout,
                      desktopLayout: layout,
                    },
                  }));
                }}
              >
                <Panel
                  id="sidebar"
                  panelRef={sidebarPanelRef}
                  minSize="10%"
                  maxSize="25%"
                  collapsible
                  collapsedSize="0%"
                  className="min-h-0 overflow-visible"
                >
                  <FileExplorer />
                </Panel>
                <ResizeHandle />
                <Panel
                  id="editor"
                  minSize="30%"
                  className="min-h-0 h-full"
                  style={{ overflow: "hidden" }}
                >
                  <EditorPanel />
                </Panel>
                <ResizeHandle />
                <Panel
                  id="chat"
                  panelRef={chatPanelRef}
                  minSize="15%"
                  maxSize="45%"
                  collapsible
                  collapsedSize="0%"
                  className="min-h-0 h-full"
                  style={{ overflow: "hidden" }}
                >
                  <ChatPanel />
                </Panel>
              </Group>
              </div>
            </div>
          )}
    </WorkbenchShellProviders>
  );
}
