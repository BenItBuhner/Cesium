/** Compact agent run duration for turn footers (e.g. `1d 3h 2m`). */
export function formatAgentRunDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.floor(durationMs));
  if (safeMs < 60_000) {
    return "<1m";
  }

  const totalMinutes = Math.floor(safeMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (days > 0 || hours > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
