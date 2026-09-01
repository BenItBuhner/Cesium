"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { AgentConversationsProvider } from "@/components/chat/AgentConversationsContext";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceProvider, useVoice } from "@/components/voice/VoiceProvider";
import { AuroraSceneProvider } from "@/components/agent/AuroraSceneContext";
import { AuroraShellBackdrop } from "@/components/agent/AuroraBackdrop";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { MobileBridgeSync } from "@/components/mobile/MobileBridgeSync";
import { DesktopNativeSync } from "@/components/desktop/DesktopNativeSync";
import { MobileBackController } from "@/components/mobile/MobileBackController";
import {
  BACK_INTENT_PRIORITY,
  BackIntentProvider,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { DrawerMotion, prefersReducedMotion } from "@/components/mobile/drawer-motion";
import {
  gestureProgressToDeparture,
  settingsBackDirection,
  settingsBackFrame,
  type SettingsBackDirection,
} from "@/lib/settings-back-motion";
import { SettingsShellView } from "@/components/layout/SettingsShellView";
import { ShellViewProvider, useShellView } from "@/components/layout/ShellViewContext";

function WorkbenchShell() {
  const { shellView, closeSettingsView } = useShellView();
  const showSettings = shellView === "settings";
  const showSettingsRef = useRef(showSettings);
  showSettingsRef.current = showSettings;
  const closeSettingsViewRef = useRef(closeSettingsView);
  closeSettingsViewRef.current = closeSettingsView;

  const agentHostRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const settingsSurfaceRef = useRef<HTMLDivElement | null>(null);

  // Predictive-back reveal for the full-screen settings view: the agent view
  // mounts beneath settings only for the duration of a back gesture / exit
  // animation, so the gesture genuinely previews the content it returns to.
  // It stays unmounted at rest because the agent tree attaches document-level
  // key listeners (IDEKeyboardLayer) that must not run twice, and because the
  // settings surface is a translucent window over the shared aurora canvas.
  const [underlayMounted, setUnderlayMounted] = useState(false);
  const underlayMountedRef = useRef(underlayMounted);
  underlayMountedRef.current = underlayMounted;

  /** Slide direction of the in-flight gesture (finger travel). */
  const directionRef = useRef<SettingsBackDirection>(1);
  /** True between a gesture's start and its cancel/commit resolution. */
  const gestureSessionRef = useRef(false);
  /** True while the committed exit animation runs (extra backs are swallowed). */
  const exitingRef = useRef(false);

  // The settings surface slides away with the finger (picking up a slight
  // scale-down, corner radius, and shadow for depth) while the agent view
  // beneath scales up from 96% behind a clearing scrim - the same
  // cross-surface motion Android uses between activities. Frames are written
  // imperatively (no per-frame React re-render) through the drawers' shared
  // spring engine, so commit flings the surface off-screen and cancel springs
  // it back with the exact physics of the rail/pane drawers.
  const applyFrame = useCallback((departure: number) => {
    const frame = settingsBackFrame(departure, directionRef.current);
    const surface = settingsSurfaceRef.current;
    if (surface) {
      surface.style.transform = `translate3d(${frame.surfaceTranslateXPct}%, 0, 0) scale(${frame.surfaceScale})`;
      surface.style.borderRadius = `${frame.surfaceRadiusPx}px`;
      surface.style.boxShadow =
        frame.surfaceShadowAlpha > 0
          ? `0 12px 48px rgba(0, 0, 0, ${frame.surfaceShadowAlpha.toFixed(3)})`
          : "";
    }
    const underlay = agentHostRef.current;
    if (underlay && showSettingsRef.current) {
      underlay.style.transform = `scale(${frame.underlayScale})`;
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = String(frame.scrimOpacity);
    }
  }, []);

  /** Returns the revealed agent view to its resting (live) styling. */
  const clearUnderlayStyles = useCallback(() => {
    const underlay = agentHostRef.current;
    if (underlay) {
      underlay.style.transform = "";
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = "";
    }
  }, []);

  const clearSurfaceStyles = useCallback(() => {
    const surface = settingsSurfaceRef.current;
    if (surface) {
      surface.style.transform = "";
      surface.style.borderRadius = "";
      surface.style.boxShadow = "";
    }
  }, []);

  const motionRef = useRef<DrawerMotion | null>(null);
  if (motionRef.current == null) {
    motionRef.current = new DrawerMotion(0, applyFrame, (departure) => {
      if (departure >= 1) {
        // Committed exit: the surface is fully off-screen (left there until
        // the view flip unmounts it) and the underlay beneath becomes the
        // live agent view. Its React position is stable across the flip, so
        // no remount happens.
        exitingRef.current = false;
        clearUnderlayStyles();
        closeSettingsViewRef.current();
      } else if (departure <= 0) {
        // Cancelled gesture settled back to rest: drop the preview layer.
        clearUnderlayStyles();
        clearSurfaceStyles();
        setUnderlayMounted(false);
      }
    });
  }

  // Opening settings starts from a clean slate: no preview layer beneath.
  // `underlayMounted` is intentionally kept across a committed exit's view
  // flip (so the agent host never unmounts in the same breath it becomes the
  // live view); retire it during render when settings opens again, before
  // anything stale can paint behind the translucent settings surface.
  const [prevShowSettings, setPrevShowSettings] = useState(showSettings);
  if (showSettings !== prevShowSettings) {
    setPrevShowSettings(showSettings);
    if (showSettings) {
      setUnderlayMounted(false);
    }
  }

  // ... and reset the motion engine itself once the settings surface exists.
  useEffect(() => {
    if (!showSettings) {
      return;
    }
    const motion = motionRef.current;
    if (motion) {
      motion.cancel();
      motion.progress = 0;
      motion.velocity = 0;
    }
    exitingRef.current = false;
    gestureSessionRef.current = false;
    clearUnderlayStyles();
    clearSurfaceStyles();
  }, [showSettings, clearSurfaceStyles, clearUnderlayStyles]);

  // A freshly mounted preview layer must carry the current frame before it
  // first paints (mirrors the drawer shell's re-mount style application).
  useLayoutEffect(() => {
    if (!underlayMounted || !showSettings) {
      return;
    }
    applyFrame(motionRef.current?.progress ?? 0);
  }, [underlayMounted, showSettings, applyFrame]);

  // A back gesture in the full-screen settings view returns to the agent view
  // rather than exiting the app or walking WebView history. The discrete back
  // paths (3-button navigation, pre-Android-14) skip the gesture hooks and
  // run the same slide-away exit from rest.
  useBackHandler(
    showSettings,
    BACK_INTENT_PRIORITY.settings,
    () => {
      if (!showSettingsRef.current || exitingRef.current) {
        // A stray commit after the view already flipped, or while the exit
        // animation is in flight: swallow it.
        return true;
      }
      if (!settingsSurfaceRef.current || prefersReducedMotion()) {
        closeSettingsView();
        return true;
      }
      if (!gestureSessionRef.current) {
        // Discrete back (no preceding gesture): don't inherit a stale slide
        // direction from an earlier gesture - use the default rightward exit.
        directionRef.current = settingsBackDirection(undefined);
      }
      gestureSessionRef.current = false;
      exitingRef.current = true;
      if (!underlayMountedRef.current) {
        // Discrete back with no preceding gesture: the reveal layer must
        // exist before the first spring frame lands.
        flushSync(() => setUnderlayMounted(true));
      }
      motionRef.current?.springTo(1);
      return true;
    },
    {
      onStart: (event) => {
        if (exitingRef.current) {
          return;
        }
        gestureSessionRef.current = true;
        directionRef.current = settingsBackDirection(event.swipeEdge);
        if (prefersReducedMotion()) {
          return;
        }
        setUnderlayMounted(true);
        const motion = motionRef.current;
        if (motion) {
          motion.beginDrag();
          motion.dragTo(gestureProgressToDeparture(event.progress), 0);
        }
      },
      onProgress: (event) => {
        if (exitingRef.current || prefersReducedMotion()) {
          return;
        }
        motionRef.current?.dragTo(gestureProgressToDeparture(event.progress), 0);
      },
      onCancel: () => {
        if (exitingRef.current) {
          return;
        }
        gestureSessionRef.current = false;
        motionRef.current?.springTo(0);
      },
    }
  );

  // The agent view keeps one stable child position whether it is the live
  // shell or the gesture's reveal layer, so a committed back hands the very
  // DOM the gesture revealed over to the live view - no remount, no flash.
  const agentMounted = !showSettings || underlayMounted;
  return (
    <>
      {agentMounted ? (
        <div
          ref={agentHostRef}
          inert={showSettings || undefined}
          aria-hidden={showSettings || undefined}
          className={`relative z-[1] h-full w-full ${
            showSettings ? "pointer-events-none will-change-transform" : ""
          }`}
        >
          <AgentLayout />
        </div>
      ) : null}
      {showSettings ? (
        <>
          {underlayMounted ? (
            <div
              ref={scrimRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[2] bg-[var(--palette-backdrop)]"
              style={{ opacity: 1 }}
            />
          ) : null}
          <div
            ref={settingsSurfaceRef}
            className="aurora-settings-shell absolute inset-0 z-[3] overflow-hidden will-change-transform"
          >
            <SettingsShellView />
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * One window-sized aurora canvas that outlives the agent <-> settings swap.
 * Settings and the agent shell both sit on top as translucent windows so the
 * same backdrop keeps drifting instead of going black the moment settings
 * opens.
 */
function WorkbenchAuroraHost({ children }: { children: ReactNode }) {
  const { settings } = useGlobalSettings();
  const auroraEnabled = settings.aurora.enabled;
  return (
    <AuroraSceneProvider>
      <div
        className="relative isolate h-screen w-screen overflow-hidden bg-[var(--bg-main)]"
        data-aurora-scene={auroraEnabled ? "on" : undefined}
        data-aurora-surface={auroraEnabled ? "on" : undefined}
      >
        <AuroraShellBackdrop />
        {children}
      </div>
    </AuroraSceneProvider>
  );
}

/**
 * Mounts the ambient voice orb only when enabled in Settings → General → Voice.
 * Hiding the orb also forces the voice plane off so the mic never keeps
 * listening without a visible indicator.
 */
function VoiceOrbGate() {
  const { settings } = useGlobalSettings();
  const { mode, setMode } = useVoice();
  const showVoiceOrb = settings.general.showVoiceOrb;

  useEffect(() => {
    if (!showVoiceOrb && mode !== "off") {
      setMode("off");
    }
  }, [showVoiceOrb, mode, setMode]);

  if (!showVoiceOrb) {
    return null;
  }
  return <VoiceOrb />;
}

function WorkbenchWithConversationProviders() {
  return (
    <OpenInEditorProvider>
      <AgentConversationsProvider>
        <VoiceProvider>
          <MobileBridgeSync />
          <DesktopNativeSync />
          <MobileBackController />
          <WorkbenchAuroraHost>
            <WorkbenchShell />
          </WorkbenchAuroraHost>
          <VoiceOrbGate />
        </VoiceProvider>
      </AgentConversationsProvider>
    </OpenInEditorProvider>
  );
}

function LoadingFallback() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
      Loading agent...
    </div>
  );
}

export function WorkbenchApp({
  suspenseFallback,
}: {
  /** Optional; defaults to the same copy as WorkspaceProvider shell. */
  suspenseFallback?: ReactNode;
}) {
  return (
    <Suspense fallback={suspenseFallback ?? <LoadingFallback />}>
      <BackIntentProvider>
        <ShellViewProvider>
          <WorkbenchWithConversationProviders />
        </ShellViewProvider>
      </BackIntentProvider>
    </Suspense>
  );
}
