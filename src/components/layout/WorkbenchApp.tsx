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
import { AgentConversationsProvider } from "@/components/chat/AgentConversationsContext";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceProvider, useVoice } from "@/components/voice/VoiceProvider";
import { AuroraSceneProvider } from "@/components/agent/AuroraSceneContext";
import { AuroraShellBackdrop } from "@/components/agent/AuroraBackdrop";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { MobileBridgeSync } from "@/components/mobile/MobileBridgeSync";
import { WorkbenchDialogProvider } from "@/components/dialogs/WorkbenchDialogProvider";
import { DesktopNativeSync } from "@/components/desktop/DesktopNativeSync";
import { MobileBackController } from "@/components/mobile/MobileBackController";
import {
  BACK_INTENT_PRIORITY,
  BackIntentProvider,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { DrawerMotion, prefersReducedMotion } from "@/components/mobile/drawer-motion";
import { hasMobileBridge } from "@/lib/mobile-bridge";
import {
  SETTINGS_BACK_MIN_COMMIT_VELOCITY,
  estimateGestureVelocity,
  gestureProgressToDeparture,
  settingsBackDirection,
  settingsBackFrame,
  type SettingsBackDirection,
  type SettingsBackGestureSample,
} from "@/lib/settings-back-motion";
import { SettingsShellView } from "@/components/layout/SettingsShellView";
import { ShellUnderlayProvider } from "@/components/layout/ShellUnderlayContext";
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
  const surfaceBackdropRef = useRef<HTMLDivElement | null>(null);

  // Predictive-back reveal for the full-screen settings view. Only the native
  // mobile shell delivers back-gesture streams, so only there does the agent
  // view stay mounted (hidden) beneath settings - pre-warmed, so a gesture
  // reveals it with a compositor-level visibility flip instead of a janky
  // mid-gesture React mount. Elsewhere the old exclusive swap is kept: no
  // hidden tree, no cost. Enabled post-mount so server and first client
  // render agree (the bridge global exists before any page script runs).
  const [layered, setLayered] = useState(false);
  const layeredRef = useRef(layered);
  layeredRef.current = layered;
  useEffect(() => {
    setLayered(hasMobileBridge());
  }, []);

  /** Slide direction of the in-flight gesture (finger travel). */
  const directionRef = useRef<SettingsBackDirection>(1);
  /** True between a gesture's start and its cancel/commit resolution. */
  const gestureSessionRef = useRef(false);
  /** True while the committed exit animation runs (extra backs are swallowed). */
  const exitingRef = useRef(false);
  /** Recent (time, departure) samples for seeding the springs with finger velocity. */
  const samplesRef = useRef<SettingsBackGestureSample[]>([]);

  // The settings surface travels with the finger nearly 1:1 (picking up a
  // slight scale-down, corner radius, and shadow for depth) while the agent
  // view beneath slides into place with a parallax offset, scaling up behind
  // a clearing scrim - the cross-surface motion Android uses between
  // activities. The aurora-mode surface is a translucent window, so during
  // the first stretch of the pull an opaque backdrop fades in behind its
  // content (the surface lifts off as a solid card) while the reveal layers
  // fade in beneath - nothing ever pops through the translucency. Frames are
  // written imperatively (no per-frame React re-render) through the drawers'
  // shared spring engine. Commit springs the surface past the viewport edge
  // (115% travel) seeded with the finger's own velocity, so the visible exit
  // finishes at speed instead of stalling at the edge; cancel springs
  // everything back (fading the backdrop and reveal layers back out).
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
    const backdrop = surfaceBackdropRef.current;
    if (backdrop) {
      backdrop.style.opacity = String(frame.surfaceBackdropAlpha);
    }
    const underlay = agentHostRef.current;
    if (underlay && showSettingsRef.current) {
      underlay.style.transform = `translate3d(${frame.underlayTranslateXPct}%, 0, 0) scale(${frame.underlayScale})`;
      underlay.style.opacity = String(frame.previewOpacity);
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = String(frame.scrimOpacity);
    }
  }, []);

  /**
   * Compositor-layer promotion for the moving planes, applied only while the
   * motion is live: a parked `will-change: transform` makes the settings nav
   * drawer's backdrop-filter sample an empty promoted layer, so the page
   * punches through the frost as sharp text.
   */
  const setMotionLayerPromotion = useCallback((active: boolean) => {
    const value = active ? "transform" : "";
    const surface = settingsSurfaceRef.current;
    if (surface) {
      surface.style.willChange = value;
    }
    const underlay = agentHostRef.current;
    if (underlay) {
      underlay.style.willChange = value;
    }
  }, []);

  /**
   * Shows/hides the reveal layers (agent underlay + scrim). Hidden at rest so
   * nothing shows through the translucent settings surface; revealed for the
   * duration of a gesture / exit animation. `visibility` keeps layout warm,
   * so flipping it never re-runs the agent tree.
   */
  const setPreviewVisible = useCallback((visible: boolean) => {
    const underlay = agentHostRef.current;
    if (underlay) {
      underlay.style.visibility = visible ? "" : "hidden";
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.visibility = visible ? "" : "hidden";
    }
  }, []);

  /** Returns the revealed agent view to its resting (live) styling. */
  const clearUnderlayStyles = useCallback(() => {
    const underlay = agentHostRef.current;
    if (underlay) {
      underlay.style.transform = "";
      underlay.style.opacity = "";
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
    const backdrop = surfaceBackdropRef.current;
    if (backdrop) {
      backdrop.style.opacity = "0";
    }
  }, []);

  const motionRef = useRef<DrawerMotion | null>(null);
  if (motionRef.current == null) {
    motionRef.current = new DrawerMotion(0, applyFrame, (departure) => {
      if (departure >= 1) {
        // Committed exit: the surface has fully cleared the viewport (left
        // off-screen until the view flip unmounts it) and the underlay
        // beneath becomes the live agent view. Its React position is stable
        // across the flip, so no remount happens.
        exitingRef.current = false;
        clearUnderlayStyles();
        setMotionLayerPromotion(false);
        const underlay = agentHostRef.current;
        if (underlay) {
          underlay.style.visibility = "";
        }
        closeSettingsViewRef.current();
      } else if (departure <= 0) {
        // Cancelled gesture settled back to rest: hide the preview again.
        clearUnderlayStyles();
        clearSurfaceStyles();
        setMotionLayerPromotion(false);
        setPreviewVisible(false);
      }
    });
  }

  // Whenever settings is (re)opened - or the layered shell finishes booting
  // while settings is already up - start from a clean slate: motion at rest,
  // preview hidden before anything can paint through the translucent surface.
  // When settings closes by any path (gesture commit, the close button,
  // programmatic view switches), the agent host must come back to live
  // styling - in particular its `visibility`, which was hidden while it was
  // the underlay.
  useLayoutEffect(() => {
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
    setMotionLayerPromotion(false);
    if (showSettings) {
      setPreviewVisible(false);
    } else {
      const underlay = agentHostRef.current;
      if (underlay) {
        underlay.style.visibility = "";
      }
    }
  }, [
    showSettings,
    layered,
    clearSurfaceStyles,
    clearUnderlayStyles,
    setMotionLayerPromotion,
    setPreviewVisible,
  ]);

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
      const hadGesture = gestureSessionRef.current;
      gestureSessionRef.current = false;
      if (!layeredRef.current || !settingsSurfaceRef.current || prefersReducedMotion()) {
        closeSettingsView();
        return true;
      }
      if (!hadGesture) {
        // Discrete back (no preceding gesture): don't inherit a stale slide
        // direction from an earlier gesture - use the default rightward exit.
        directionRef.current = settingsBackDirection(undefined);
      }
      exitingRef.current = true;
      const motion = motionRef.current;
      if (motion) {
        // The fling continues at the finger's own speed (with a decisive
        // floor so slow lifts and button backs never crawl off-screen).
        const velocity = Math.max(
          SETTINGS_BACK_MIN_COMMIT_VELOCITY,
          hadGesture ? estimateGestureVelocity(samplesRef.current) : 0
        );
        setMotionLayerPromotion(true);
        applyFrame(motion.progress);
        setPreviewVisible(true);
        motion.springTo(1, velocity);
      }
      return true;
    },
    {
      onStart: (event) => {
        if (exitingRef.current) {
          return;
        }
        gestureSessionRef.current = true;
        directionRef.current = settingsBackDirection(event.swipeEdge);
        const departure = gestureProgressToDeparture(event.progress);
        samplesRef.current = [{ timeMs: performance.now(), departure }];
        if (!layeredRef.current || prefersReducedMotion()) {
          return;
        }
        const motion = motionRef.current;
        if (motion) {
          setMotionLayerPromotion(true);
          motion.beginDrag();
          motion.dragTo(departure, 0);
        }
        setPreviewVisible(true);
      },
      onProgress: (event) => {
        if (exitingRef.current || !gestureSessionRef.current) {
          return;
        }
        const departure = gestureProgressToDeparture(event.progress);
        const samples = samplesRef.current;
        samples.push({ timeMs: performance.now(), departure });
        if (samples.length > 6) {
          samples.shift();
        }
        if (!layeredRef.current || prefersReducedMotion()) {
          return;
        }
        motionRef.current?.dragTo(departure, 0);
      },
      onCancel: () => {
        if (exitingRef.current) {
          return;
        }
        gestureSessionRef.current = false;
        if (!layeredRef.current) {
          return;
        }
        // Seed the return spring with the finger's speed when it was already
        // heading back; never with outward velocity.
        const velocity = Math.min(0, estimateGestureVelocity(samplesRef.current));
        motionRef.current?.springTo(0, velocity);
      },
    }
  );

  // The agent view keeps one stable child position whether it is the live
  // shell or the hidden reveal layer beneath settings, so a committed back
  // hands the very DOM the gesture revealed over to the live view - no
  // remount, no flash. No layer carries a parked `will-change` (that would
  // make the settings nav drawer's backdrop-filter sample an empty promoted
  // layer); promotion happens imperatively only while the motion runs.
  const agentMounted = !showSettings || layered;
  return (
    <>
      {agentMounted ? (
        <div
          ref={agentHostRef}
          inert={showSettings || undefined}
          aria-hidden={showSettings || undefined}
          className={`relative z-[1] h-full w-full ${
            showSettings ? "pointer-events-none" : ""
          }`}
        >
          <ShellUnderlayProvider value={showSettings}>
            <AgentLayout />
          </ShellUnderlayProvider>
        </div>
      ) : null}
      {showSettings ? (
        <>
          {layered ? (
            <div
              ref={scrimRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[2] bg-[var(--palette-backdrop)]"
              style={{ opacity: 0, visibility: "hidden" }}
            />
          ) : null}
          <div
            ref={settingsSurfaceRef}
            className="aurora-settings-shell absolute inset-0 z-[3] overflow-hidden"
          >
            {/* Fades to opaque during the back motion so the translucent
                aurora surface stops transmitting the reveal layers beneath -
                the surface lifts off as a solid card instead of ghosting. */}
            <div
              ref={surfaceBackdropRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 bg-[var(--bg-main)]"
              style={{ opacity: 0 }}
            />
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
        {/* Settings nav drawer portals here so backdrop-filter can sample
            the settings surface as a sibling, matching the agent rail. */}
        <div id="cesium-overlay-drawer-root" />
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
        {/* Under BackIntentProvider so Android back cancels the active dialog. */}
        <WorkbenchDialogProvider>
          <ShellViewProvider>
            <WorkbenchWithConversationProviders />
          </ShellViewProvider>
        </WorkbenchDialogProvider>
      </BackIntentProvider>
    </Suspense>
  );
}
