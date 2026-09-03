"use client";

import { Fragment, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
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
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { MobileShareIntake } from "@/components/mobile/MobileShareIntake";
import { MobileNotificationRouting } from "@/components/mobile/MobileNotificationRouting";
import { ExtensionsWorkspaceBridge } from "@/components/extensions/ExtensionsWorkspaceBridge";
import { VoiceSessionProvider } from "@/components/voice/VoiceSessionProvider";
import { VoiceAgentView } from "@/components/voice/VoiceAgentView";
import { useWorkspace } from "@/contexts/WorkspaceContext";
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
  const { settings: globalSettings } = useGlobalSettings();
  const sideColumnsSwapped = globalSettings.general.sideColumnsSwapped;
  const showMobilePaneToggles = globalSettings.general.showMobilePaneToggles;
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
    sidePaneEditorSession,
  } = useAgentShellState();
  const rightEditorTabCount =
    sidePaneEditorSession.leftTabs.length + sidePaneEditorSession.rightTabs.length;
  const isDesktopApp = useIsCesiumDesktopApp();

  // Android back gestures for the mobile rail drawer and right pane are
  // registered inside MobileAgentShell, where the drawer motion engine lives -
  // that lets the predictive back gesture drive the drawers frame by frame.
  const electronTrailingChromeForToggle =
    isDesktopApp && !isMobile && !rightPaneOpen;

  const groupRef = useGroupRef();
  const railPanelRef = usePanelRef();
  const sidePanelRef = usePanelRef();
  const applyingShellLayoutFromContextRef = useRef(false);
  const desktopShellRef = useRef<HTMLDivElement | null>(null);
  const panelsAnimatingRef = useRef(false);
  const panelTweenRafRef = useRef<number | null>(null);
  const prevPanelToggleStateRef = useRef<{ rail: boolean; side: boolean } | null>(null);

  const agentShellLayout = useMemo(
    () => {
      const baseLayout =
        normalizeAgentShellDesktopLayout(agentShellDesktopLayout) ??
        AGENT_SHELL_DEFAULT_LAYOUT;
      const withSide = rightPaneOpen
        ? baseLayout
        : collapseAgentShellSideLayout(baseLayout);
      if (!leftRailCollapsed) {
        return withSide;
      }
      // Fold the rail's share into the center so `setLayout` always receives
      // the exact final layout - the slide tween needs analytic targets
      // instead of whatever the library redistributes after `collapse()`.
      const rail = withSide[AGENT_SHELL_PANEL_IDS.rail] ?? 0;
      return {
        ...withSide,
        [AGENT_SHELL_PANEL_IDS.rail]: 0,
        [AGENT_SHELL_PANEL_IDS.center]:
          (withSide[AGENT_SHELL_PANEL_IDS.center] ?? 0) + rail,
      };
    },
    [agentShellDesktopLayout, leftRailCollapsed, rightPaneOpen]
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

    // Slide animation for programmatic rail / workbench toggles.
    //
    // The panels' size channel is inline `flex-grow`, but a CSS transition on
    // it is unreliable: whether the style recalc pairs the class with the new
    // grow value is timing-dependent (it intermittently snapped), and WebKit
    // does not interpolate flex-grow at all. Instead a rAF tween writes the
    // three panels' flex-grow every frame from the pre-toggle values to the
    // analytic target layout - deterministic and engine-independent. While a
    // panel slides, its content is pinned to the edge it travels from and
    // locked to its resting width so it genuinely slides instead of
    // squishing. Drag-resizes never enter this path.
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

    const panelIds = [
      AGENT_SHELL_PANEL_IDS.rail,
      AGENT_SHELL_PANEL_IDS.center,
      AGENT_SHELL_PANEL_IDS.side,
    ];
    let tweenPanels: Array<{ el: HTMLElement; from: number; to: number }> | null = null;

    if (groupEl && (railToggled || sideToggled) && !reducedMotion) {
      const groupWidth = groupEl.getBoundingClientRect().width || 1;
      const els = panelIds.map((id) =>
        groupEl.querySelector<HTMLElement>(`[data-panel][id="${id}"]`)
      );
      if (els.every((el): el is HTMLElement => el != null)) {
        // Pre-toggle sizes; mid-flight values when interrupting a live tween.
        const startGrows = els.map(
          (el) => Number.parseFloat(getComputedStyle(el).flexGrow) || 0
        );
        const targetGrows = panelIds.map((id) => agentShellLayout[id] ?? 0);
        tweenPanels = els.map((el, index) => ({
          el,
          from: startGrows[index],
          to: targetGrows[index],
        }));

        if (railToggled) {
          const railPx = (grow: number) => (grow / 100) * groupWidth;
          groupEl.style.setProperty(
            "--agent-rail-slide-width",
            `${Math.max(1, Math.round(Math.max(railPx(startGrows[0]), railPx(targetGrows[0]))))}px`
          );
          groupEl.classList.add("agent-shell-rail-sliding");
        }
        if (sideToggled) {
          const sidePx = (grow: number) => (grow / 100) * groupWidth;
          groupEl.style.setProperty(
            "--agent-side-slide-width",
            `${Math.max(1, Math.round(Math.max(sidePx(startGrows[2]), sidePx(targetGrows[2]))))}px`
          );
          groupEl.classList.add("agent-shell-side-sliding");
        }
        panelsAnimatingRef.current = true;
      }
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

    if (tweenPanels && groupEl) {
      // The library has committed the final layout above; rewind the DOM to
      // the start values before this effect returns (pre-paint, so no flash)
      // and tween to the targets. JS drives every frame, so no engine has to
      // interpolate flex-grow and no style-recalc ordering can drop the
      // animation.
      if (panelTweenRafRef.current != null) {
        cancelAnimationFrame(panelTweenRafRef.current);
        panelTweenRafRef.current = null;
      }
      const panels = tweenPanels;
      for (const panel of panels) {
        panel.el.style.flexGrow = String(panel.from);
      }
      const durationMs = 260;
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      // Epoch anchors to the FIRST callback's own timestamp: rAF hands frames
      // the vsync-aligned start time, which can precede a `performance.now()`
      // captured mid-effect during a long commit - a naive epoch makes the
      // first t negative and the eased value overshoot wildly.
      let startedAt: number | null = null;
      const finish = () => {
        for (const panel of panels) {
          panel.el.style.flexGrow = String(panel.to);
        }
        groupEl.classList.remove("agent-shell-rail-sliding", "agent-shell-side-sliding");
        panelsAnimatingRef.current = false;
        panelTweenRafRef.current = null;
      };
      const step = (now: number) => {
        if (startedAt == null) {
          startedAt = now;
        }
        const t = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
        if (t >= 1) {
          finish();
          return;
        }
        const eased = easeOutCubic(t);
        for (const panel of panels) {
          panel.el.style.flexGrow = String(panel.from + (panel.to - panel.from) * eased);
        }
        panelTweenRafRef.current = requestAnimationFrame(step);
      };
      panelTweenRafRef.current = requestAnimationFrame(step);
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
          {/* Portal overlay; mounted inside the keyboard/hardware-input tree so
              its ChatComposer gets every context the landing composer has. */}
          <VoiceAgentView />
          {/* Aurora canvas lives on WorkbenchAuroraHost so settings can sit
              over the same scene. This root stays transparent under
              `data-aurora-scene` via `.aurora-agent-shell`. */}
          <div className="aurora-agent-shell relative h-full w-full overflow-hidden">
            {isMobile ? (
              <MobileAgentShell
                railOpen={!leftRailCollapsed}
                rightOpen={rightPaneOpen}
                setRailOpen={(open) => setLeftRailCollapsed(!open)}
                setRightOpen={setRightPaneOpen}
                rightGestureEnabled={!isDraftConversationSelected}
                rightCloseGestureEnabled={rightEditorTabCount === 0}
                railWidth={AGENT_LEFT_RAIL_EXPANDED_WIDTH}
                rightPaneWidthCss={`min(100vw, ${AGENT_RIGHT_PANE_WIDTH}px)`}
                rail={<AgentWorkspaceRail />}
                rightPane={<AgentSidePane />}
              >
                {showMobilePaneToggles && leftRailCollapsed ? (
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

                {showMobilePaneToggles && !rightPaneOpen && !isDraftConversationSelected ? (
                  <button
                    type="button"
                    onClick={toggleRightPaneOpen}
                    data-workbench-pane-toggle
                    data-electron-trailing-chrome={
                      electronTrailingChromeForToggle ? "true" : undefined
                    }
                    className="mobile-safe-top-offset absolute top-[11px] right-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                    aria-label="Show workbench pane"
                  >
                    <PanelRightOpen className="size-[16px]" strokeWidth={1.5} />
                  </button>
                ) : null}
              </MobileAgentShell>
            ) : (
              <div
                ref={desktopShellRef}
                className="h-full min-w-0 [&>[data-group]]:h-full"
                data-side-columns-swapped={sideColumnsSwapped ? "true" : undefined}
              >
              <Group
                id="agent-shell-panels"
                groupRef={groupRef}
                key={sideColumnsSwapped ? "agent-shell-desktop-swapped" : "agent-shell-desktop"}
                orientation="horizontal"
                className="h-full min-w-0"
                defaultLayout={agentShellLayout}
              >
                {(() => {
                  const railPanel = (
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
                        leftRailCollapsed
                          ? ""
                          : `${sideColumnsSwapped ? "border-l" : "border-r"} border-[var(--border-subtle)]`
                      }`}
                    >
                      <AgentWorkspaceRail />
                    </Panel>
                  );
                  const centerPanel = (
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
                            electronTrailingChromeForToggle && !sideColumnsSwapped
                              ? "true"
                              : undefined
                          }
                          className={`mobile-safe-top-offset absolute top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
                            sideColumnsSwapped ? "left-[11px]" : "right-[11px]"
                          }`}
                          aria-label="Show workbench pane"
                        >
                          {sideColumnsSwapped ? (
                            <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
                          ) : (
                            <PanelRightOpen className="size-[16px]" strokeWidth={1.5} />
                          )}
                        </button>
                      ) : null}

                      <AgentCenterStage>
                        <AgentCenterPane />
                      </AgentCenterStage>
                    </Panel>
                  );
                  const sidePanel = (
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
                        rightPaneOpen
                          ? `${sideColumnsSwapped ? "border-r" : "border-l"} border-[var(--border-subtle)]`
                          : ""
                      }`}
                    >
                      <div className="h-full min-h-0 w-full overflow-hidden">
                        <AgentSidePane />
                      </div>
                    </Panel>
                  );
                  return sideColumnsSwapped ? (
                    <Fragment>
                      {sidePanel}
                      <AgentShellResizeHandle />
                      {centerPanel}
                      <AgentShellResizeHandle />
                      {railPanel}
                    </Fragment>
                  ) : (
                    <Fragment>
                      {railPanel}
                      <AgentShellResizeHandle />
                      {centerPanel}
                      <AgentShellResizeHandle />
                      {sidePanel}
                    </Fragment>
                  );
                })()}
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
          <VoiceSessionProvider>
            <AgentLayoutShell />
            <MobileShareIntake />
            <MobileNotificationRouting />
            <ExtensionsWorkspaceBridge />
          </VoiceSessionProvider>
        </AgentShellStateProvider>
      </EditorBridgeProvider>
    </WorkbenchContextMenuProvider>
  );
}
