"use client";

/**
 * Canvas host for the session orb. Runs its own rAF loop and feeds raw
 * mic/TTS levels to a stateful `SessionOrbAnimator`, which owns level
 * smoothing, theme crossfades, and speech ripples.
 *
 * Frame budget is adaptive: the small docked orb stays capped at 30fps
 * (painting a heavily-smoothed 34px orb at display rate just burns GPU),
 * while the full-screen centerpiece runs at 60fps so audio-reactive motion
 * reads crisply. `prefers-reduced-motion` forces the low rate and a calmer
 * animation everywhere.
 */

import { useEffect, useRef } from "react";
import { SessionOrbAnimator } from "@/lib/voice/session-orb-renderer";
import { useVoiceSession } from "./VoiceSessionProvider";

/** CSS diameter at/above which the orb is treated as a full-view centerpiece. */
const HIGH_FPS_MIN_SIZE = 120;

export function VoiceSessionOrb({
  size,
  className,
  onClick,
  ariaLabel,
  variant = "full",
}: {
  /** CSS pixel diameter of the orb canvas. */
  size: number;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
  /** Marks the canvas for view transitions (full-screen vs docked pill). */
  variant?: "full" | "dock";
}) {
  const { status, getOrbLevels } = useVoiceSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const frameIntervalMs =
      !reducedMotion && size >= HIGH_FPS_MIN_SIZE ? 1000 / 60 : 1000 / 30;

    const animator = new SessionOrbAnimator();
    let frame = 0;
    let last = 0;
    const render = (timeMs: number) => {
      frame = requestAnimationFrame(render);
      // -1ms slack: rAF timestamps jitter slightly below the nominal
      // interval, and a strict comparison would halve the effective rate.
      if (timeMs - last < frameIntervalMs - 1) {
        return;
      }
      last = timeMs;
      const levels = getOrbLevels();
      animator.draw(ctx, size, {
        status: statusRef.current,
        micLevel: levels.mic,
        ttsLevel: levels.tts,
        timeMs,
        reducedMotion,
      });
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [getOrbLevels, size]);

  const canvas = (
    <canvas
      ref={canvasRef}
      data-voice-orb={variant}
      style={{ width: size, height: size }}
      className={onClick ? undefined : className}
      aria-hidden
    />
  );

  if (!onClick) {
    return canvas;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? "Voice agent orb"}
      className={`rounded-full outline-none transition-transform hover:scale-[1.02] active:scale-[0.98] ${className ?? ""}`}
    >
      {canvas}
    </button>
  );
}
