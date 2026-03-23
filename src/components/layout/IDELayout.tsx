"use client";

import { useMemo, useState } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useViewport } from "@/hooks/useViewport";
import { PanelLeft } from "lucide-react";
import { EditorBridgeProvider } from "@/components/ide/EditorBridgeContext";
import { WorkbenchProvider } from "@/components/ide/WorkbenchContext";
import { IDEKeyboardLayer } from "@/components/ide/IDEKeyboardLayer";

function ResizeHandle() {
  return (
    <Separator className="group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

type MobilePanel = "sidebar" | "editor" | "chat";

export function IDELayout() {
  const { showSidebar, showChat, isMobile } = useViewport();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("editor");

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

  return (
    <OpenInEditorProvider>
      <EditorBridgeProvider>
        <WorkbenchProvider value={workbench}>
          <IDEKeyboardLayer />
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
            <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg-main)]">
              {!sidebarVisible && (
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  className="absolute left-2 top-2 z-20 rounded-[var(--radius-tab)] bg-[var(--bg-panel)] p-1.5 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  <PanelLeft className="size-[18px]" strokeWidth={1.5} />
                </button>
              )}

              <Group orientation="horizontal" id="ide-panels">
                {sidebarVisible && (
                  <>
                    <Panel
                      defaultSize="15%"
                      minSize="10%"
                      maxSize="25%"
                      collapsible
                      collapsedSize="0%"
                      id="sidebar"
                      className="min-h-0"
                    >
                      <FileExplorer />
                    </Panel>
                    <ResizeHandle />
                  </>
                )}

                <Panel
                  defaultSize={
                    sidebarVisible && chatVisible
                      ? "56%"
                      : sidebarVisible || chatVisible
                        ? "70%"
                        : "100%"
                  }
                  minSize="30%"
                  id="editor"
                  className="min-h-0 h-full"
                  style={{ overflow: "hidden" }}
                >
                  <EditorPanel />
                </Panel>

                {chatVisible && (
                  <>
                    <ResizeHandle />
                    <Panel
                      defaultSize="29%"
                      minSize="15%"
                      maxSize="45%"
                      collapsible
                      collapsedSize="0%"
                      id="chat"
                      className="min-h-0 h-full"
                      style={{ overflow: "hidden" }}
                    >
                      <ChatPanel />
                    </Panel>
                  </>
                )}
              </Group>
            </div>
          )}
        </WorkbenchProvider>
      </EditorBridgeProvider>
    </OpenInEditorProvider>
  );
}
