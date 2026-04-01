/**
 * Cursor CLI / ACP often return `result.rejected` as an object without `reason`.
 * Surface any structured fields so deployers can see the real failure mode.
 */
export function formatRejectedToolDetail(rejected: Record<string, unknown>): string {
  const direct =
    typeof rejected.reason === "string" && rejected.reason.trim()
      ? rejected.reason.trim()
      : undefined;
  if (direct) {
    return direct;
  }

  for (const key of ["message", "error", "detail", "description", "kind", "type"] as const) {
    const v = rejected[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
    if (typeof v === "number" || typeof v === "boolean") {
      return `${key}: ${String(v)}`;
    }
  }

  try {
    const keys = Object.keys(rejected);
    if (keys.length === 0) {
      return "Tool call was rejected by the current approval settings.";
    }
    const compact = JSON.stringify(rejected);
    return compact.length > 800 ? `${compact.slice(0, 797)}...` : compact;
  } catch {
    return "Tool call was rejected by the current approval settings.";
  }
}
