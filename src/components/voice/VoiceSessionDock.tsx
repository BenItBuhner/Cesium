"use client";

/**
 * Minimized voice session dock: a compact live orb pill hovering above the
 * chat composer and action pills, so the user watches the agent's tasks and
 * verbatim messages in the normal thread while the voice session keeps
 * listening. Expand returns to the full-screen view; X ends the session.
 *
 * Entrance is orb-anchored: when the full-screen view minimizes, the pill
 * chrome fades in while the orb canvas FLIPs from the big orb's captured
 * rect, so the orb visually shrinks down into the pill (see
 * voice-orb-transition.ts).
 */

import { useLayoutEffect, useRef } from "react";
import { Maximize2, X } from "lucide-react";
import type { SessionOrbStatus } from "@/lib/voice/session-orb-renderer";
import { consumeVoiceOrbRect, flipOrbFromRect } from "./voice-orb-transition";
import { useVoiceSession } from "./VoiceSessionProvider";
import { VoiceSessionOrb } from "./VoiceSessionOrb";

const DOCK_STATUS_LABELS: Record<SessionOrbStatus, string> = {
  idle: "Voice agent",
  listening: "Listening",
  capturing: "Hearing you",
  transcribing: "Transcribing",
  sending: "Sending",
  working: "Agent working",
  speaking: "Speaking",
  error: "Mic unavailable",
};

export function VoiceSessionDock({
  wrapperClassName,
}: {
  /** Optional positioning wrapper rendered only while the dock is visible. */
  wrapperClassName?: string;
}) {
  const session = useVoiceSession();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const minimized = session.view === "minimized";

  // Orb handoff from the full-screen view: fly the pill's orb in from the
  // big orb's captured rect the moment this dock mounts.
  useLayoutEffect(() => {
    if (!minimized) return;
    const orbEl = rootRef.current?.querySelector<HTMLElement>(
      '[data-voice-orb="dock"]'
    );
    const source = consumeVoiceOrbRect("full");
    if (orbEl && source) {
      flipOrbFromRect(orbEl, source);
    }
  }, [minimized]);

  if (!minimized) {
    return null;
  }
  const lastEntry = session.transcript[session.transcript.length - 1];
  const micFailed = session.micState === "error";
  const secondaryText = micFailed
    ? session.micError ?? "Microphone unavailable - typing still works."
    : lastEntry?.text ?? null;
  const dock = (
    <div
      ref={rootRef}
      data-voice-session-dock
      className="pointer-events-auto relative flex max-w-[min(420px,calc(100%-24px))] items-center gap-[10px] py-[5px] pl-[6px] pr-[8px]"
    >
      {/* Pill chrome on its own fading layer so the orb above stays fully
          visible during the FLIP handoff. */}
      <div
        aria-hidden
        className="voice-surface-enter aurora-glass absolute inset-0 rounded-[var(--radius-pill)] border border-[var(--agent-border)] bg-[var(--agent-panel-bg)] shadow-lg"
      />
      <VoiceSessionOrb
        size={34}
        variant="dock"
        onClick={
          session.status === "speaking" ? session.interruptSpeech : session.expand
        }
        ariaLabel={
          session.status === "speaking" ? "Stop speaking" : "Expand voice agent"
        }
        className="relative shrink-0"
      />
      <div className="voice-chrome-enter relative flex min-w-0 flex-col">
        <span
          className={`truncate font-sans text-[12px] font-medium leading-[15px] ${
            micFailed
              ? "text-[var(--status-error,#e5484d)]"
              : "text-[var(--text-primary)]"
          }`}
        >
          {DOCK_STATUS_LABELS[session.status]}
        </span>
        {secondaryText ? (
          <span className="truncate font-sans text-[11px] leading-[14px] text-[var(--text-secondary)]">
            {secondaryText}
          </span>
        ) : null}
      </div>
      <div className="voice-chrome-enter relative ml-auto flex shrink-0 items-center gap-[2px]">
        <button
          type="button"
          data-voice-session-dock-expand
          onClick={session.expand}
          aria-label="Expand voice agent"
          title="Expand to full screen"
          className="flex size-[24px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
        >
          <Maximize2 className="size-[13px]" strokeWidth={1.6} />
        </button>
        <button
          type="button"
          data-voice-session-dock-end
          onClick={session.stop}
          aria-label="End voice session"
          title="End voice session"
          className="flex size-[24px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--status-error,#e5484d)]"
        >
          <X className="size-[14px]" strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
  if (!wrapperClassName) {
    return dock;
  }
  return <div className={wrapperClassName}>{dock}</div>;
}
