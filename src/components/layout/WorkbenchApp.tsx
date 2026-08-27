"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { AgentConversationsProvider } from "@/components/chat/AgentConversationsContext";
import { OpenInEditorProvider } from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { VoiceOrb } from "@/components/voice/VoiceOrb";
import { VoiceProvider, useVoice } from "@/components/voice/VoiceProvider";
import { AgentLayout } from "@/components/layout/AgentLayout";
import { MobileBridgeSync } from "@/components/mobile/MobileBridgeSync";
import { DesktopNativeSync } from "@/components/desktop/DesktopNativeSync";
import { MobileBackController } from "@/components/mobile/MobileBackController";
import {
  BACK_INTENT_PRIORITY,
  BackIntentProvider,
  useBackHandler,
} from "@/components/mobile/BackIntentContext";
import { SettingsShellView } from "@/components/layout/SettingsShellView";
import { ShellViewProvider, useShellView } from "@/components/layout/ShellViewContext";

/** Peak inset of the Material predictive-back preview (scale at progress 1). */
const SETTINGS_BACK_MIN_SCALE = 0.9;
/** Peak horizontal shift (px) of the preview, in the swipe direction. */
const SETTINGS_BACK_MAX_SHIFT_PX = 24;
/** Peak corner radius (px) of the scaled-down preview surface. */
const SETTINGS_BACK_MAX_RADIUS_PX = 28;

function WorkbenchShell() {
  const { shellView, closeSettingsView } = useShellView();
  const settingsSurfaceRef = useRef<HTMLDivElement | null>(null);

  // Material-style predictive-back preview for the full-screen settings view:
  // as the Android back gesture progresses the surface scales down toward 90%,
  // nudges in the swipe direction and rounds its corners - committing closes
  // it, cancelling animates it back to rest. Styles are written imperatively
  // (no per-frame React re-render), mirroring the drawer motion engine.
  const applySettingsBackPreview = useCallback(
    (progress: number, swipeEdge: "left" | "right") => {
      const surface = settingsSurfaceRef.current;
      if (!surface) {
        return;
      }
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        return;
      }
      const clamped = Math.min(1, Math.max(0, progress));
      const scale = 1 - (1 - SETTINGS_BACK_MIN_SCALE) * clamped;
      const shift =
        (swipeEdge === "left" ? 1 : -1) * SETTINGS_BACK_MAX_SHIFT_PX * clamped;
      surface.style.transform = `translate3d(${shift}px, 0, 0) scale(${scale})`;
      surface.style.borderRadius = `${SETTINGS_BACK_MAX_RADIUS_PX * clamped}px`;
      surface.style.boxShadow =
        clamped > 0.01 ? "0 12px 48px rgba(0, 0, 0, 0.4)" : "";
    },
    []
  );

  // A back gesture in the full-screen settings view returns to the agent view
  // rather than exiting the app or walking WebView history.
  useBackHandler(
    shellView === "settings",
    BACK_INTENT_PRIORITY.settings,
    () => {
      closeSettingsView();
    },
    {
      onStart: (event) => {
        const surface = settingsSurfaceRef.current;
        if (surface) {
          surface.style.transition = "none";
        }
        applySettingsBackPreview(event.progress, event.swipeEdge);
      },
      onProgress: (event) =>
        applySettingsBackPreview(event.progress, event.swipeEdge),
      onCancel: () => {
        const surface = settingsSurfaceRef.current;
        if (!surface) {
          return;
        }
        surface.style.transition =
          "transform 200ms cubic-bezier(0.2, 0, 0, 1), border-radius 200ms cubic-bezier(0.2, 0, 0, 1), box-shadow 200ms cubic-bezier(0.2, 0, 0, 1)";
        surface.style.transform = "";
        surface.style.borderRadius = "";
        surface.style.boxShadow = "";
      },
    }
  );
  if (shellView === "settings") {
    return (
      <div
        ref={settingsSurfaceRef}
        className="h-screen w-screen overflow-hidden bg-[var(--bg-main)] will-change-transform"
      >
        <SettingsShellView />
      </div>
    );
  }
  return <AgentLayout />;
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
          <WorkbenchShell />
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
