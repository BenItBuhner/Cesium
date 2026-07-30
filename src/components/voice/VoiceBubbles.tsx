"use client";

/**
 * Transient caption bubbles anchored to the voice orb — the non-textual
 * replacement for a chat log. Bubbles fade in, live for a few seconds,
 * and stack toward the viewport center from wherever the orb sits.
 */

import { useVoice } from "./VoiceProvider";
import type { VoiceBubbleKind } from "@/lib/voice/orb-utils";

const KIND_STYLES: Record<VoiceBubbleKind, string> = {
  heard:
    "bg-[var(--accent-bg)] text-[var(--text-primary)] border border-transparent italic",
  assistant:
    "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-subtle)]",
  event:
    "bg-[var(--bg-card)] text-[var(--text-secondary)] border border-dashed border-[var(--border-card)]",
  system:
    "bg-transparent text-[var(--text-secondary)] border border-transparent italic",
  error: "bg-red-500/10 text-red-500 border border-red-500/30",
};

export function VoiceBubbles({
  anchor,
}: {
  anchor: { horizontal: "left" | "right"; vertical: "up" | "down" };
}) {
  const { bubbles, dismissBubble } = useVoice();
  if (bubbles.length === 0) return null;

  const ordered =
    anchor.vertical === "up" ? bubbles : [...bubbles].reverse();

  return (
    <div
      className={`absolute flex w-[300px] flex-col gap-1.5 ${
        anchor.vertical === "up" ? "bottom-full mb-2" : "top-full mt-2"
      } ${anchor.horizontal === "left" ? "right-0" : "left-0"}`}
      data-testid="voice-bubbles"
    >
      {ordered.map((bubble) => (
        <button
          key={bubble.id}
          type="button"
          onClick={() => dismissBubble(bubble.id)}
          title="Dismiss"
          className={`voice-bubble-enter max-w-full cursor-pointer whitespace-pre-wrap rounded-[10px] px-3 py-2 text-left text-[12.5px] leading-5 shadow-md backdrop-blur ${KIND_STYLES[bubble.kind]} ${
            anchor.horizontal === "left" ? "self-end" : "self-start"
          }`}
          data-voice-bubble-kind={bubble.kind}
        >
          {bubble.text}
          {bubble.meta ? (
            <span className="mt-0.5 block text-[10px] not-italic text-[var(--text-disabled)]">
              {bubble.meta}
            </span>
          ) : null}
        </button>
      ))}
      <style>{`
        .voice-bubble-enter { animation: voice-bubble-in 0.18s ease-out; }
        @keyframes voice-bubble-in {
          from { opacity: 0; transform: translateY(4px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
