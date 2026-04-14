"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useViewport } from "@/hooks/useViewport";
import { PanelLeft, PanelRight } from "lucide-react";
import { EditorBridgeProvider } from "@/components/ide/EditorBridgeContext";
import { WorkbenchProvider } from "@/components/ide/WorkbenchContext";
import { IDEKeyboardLayer } from "@/components/ide/IDEKeyboardLayer";
import { WorkbenchContextMenuProvider } from "@/components/ide/WorkbenchContextMenuProvider";
import { HardwareInputProvider } from "@/components/input/HardwareInputProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useTheme } from "@/components/theme/ThemeProvider";

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
  const { settings } = useGlobalSettings();
  const { showSidebar, showChat, isMobile } = useViewport();
  const {
    activeWorkspaceId,
    fileTree,
    loading,
    sessionReady,
    workspaceInfo,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const sideColumnsSwapped = settings.general.sideColumnsSwapped;
  const [sidebarOpen, setSidebarOpen] = useState(workspaceSession.layout.sidebarOpen);
  const [chatOpen, setChatOpen] = useState(workspaceSession.layout.chatOpen);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(workspaceSession.layout.mobilePanel);
  const sidebarPanelRef = usePanelRef();
  const chatPanelRef = usePanelRef();
  const SidebarRevealIcon = sideColumnsSwapped ? PanelRight : PanelLeft;

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

  const sidebarVisible = isMobile
    ? mobilePanel === "sidebar"
    : showSidebar && sidebarOpen;
  const chatVisible = isMobile ? mobilePanel === "chat" : showChat && chatOpen;

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
      primarySidebarVisible: sidebarVisible,
    }),
    [isMobile, sidebarVisible]
  );

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

  const showBlockingWorkspaceLoad =
    loading && (!activeWorkspaceId || !workspaceInfo || fileTree == null || !sessionReady);

  if (showBlockingWorkspaceLoad) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
        Loading workspace...
      </div>
    );
  }

  const sidebarPanel = (
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
  );

  const editorPanel = (
    <Panel
      id="editor"
      minSize="30%"
      className="min-h-0 h-full"
      style={{ overflow: "hidden" }}
    >
      <EditorPanel key={`ide:${activeWorkspaceId ?? "workspace"}`} />
    </Panel>
  );

  const chatPanel = (
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
  );

  return (
    <WorkbenchContextMenuProvider>
      <EditorBridgeProvider>
        <WorkbenchProvider value={workbench}>
          <HardwareInputProvider>
            <IDEKeyboardLayer>
              {isMobile ? (
                    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--bg-main)]">
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {mobilePanel === "sidebar" && <FileExplorer />}
                        {mobilePanel === "editor" && (
                          <EditorPanel key={`ide-mobile:${activeWorkspaceId ?? "workspace"}`} />
                        )}
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
                            className={`absolute top-2 z-20 rounded-[var(--radius-tab)] bg-[var(--bg-panel)] p-1.5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] ${
                              sideColumnsSwapped ? "right-2" : "left-2"
                            }`}
                          >
                            <SidebarRevealIcon className="size-[18px]" strokeWidth={1.5} />
                          </button>
                        ) : null}

                        <Group
                          orientation="horizontal"
                          id="ide-panels"
                          key={`${activeWorkspaceId ?? "workspace-layout"}:${sideColumnsSwapped ? "swapped" : "default"}`}
                          defaultLayout={
                            workspaceSession.layout.desktopLayout ??
                            DESKTOP_DEFAULT_LAYOUT
                          }
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
                          {sideColumnsSwapped ? (
                            <>
                              {chatPanel}
                              <ResizeHandle />
                              {editorPanel}
                              <ResizeHandle />
                              {sidebarPanel}
                            </>
                          ) : (
                            <>
                              {sidebarPanel}
                              <ResizeHandle />
                              {editorPanel}
                              <ResizeHandle />
                              {chatPanel}
                            </>
                          )}
                        </Group>
                      </div>
                    </div>
                  )}
            </IDEKeyboardLayer>
          </HardwareInputProvider>
        </WorkbenchProvider>
      </EditorBridgeProvider>
    </WorkbenchContextMenuProvider>
  );
}
