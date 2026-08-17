"use client";

/**
 * Compact icon menu for the orb (long-press / right-click): voice mode
 * switching, stop-speech, the pipeline self-test, and a one-line pipeline
 * status. Icons over text — the voice plane is not a chat surface.
 */

import { useEffect, useRef } from "react";
import {
  EyeOff,
  FlaskConical,
  Loader2,
  Mic,
  Pause,
  Power,
  Square,
  VolumeX,
} from "lucide-react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useVoice, type VoiceMode } from "./VoiceProvider";

const MODE_BUTTONS: Array<{
  id: VoiceMode;
  label: string;
  hint: string;
  icon: typeof Mic;
}> = [
  { id: "active", label: "Active", hint: "Listen, act, speak", icon: Mic },
  { id: "quiet", label: "Quiet", hint: "Listen and act, never speak", icon: VolumeX },
  { id: "paused", label: "Paused", hint: "Mic off; nothing interpreted", icon: Pause },
  { id: "off", label: "Off", hint: "Voice plane disabled", icon: Power },
];

export function VoiceOrbMenu({
  anchor,
  onClose,
}: {
  anchor: { horizontal: "left" | "right"; vertical: "up" | "down" };
  onClose: () => void;
}) {
  const {
    mode,
    setMode,
    activity,
    interrupt,
    runSelfTest,
    selfTestRunning,
    serverStatus,
    vadEngineId,
    latencyP50Ms,
    memory,
    error,
  } = useVoice();
  const { updateSettings } = useGlobalSettings();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const hideOrb = () => {
    // Turn the voice plane off before removing its only visible indicator.
    setMode("off");
    updateSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        showVoiceOrb: false,
      },
    }));
    onClose();
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const ttsEngine =
    serverStatus?.tts.defaultEngine ??
    serverStatus?.tts.engines.find((engine) => engine.available)?.id ??
    "none";

  return (
    <div
      ref={rootRef}
      className={`absolute z-[81] w-[228px] rounded-[12px] border border-[var(--border-card)] bg-[var(--bg-panel)] p-2 shadow-xl ${
        anchor.vertical === "up" ? "bottom-0" : "top-0"
      } ${anchor.horizontal === "left" ? "right-full mr-2" : "left-full ml-2"}`}
      data-testid="voice-orb-menu"
    >
      <div className="flex gap-1">
        {MODE_BUTTONS.map((entry) => {
          const Icon = entry.icon;
          const selected = mode === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              title={`${entry.label} — ${entry.hint}`}
              onClick={() => setMode(entry.id)}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-[8px] px-1 py-1.5 transition-colors ${
                selected
                  ? "bg-[var(--accent-bg)] text-[var(--text-primary)] ring-1 ring-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
              }`}
              data-testid={`voice-mode-${entry.id}`}
            >
              <Icon className="size-3.5" />
              <span className="text-[9px] font-medium">{entry.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 flex gap-1 border-t border-[var(--border-subtle)] pt-1.5">
        <button
          type="button"
          disabled={activity !== "speaking"}
          onClick={interrupt}
          title="Stop speaking"
          className="flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] py-1.5 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-35"
        >
          <Square className="size-3" fill="currentColor" /> Stop
        </button>
        <button
          type="button"
          disabled={selfTestRunning}
          onClick={() => void runSelfTest()}
          title="Pipeline self-test: synthesize a spoken utterance and run it through VAD, endpointing, STT, and the controller as if spoken"
          className="flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] py-1.5 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-35"
          data-testid="voice-self-test"
        >
          {selfTestRunning ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <FlaskConical className="size-3" />
          )}
          Self-test
        </button>
        <button
          type="button"
          onClick={hideOrb}
          title="Hide the voice orb (re-enable in Settings → General → Voice)"
          className="flex flex-1 items-center justify-center gap-1 rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-card)] py-1.5 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          data-testid="voice-orb-hide"
        >
          <EyeOff className="size-3" />
          Hide
        </button>
      </div>

      <div className="mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 font-mono text-[9px] leading-4 text-[var(--text-disabled)]">
        <div>
          {serverStatus?.controller.model ?? "?"} · {ttsEngine} ·{" "}
          {serverStatus?.stt.model ?? "?"} · vad {vadEngineId ?? "—"}
        </div>
        <div>
          {latencyP50Ms !== null ? `p50 ${latencyP50Ms}ms · ` : ""}
          mem {memory.turns} turn{memory.turns === 1 ? "" : "s"}
          {memory.compactions > 0
            ? ` · ${memory.compactions} compaction${memory.compactions === 1 ? "" : "s"}`
            : ""}
        </div>
        {error ? <div className="text-[var(--status-error)]">{error}</div> : null}
      </div>
    </div>
  );
}
