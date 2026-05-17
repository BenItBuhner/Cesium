"use client";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { Group, Panel, Separator, useGroupRef, usePanelRef } from "react-resizable-panels";
import { EditorBridgeProvider } from "@/components/ide/EditorBridgeContext";
import { IDEKeyboardLayer } from "@/components/ide/IDEKeyboardLayer";
import { WorkbenchProvider } from "@/components/ide/WorkbenchContext";
import { WorkbenchContextMenuProvider } from "@/components/ide/WorkbenchContextMenuProvider";
import { HardwareInputProvider } from "@/components/input/HardwareInputProvider";
import { AgentCenterPane } from "@/components/agent/AgentCenterPane";
import { AgentShellStateProvider, useAgentShellState } from "@/components/agent/AgentShellStateContext";
import {
  AGENT_CENTER_STAGE_CLASS,
  AGENT_SHELL_CENTER_MIN_PERCENT,
  AGENT_LEFT_RAIL_COLLAPSED_SIZE_PERCENT,
  AGENT_LEFT_RAIL_EXPANDED_WIDTH,
  AGENT_RIGHT_PANE_WIDTH,
  AGENT_SHELL_DEFAULT_LAYOUT,
  AGENT_SHELL_RAIL_MAX_PERCENT,
  AGENT_SHELL_RAIL_MIN_PERCENT,
  AGENT_SHELL_PANEL_IDS,
  AGENT_SHELL_SIDE_MAX_PERCENT,
  AGENT_SHELL_SIDE_MIN_PERCENT,
  collapseAgentShellSideLayout,
  normalizeAgentShellDesktopLayout,
} from "@/components/agent/agent-shell-layout";
import { AgentSidePane } from "@/components/agent/AgentSidePane";
import { AgentWorkspaceRail } from "@/components/agent/AgentWorkspaceRail";
import { AgentWorkspaceRailCollapsedOverlay } from "@/components/agent/AgentWorkspaceRailCollapsedOverlay";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useIsCesiumDesktopApp } from "@/lib/desktop-environment";

function AgentShellResizeHandle() {
  return (
    <Separator className="group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]">
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
    </Separator>
  );
}

function AgentCenterStage({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`relative z-[21] flex h-full min-w-0 justify-center overflow-hidden ${
        compact ? "px-[8px]" : "px-0"
      }`}
    >
      <div className={`h-full w-full ${AGENT_CENTER_STAGE_CLASS}`}>{children}</div>
    </div>
  );
}

function AgentLayoutShell() {
  const { activeWorkspaceId, fileTree, loading, sessionReady, workspaceInfo } = useWorkspace();
  const {
    isMobile,
    leftRailCollapsed,
    rightPaneOpen,
    isDraftConversationSelected,
    agentShellDesktopLayout,
    setLeftRailCollapsed,
    setAgentShellDesktopLayout,
    setRightPaneOpen,
    toggleRightPaneOpen,
  } = useAgentShellState();
  const { experimentalIpadWindowedTabInset } = useUserPreferences();
  const isDesktopApp = useIsCesiumDesktopApp();
  const padTrailingForWindowChrome =
    experimentalIpadWindowedTabInset && !isMobile && !rightPaneOpen;
  const electronTrailingChromeForToggle =
    isDesktopApp && !isMobile && !rightPaneOpen;

  const groupRef = useGroupRef();
  const railPanelRef = usePanelRef();
  const sidePanelRef = usePanelRef();
  const applyingShellLayoutFromContextRef = useRef(false);

  const agentShellLayout = useMemo(
    () => {
      const baseLayout =
        normalizeAgentShellDesktopLayout(agentShellDesktopLayout) ??
        AGENT_SHELL_DEFAULT_LAYOUT;
      return rightPaneOpen ? baseLayout : collapseAgentShellSideLayout(baseLayout);
    },
    [agentShellDesktopLayout, rightPaneOpen]
  );

  const workbench = useMemo(
    () => ({
      toggleSidebar: () => setLeftRailCollapsed(!leftRailCollapsed),
      toggleChat: () => setRightPaneOpen(!rightPaneOpen),
      revealExplorer: () => setLeftRailCollapsed(false),
      primarySidebarVisible: !leftRailCollapsed && !isMobile,
      editorLeadingWindowControlsVisible: false,
      editorTrailingWindowControlsVisible: rightPaneOpen && !isMobile,
      chatTrailingWindowControlsVisible: false,
    }),
    [
      isMobile,
      leftRailCollapsed,
      rightPaneOpen,
      setLeftRailCollapsed,
      setRightPaneOpen,
    ]
  );

  useLayoutEffect(() => {
    if (isMobile) {
      return;
    }
    applyingShellLayoutFromContextRef.current = true;
    try {
      groupRef.current?.setLayout(agentShellLayout);
    } finally {
      queueMicrotask(() => {
        applyingShellLayoutFromContextRef.current = false;
      });
    }

    const railPanel = railPanelRef.current;
    if (railPanel) {
      if (!leftRailCollapsed) {
        if (railPanel.isCollapsed()) {
          railPanel.expand();
        }
      } else if (!railPanel.isCollapsed()) {
        railPanel.collapse();
      }
    }
    const sidePanel = sidePanelRef.current;
    if (sidePanel) {
      if (rightPaneOpen) {
        if (sidePanel.isCollapsed()) {
          sidePanel.expand();
        }
      } else if (!sidePanel.isCollapsed()) {
        sidePanel.collapse();
      }
    }
  }, [
    agentShellLayout,
    groupRef,
    isMobile,
    leftRailCollapsed,
    railPanelRef,
    rightPaneOpen,
    sidePanelRef,
  ]);

  // Only block the entire shell during the first workspace hydration. Once a workspace is already
  // mounted, keep the existing UI visible during cross-workspace switches so chat hops feel
  // seamless instead of flashing the full-screen loader.
  const showBlockingWorkspaceLoad =
    loading && (!activeWorkspaceId || !workspaceInfo || fileTree == null || !sessionReady);

  if (showBlockingWorkspaceLoad) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
        Loading workspace...
      </div>
    );
  }

  return (
    <WorkbenchProvider value={workbench}>
      <HardwareInputProvider>
        <IDEKeyboardLayer>
          <div className="relative h-screen w-screen overflow-hidden bg-[var(--bg-main)]">
            {isMobile ? (
              <>
                {!leftRailCollapsed ? (
                  <>
                    <div
                      className="absolute inset-0 z-30 bg-black/40"
                      onClick={() => setLeftRailCollapsed(true)}
                    />
                    <div
                      className="absolute inset-y-0 left-0 z-40 overflow-hidden border-r border-[var(--border-subtle)] shadow-[0_0_40px_rgba(0,0,0,0.35)]"
                      style={{ width: `${AGENT_LEFT_RAIL_EXPANDED_WIDTH}px` }}
                    >
                      <AgentWorkspaceRail />
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setLeftRailCollapsed(false)}
                    className="absolute left-[11px] top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                    aria-label="Show workspace rail"
                  >
                    <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
                  </button>
                )}

                <div className="relative z-10 h-full min-w-0">
                  <AgentCenterStage compact>
                    <AgentCenterPane />
                  </AgentCenterStage>
                </div>

                <div
                  className={`absolute inset-y-0 right-0 z-40 overflow-hidden ${
                    rightPaneOpen
                      ? "border-l border-[var(--border-subtle)] shadow-[-12px_0_36px_rgba(0,0,0,0.28)]"
                      : "pointer-events-none border-l-0 shadow-none"
                  }`}
                  style={{
                    width: rightPaneOpen ? `min(100vw, ${AGENT_RIGHT_PANE_WIDTH}px)` : "0px",
                  }}
                  aria-hidden={!rightPaneOpen}
                >
                  <AgentSidePane />
                </div>
                {!rightPaneOpen && !isDraftConversationSelected ? (
                  <button
                    type="button"
                    onClick={toggleRightPaneOpen}
                    data-workbench-pane-toggle
                    data-electron-trailing-chrome={
                      electronTrailingChromeForToggle ? "true" : undefined
                    }
                    className={`absolute top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
                      padTrailingForWindowChrome
                        ? "right-[calc(var(--editor-window-chrome-tab-inset)+11px)]"
                        : "right-[11px]"
                    }`}
                    aria-label="Show workbench pane"
                  >
                    <PanelRightOpen className="size-[16px]" strokeWidth={1.5} />
                  </button>
                ) : null}
              </>
            ) : (
              <>
              <Group
                id="agent-shell-panels"
                groupRef={groupRef}
                key="agent-shell-desktop"
                orientation="horizontal"
                className="h-full min-w-0"
                defaultLayout={agentShellLayout}
              >
                <Panel
                  id={AGENT_SHELL_PANEL_IDS.rail}
                  panelRef={railPanelRef}
                  minSize={`${AGENT_SHELL_RAIL_MIN_PERCENT}%`}
                  maxSize={`${AGENT_SHELL_RAIL_MAX_PERCENT}%`}
                  collapsible
                  collapsedSize={`${AGENT_LEFT_RAIL_COLLAPSED_SIZE_PERCENT}%`}
                  onResize={(panelSize) => {
                    if (applyingShellLayoutFromContextRef.current) {
                      return;
                    }
                    setAgentShellDesktopLayout({
                      [AGENT_SHELL_PANEL_IDS.rail]: panelSize.asPercentage,
                    });
                  }}
                  className={`min-h-0 overflow-hidden ${
                    leftRailCollapsed ? "" : "border-r border-[var(--border-subtle)]"
                  }`}
                >
                  <AgentWorkspaceRail />
                </Panel>
                <AgentShellResizeHandle />
                <Panel
                  id={AGENT_SHELL_PANEL_IDS.center}
                  minSize={`${AGENT_SHELL_CENTER_MIN_PERCENT}%`}
                  className="relative min-h-0 min-w-0 overflow-hidden"
                >
                  {/* z-20 drag host; keep AgentCenterStage above (`z-[21]`) so sticky chat headers and controls receive clicks in Electron. */}
                  <div
                    aria-hidden
                    className="absolute left-0 right-[148px] top-0 z-20 h-[32px]"
                    data-electron-drag-host
                  />
                  {!rightPaneOpen && !isDraftConversationSelected ? (
                    <button
                      type="button"
                      onClick={toggleRightPaneOpen}
                        data-workbench-pane-toggle
                        data-electron-trailing-chrome={
                          electronTrailingChromeForToggle ? "true" : undefined
                        }
                        className={`absolute top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
                          padTrailingForWindowChrome
                            ? "right-[calc(var(--editor-window-chrome-tab-inset)+11px)]"
                            : "right-[11px]"
                        }`}
                      aria-label="Show workbench pane"
                    >
                      <PanelRightOpen className="size-[16px]" strokeWidth={1.5} />
                    </button>
                  ) : null}

                  <AgentCenterStage>
                    <AgentCenterPane />
                  </AgentCenterStage>
                </Panel>
                <AgentShellResizeHandle />
                <Panel
                  id={AGENT_SHELL_PANEL_IDS.side}
                  panelRef={sidePanelRef}
                  minSize={`${AGENT_SHELL_SIDE_MIN_PERCENT}%`}
                  maxSize={`${AGENT_SHELL_SIDE_MAX_PERCENT}%`}
                  collapsible
                  collapsedSize="0%"
                  onResize={(panelSize) => {
                    if (applyingShellLayoutFromContextRef.current) {
                      return;
                    }
                    setAgentShellDesktopLayout({
                      [AGENT_SHELL_PANEL_IDS.side]: panelSize.asPercentage,
                    });
                  }}
                  className={`min-h-0 overflow-hidden ${
                    rightPaneOpen ? "border-l border-[var(--border-subtle)]" : ""
                  }`}
                >
                  <div className="h-full min-h-0 w-full overflow-hidden">
                    <AgentSidePane />
                  </div>
                </Panel>
              </Group>
              <AgentWorkspaceRailCollapsedOverlay />
              </>
            )}
          </div>
        </IDEKeyboardLayer>
      </HardwareInputProvider>
    </WorkbenchProvider>
  );
}

export function AgentLayout() {
  return (
    <WorkbenchContextMenuProvider>
      <EditorBridgeProvider>
        <AgentShellStateProvider>
          <AgentLayoutShell />
        </AgentShellStateProvider>
      </EditorBridgeProvider>
    </WorkbenchContextMenuProvider>
  );
}
