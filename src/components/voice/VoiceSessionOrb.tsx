"use client";

/**
 * Canvas host for the revamped session orb. Runs its own rAF loop, smooths
 * mic/TTS levels, and picks the level source from the session status
 * (TTS output while speaking, mic otherwise).
 */

import { useEffect, useRef } from "react";
import { drawSessionOrb } from "@/lib/voice/session-orb-renderer";
import { useVoiceSession } from "./VoiceSessionProvider";

export function VoiceSessionOrb({
  size,
  className,
  onClick,
  ariaLabel,
}: {
  /** CSS pixel diameter of the orb canvas. */
  size: number;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const { status, getOrbLevels } = useVoiceSession();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const smoothedLevelRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    // 30fps cap: painting at display rate doubles-to-quadruples the GPU cost
    // of an orb whose motion is already heavily smoothed.
    const frameIntervalMs = 1000 / 30;
    let last = 0;
    const render = (timeMs: number) => {
      frame = requestAnimationFrame(render);
      if (timeMs - last < frameIntervalMs) {
        return;
      }
      last = timeMs;
      const levels = getOrbLevels();
      const target =
        statusRef.current === "speaking" ? levels.tts : levels.mic;
      // Fast attack, slow release keeps the orb lively but not jittery.
      const previous = smoothedLevelRef.current;
      smoothedLevelRef.current =
        target > previous
          ? previous + (target - previous) * 0.5
          : previous + (target - previous) * 0.12;
      drawSessionOrb(ctx, size, {
        status: statusRef.current,
        level: smoothedLevelRef.current,
        timeMs,
      });
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [getOrbLevels, size]);

  const canvas = (
    <canvas
      ref={canvasRef}
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
