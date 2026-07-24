"use client";

/**
 * The small persistent voice pill: always mounted, outside ChatComposer.
 * Shows mode + live activity (mic level, thinking, speaking), toggles the
 * expanded panel, and offers an instant stop-speech control.
 */

import { Loader2, Mic, MicOff, Pause, Square } from "lucide-react";
import { useVoice, type VoiceActivity } from "./VoiceProvider";
import { VoicePanel } from "./VoicePanel";

const ACTIVITY_LABEL: Record<VoiceActivity, string> = {
  idle: "Idle",
  listening: "Listening",
  capturing: "Hearing you",
  transcribing: "Transcribing",
  thinking: "Thinking",
  speaking: "Speaking",
};

function ActivityDot({ activity }: { activity: VoiceActivity }) {
  const color =
    activity === "speaking"
      ? "bg-[var(--accent)]"
      : activity === "capturing"
        ? "bg-emerald-500"
        : activity === "thinking" || activity === "transcribing"
          ? "bg-amber-500"
          : activity === "listening"
            ? "bg-emerald-600/70"
            : "bg-[var(--text-disabled)]";
  const pulse =
    activity === "capturing" || activity === "speaking" ? "animate-pulse" : "";
  return <span className={`inline-block size-2 rounded-full ${color} ${pulse}`} />;
}

function LevelBars({ level }: { level: number }) {
  const bars = [0.2, 0.5, 0.8];
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {bars.map((threshold, index) => (
        <span
          key={index}
          className={`w-[3px] rounded-sm transition-all duration-100 ${
            level >= threshold ? "bg-emerald-500" : "bg-[var(--border-card)]"
          }`}
          style={{ height: `${5 + index * 3}px` }}
        />
      ))}
    </span>
  );
}

export function VoicePill() {
  const {
    mode,
    activity,
    micLevel,
    panelOpen,
    setPanelOpen,
    interrupt,
    queuedDigestCount,
  } = useVoice();

  const listening = mode === "active" || mode === "quiet";

  return (
    <>
      {panelOpen ? <VoicePanel /> : null}
      <div
        className="fixed bottom-4 right-4 z-[70] flex items-center gap-1"
        data-testid="voice-pill"
      >
        {activity === "speaking" ? (
          <button
            type="button"
            onClick={interrupt}
            title="Stop speaking"
            className="flex size-8 items-center justify-center rounded-full border border-[var(--border-card)] bg-[var(--bg-card)] text-[var(--text-secondary)] shadow-sm transition-colors hover:text-[var(--text-primary)]"
          >
            <Square className="size-3.5" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setPanelOpen(!panelOpen)}
          title="Live voice"
          className={`flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] shadow-sm transition-colors ${
            listening
              ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
              : "border-[var(--border-card)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {mode === "off" ? (
            <MicOff className="size-3.5" />
          ) : mode === "paused" ? (
            <Pause className="size-3.5" />
          ) : activity === "thinking" || activity === "transcribing" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Mic className="size-3.5" />
          )}
          {listening ? <LevelBars level={micLevel} /> : null}
          <ActivityDot activity={activity} />
          <span className="font-medium">
            {mode === "off"
              ? "Voice"
              : mode === "paused"
                ? "Paused"
                : mode === "quiet"
                  ? `Quiet · ${ACTIVITY_LABEL[activity]}`
                  : ACTIVITY_LABEL[activity]}
          </span>
          {queuedDigestCount > 0 ? (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-white">
              {queuedDigestCount}
            </span>
          ) : null}
        </button>
      </div>
    </>
  );
}
