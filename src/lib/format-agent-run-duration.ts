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

/** Second-granular elapsed time for live timers and tool rows (e.g. `8s`, `2m 14s`, `1h 3m`). */
export function formatAgentElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
