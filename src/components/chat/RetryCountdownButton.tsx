"use client";

import { useEffect, useRef, useState } from "react";

const btnBase =
  "relative inline-flex min-h-[32px] shrink-0 items-center justify-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] py-[5px] font-sans text-[12px] font-normal leading-none text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-45";

type RetryCountdownButtonProps = {
  delayMs: number;
  active: boolean;
  busy?: boolean;
  onFire: () => void;
  onCancelCountdown?: () => void;
};

export function RetryCountdownButton({
  delayMs,
  active,
  busy = false,
  onFire,
  onCancelCountdown,
}: RetryCountdownButtonProps) {
  const [remainingMs, setRemainingMs] = useState(delayMs);
  const firedRef = useRef(false);
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  useEffect(() => {
    if (!active || busy) {
      setRemainingMs(delayMs);
      firedRef.current = false;
      return;
    }
    setRemainingMs(delayMs);
    firedRef.current = false;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - started;
      const next = Math.max(0, delayMs - elapsed);
      setRemainingMs(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onFireRef.current();
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [active, busy, delayMs]);

  const progress = delayMs > 0 ? 1 - remainingMs / delayMs : 1;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  return (
    <button
      type="button"
      className={btnBase}
      disabled={busy}
      onClick={() => {
        onCancelCountdown?.();
        onFire();
      }}
    >
      <svg
        className="size-[16px] shrink-0 -rotate-90"
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
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>
      {busy ? "Retrying…" : "Retry"}
    </button>
  );
}
