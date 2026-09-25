/**
 * Cadence for re-resolving tunnel-backed engines through the rendezvous
 * registry (`GET /api/rendezvous/<serverId>` on the web deployment).
 *
 * The engine re-publishes its record every 30 s and a record lives 90 s, so a
 * connection that probes healthy only needs to look for a URL rotation about
 * once a minute. A rotated tunnel URL shows up first as the old endpoint
 * failing its health probe; from that moment the registry is re-checked on
 * the fast cadence (and once immediately) until the engine is reachable again.
 *
 * Every registry lookup is a billed function invocation on the hosted web app,
 * so the healthy cadence is deliberately slow: at 10 s a single always-visible
 * tab was ~260K invocations a month on its own.
 */
export const RENDEZVOUS_REFRESH_HEALTHY_MS = 60_000;
export const RENDEZVOUS_REFRESH_DEGRADED_MS = 10_000;

export type RendezvousRefreshHealth =
  | "unknown"
  | "online"
  | "offline"
  | "auth_required"
  | "degraded";

/** A server is reachable when it answers, even if it wants credentials. */
export function isRendezvousServerReachable(
  health: RendezvousRefreshHealth | undefined
): boolean {
  return health === "online" || health === "auth_required";
}

export function shouldRefreshRendezvous(input: {
  now: number;
  lastRefreshAt: number;
  /** Health of every rendezvous-backed server, missing when never probed. */
  healths: Array<RendezvousRefreshHealth | undefined>;
}): boolean {
  if (input.healths.length === 0) {
    return false;
  }
  // Never-probed servers ("unknown"/missing) are not treated as broken: the
  // health probe runs right after mount and the initial resolve already ran.
  const degraded = input.healths.some(
    (health) => health === "offline" || health === "degraded"
  );
  const interval = degraded
    ? RENDEZVOUS_REFRESH_DEGRADED_MS
    : RENDEZVOUS_REFRESH_HEALTHY_MS;
  return input.now - input.lastRefreshAt >= interval;
}

/** True when a rendezvous server that was reachable (or unprobed) just went offline. */
export function rendezvousServerJustWentOffline(
  previous: RendezvousRefreshHealth | undefined,
  next: RendezvousRefreshHealth | undefined
): boolean {
  return (next === "offline" || next === "degraded") && !(previous === "offline" || previous === "degraded");
}
