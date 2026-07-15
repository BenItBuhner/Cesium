"use client";

import { useEffect, useState } from "react";
import { computeRetryCountdownProgress } from "@/lib/agent-completion-error";

const btnBase =
  "relative inline-flex min-h-[32px] shrink-0 items-center justify-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--plan-accent)] px-[14px] py-[6px] font-sans text-[11px] font-medium leading-none text-[var(--bg-panel)] outline-none ring-0 transition-opacity duration-150 ease-out hover:opacity-90 focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none";

type RetryCountdownButtonProps = {
  delayMs: number;
  retriesRemaining: number;
  active: boolean;
  busy?: boolean;
  onManualFire: () => void;
};

export function RetryCountdownButton({
  delayMs,
  retriesRemaining,
  active,
  busy = false,
  onManualFire,
}: RetryCountdownButtonProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!active || busy) {
      setProgress(0);
      return;
    }

    let rafId = 0;
    const generation = Symbol("retry-countdown");
    let currentGeneration: symbol | null = generation;
    const started = performance.now();

    const tick = (now: number) => {
      if (currentGeneration !== generation) {
        return;
      }
      const elapsed = now - started;
      const nextProgress = computeRetryCountdownProgress(elapsed, delayMs);
      setProgress(nextProgress);
      if (nextProgress >= 1) {
        currentGeneration = null;
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      currentGeneration = null;
      window.cancelAnimationFrame(rafId);
    };
  }, [active, busy, delayMs]);

  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);
  const attemptsRemaining = Math.max(0, retriesRemaining);
  const secondsRemaining = Math.max(
    1,
    Math.ceil(((1 - progress) * delayMs) / 1000)
  );
  return (
    <button
      type="button"
      className={btnBase}
      disabled={busy}
      aria-label={
        active
          ? `Retry automatically in ${secondsRemaining} seconds, ${attemptsRemaining} auto attempts left`
          : `Retry${attemptsRemaining > 0 ? `, ${attemptsRemaining} auto attempts left` : ""}`
      }
      onClick={() => {
        onManualFire();
      }}
    >
      <svg
        className="size-[18px] shrink-0 -rotate-90"
        viewBox="0 0 18 18"
        aria-hidden
      >
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth="2"
        />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={active ? dashOffset : circumference}
          strokeLinecap="round"
          className="motion-reduce:transition-none"
        />
        <text
          x="9"
          y="9"
          textAnchor="middle"
          dominantBaseline="central"
          className="rotate-90 fill-current font-mono text-[8px] font-medium"
          style={{ transformOrigin: "9px 9px" }}
        >
          {attemptsRemaining}
        </text>
      </svg>
      {busy ? "Retrying…" : active ? "Retry now" : "Retry"}
    </button>
  );
}
