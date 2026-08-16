"use client";

/**
 * Minimized voice session dock: a compact live orb pill hovering above the
 * chat composer and action pills, so the user watches the agent's tasks and
 * verbatim messages in the normal thread while the voice session keeps
 * listening. Expand returns to the full-screen view; X ends the session.
 */

import { Maximize2, X } from "lucide-react";
import type { SessionOrbStatus } from "@/lib/voice/session-orb-renderer";
import { useVoiceSession } from "./VoiceSessionProvider";
import { VoiceSessionOrb } from "./VoiceSessionOrb";

const DOCK_STATUS_LABELS: Record<SessionOrbStatus, string> = {
  idle: "Voice agent",
  listening: "Listening",
  capturing: "Hearing you",
  transcribing: "Transcribing",
  sending: "Sending",
  speaking: "Speaking",
};

export function VoiceSessionDock({
  wrapperClassName,
}: {
  /** Optional positioning wrapper rendered only while the dock is visible. */
  wrapperClassName?: string;
}) {
  const session = useVoiceSession();
  if (session.view !== "minimized") {
    return null;
  }
  const lastEntry = session.transcript[session.transcript.length - 1];
  const dock = (
    <div
      data-voice-session-dock
      className="pointer-events-auto aurora-glass flex max-w-[min(420px,calc(100%-24px))] items-center gap-[10px] rounded-[var(--radius-pill)] border border-[var(--agent-border)] bg-[var(--agent-panel-bg)] py-[5px] pl-[6px] pr-[8px] shadow-lg"
    >
      <VoiceSessionOrb
        size={34}
        onClick={
          session.status === "speaking" ? session.interruptSpeech : session.expand
        }
        ariaLabel={
          session.status === "speaking" ? "Stop speaking" : "Expand voice agent"
        }
        className="shrink-0"
      />
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-sans text-[12px] font-medium leading-[15px] text-[var(--text-primary)]">
          {DOCK_STATUS_LABELS[session.status]}
        </span>
        {lastEntry ? (
          <span className="truncate font-sans text-[11px] leading-[14px] text-[var(--text-secondary)]">
            {lastEntry.text}
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-[2px]">
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
