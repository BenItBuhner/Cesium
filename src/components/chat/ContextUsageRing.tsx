"use client";

interface ContextUsageRingProps {
  percent: number;
  loading?: boolean;
  className?: string;
}

export function ContextUsageRing({
  percent,
  loading = false,
  className = "",
}: ContextUsageRingProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      className={`shrink-0 ${className}`}
      aria-hidden={loading}
    >
      <circle
        cx={9}
        cy={9}
        r={radius}
        fill="none"
        stroke="var(--border-card)"
        strokeWidth={2}
      />
      <circle
        cx={9}
        cy={9}
        r={radius}
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={loading ? circumference * 0.75 : offset}
        transform="rotate(-90 9 9)"
        className={loading ? "opacity-60" : undefined}
      />
    </svg>
  );
}
