export function serverHealthIndicator(health: string): string {
  if (health === "online") return "●";
  if (health === "auth_required") return "◐";
  if (health === "offline") return "○";
  return "•";
}

export function serverHealthColorClass(health: string): string {
  if (health === "online") return "text-emerald-400";
  if (health === "offline") return "text-[var(--text-disabled)]";
  return "text-[var(--text-secondary)]";
}
