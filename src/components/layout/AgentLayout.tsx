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
import { MobileAgentShell } from "@/components/agent/MobileAgentShell";
import { ExtensionsWorkspaceBridge } from "@/components/extensions/ExtensionsWorkspaceBridge";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useIsCesiumDesktopApp } from "@/lib/desktop-environment";
import {
  BACK_INTENT_PRIORITY,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";

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

  // On mobile the workspace rail and workbench pane are overlays, so a back
  // gesture should dismiss them (top-most first) before the app exits. The
  // rail drawer sits above the right pane, matching their visual stacking.
  useBackHandler(
    isMobile && !leftRailCollapsed,
    BACK_INTENT_PRIORITY.leftRail,
    () => setLeftRailCollapsed(true)
  );
  useBackHandler(isMobile && rightPaneOpen, BACK_INTENT_PRIORITY.rightPane, () =>
    setRightPaneOpen(false)
  );
  const padTrailingForWindowChrome =
    experimentalIpadWindowedTabInset && !isMobile && !rightPaneOpen;
  const electronTrailingChromeForToggle =
    isDesktopApp && !isMobile && !rightPaneOpen;

  const groupRef = useGroupRef();
  const railPanelRef = usePanelRef();
  const sidePanelRef = usePanelRef();
  const applyingShellLayoutFromContextRef = useRef(false);
  const desktopShellRef = useRef<HTMLDivElement | null>(null);
  const panelsAnimatingRef = useRef(false);
  const panelAnimationCleanupRef = useRef<number | null>(null);
  const prevPanelToggleStateRef = useRef<{ rail: boolean; side: boolean } | null>(null);

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
      prevPanelToggleStateRef.current = null;
      return;
    }

    // Slide animation for programmatic rail / workbench toggles: transition
    // `flex-grow` on the panels (react-resizable-panels' size channel) and pin
    // each sliding panel's content to the edge it travels from, locked at its
    // resting width, so it genuinely slides instead of squishing. Drag-resizes
    // never enter this path (the classes live only for the toggle window).
    const previousToggleState = prevPanelToggleStateRef.current;
    const nextToggleState = { rail: leftRailCollapsed, side: rightPaneOpen };
    prevPanelToggleStateRef.current = nextToggleState;
    const railToggled =
      previousToggleState != null && previousToggleState.rail !== nextToggleState.rail;
    const sideToggled =
      previousToggleState != null && previousToggleState.side !== nextToggleState.side;
    const groupEl = desktopShellRef.current?.querySelector<HTMLElement>("[data-group]");
    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (groupEl && (railToggled || sideToggled) && !reducedMotion) {
      const groupWidth = groupEl.getBoundingClientRect().width || 1;
      groupEl.classList.add("agent-shell-panels-animating");
      if (railToggled) {
        const railEl = groupEl.querySelector<HTMLElement>(
          `[data-panel][id="${AGENT_SHELL_PANEL_IDS.rail}"]`
        );
        const currentPx = railEl?.getBoundingClientRect().width ?? 0;
        const targetPx =
          ((agentShellLayout[AGENT_SHELL_PANEL_IDS.rail] ?? 0) / 100) * groupWidth;
        groupEl.style.setProperty(
          "--agent-rail-slide-width",
          `${Math.max(1, Math.round(Math.max(currentPx, targetPx)))}px`
        );
        groupEl.classList.add("agent-shell-rail-sliding");
      }
      if (sideToggled) {
        const sideEl = groupEl.querySelector<HTMLElement>(
          `[data-panel][id="${AGENT_SHELL_PANEL_IDS.side}"]`
        );
        const currentPx = sideEl?.getBoundingClientRect().width ?? 0;
        const targetPx =
          ((agentShellLayout[AGENT_SHELL_PANEL_IDS.side] ?? 0) / 100) * groupWidth;
        groupEl.style.setProperty(
          "--agent-side-slide-width",
          `${Math.max(1, Math.round(Math.max(currentPx, targetPx)))}px`
        );
        groupEl.classList.add("agent-shell-side-sliding");
      }
      panelsAnimatingRef.current = true;
      if (panelAnimationCleanupRef.current != null) {
        window.clearTimeout(panelAnimationCleanupRef.current);
      }
      panelAnimationCleanupRef.current = window.setTimeout(() => {
        groupEl.classList.remove(
          "agent-shell-panels-animating",
          "agent-shell-rail-sliding",
          "agent-shell-side-sliding"
        );
        panelsAnimatingRef.current = false;
        panelAnimationCleanupRef.current = null;
      }, 320);
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
              <MobileAgentShell
                railOpen={!leftRailCollapsed}
                rightOpen={rightPaneOpen}
                setRailOpen={(open) => setLeftRailCollapsed(!open)}
                setRightOpen={setRightPaneOpen}
                rightGestureEnabled={!isDraftConversationSelected}
                railWidth={AGENT_LEFT_RAIL_EXPANDED_WIDTH}
                rightPaneWidthCss={`min(100vw, ${AGENT_RIGHT_PANE_WIDTH}px)`}
                rail={<AgentWorkspaceRail />}
                rightPane={<AgentSidePane />}
              >
                {leftRailCollapsed ? (
                  <button
                    type="button"
                    onClick={() => setLeftRailCollapsed(false)}
                    className="mobile-safe-top-offset absolute left-[11px] top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                    aria-label="Show workspace rail"
                  >
                    <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
                  </button>
                ) : null}

                <div className="relative z-10 h-full min-w-0">
                  <AgentCenterStage compact>
                    <AgentCenterPane />
                  </AgentCenterStage>
                </div>

                {!rightPaneOpen && !isDraftConversationSelected ? (
                  <button
                    type="button"
                    onClick={toggleRightPaneOpen}
                    data-workbench-pane-toggle
                    data-electron-trailing-chrome={
                      electronTrailingChromeForToggle ? "true" : undefined
                    }
                    className={`mobile-safe-top-offset absolute top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
                      padTrailingForWindowChrome
                        ? "right-[calc(var(--editor-window-chrome-tab-inset)+11px)]"
                        : "right-[11px]"
                    }`}
                    aria-label="Show workbench pane"
                  >
                    <PanelRightOpen className="size-[16px]" strokeWidth={1.5} />
                  </button>
                ) : null}
              </MobileAgentShell>
            ) : (
              <div ref={desktopShellRef} className="h-full min-w-0 [&>[data-group]]:h-full">
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
                    if (applyingShellLayoutFromContextRef.current || panelsAnimatingRef.current) {
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
                  {/* z-20 drag host for window dragging; AgentCenterStage at z-[21] layers chat content above. */}
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
                        data-electron-no-drag
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
                    if (applyingShellLayoutFromContextRef.current || panelsAnimatingRef.current) {
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
              </div>
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
          <ExtensionsWorkspaceBridge />
        </AgentShellStateProvider>
      </EditorBridgeProvider>
    </WorkbenchContextMenuProvider>
  );
}
