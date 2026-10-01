/**
 * Cadence for re-resolving tunnel-backed engines through the rendezvous
 * registry (`GET /api/rendezvous/<serverId>` on the web deployment).
 *
 * Current clients receive Convex record updates reactively. These cadences
 * only govern legacy/custom HTTP registries: healthy servers refresh every
 * five minutes; unreachable ones back off exponentially and stop after a day.
 *
 * Every fallback lookup may be a billed hosted-web invocation, so all server
 * ids are batched and deployment-level errors apply a global backoff.
 */
export const RENDEZVOUS_REFRESH_HEALTHY_MS = 5 * 60_000;
export const RENDEZVOUS_REFRESH_DEGRADED_MS = 30_000;
export const RENDEZVOUS_REFRESH_MAX_BACKOFF_MS = 15 * 60_000;
export const RENDEZVOUS_DEAD_SERVER_CUTOFF_MS = 24 * 60 * 60_000;

export type ServerRetryState = {
  failures: number;
  firstFailureAt: number | null;
  nextAttemptAt: number;
};

export function nextServerRetryState(input: {
  previous?: ServerRetryState;
  now: number;
  reachable: boolean;
  healthyIntervalMs?: number;
  retryAfterMs?: number | null;
}): ServerRetryState {
  if (input.reachable) {
    return {
      failures: 0,
      firstFailureAt: null,
      nextAttemptAt: input.now + (input.healthyIntervalMs ?? RENDEZVOUS_REFRESH_HEALTHY_MS),
    };
  }
  const failures = (input.previous?.failures ?? 0) + 1;
  const exponential = Math.min(
    RENDEZVOUS_REFRESH_MAX_BACKOFF_MS,
    RENDEZVOUS_REFRESH_DEGRADED_MS * 2 ** Math.min(failures - 1, 10)
  );
  return {
    failures,
    firstFailureAt: input.previous?.firstFailureAt ?? input.now,
    nextAttemptAt:
      input.now + Math.max(exponential, input.retryAfterMs ?? 0),
  };
}

export function shouldAttemptServer(
  state: ServerRetryState | undefined,
  now: number,
  force = false
): boolean {
  if (force || !state) {
    return true;
  }
  if (
    state.firstFailureAt !== null &&
    now - state.firstFailureAt >= RENDEZVOUS_DEAD_SERVER_CUTOFF_MS
  ) {
    return false;
  }
  return now >= state.nextAttemptAt;
}

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

/**
 * A successful lookup schedules the next one on the slow healthy cadence. An
 * engine that just dropped offline has most likely rotated its tunnel URL, so
 * that wait is dropped and it is looked up straight away; error backoff (and
 * the dead-server cutoff) is kept.
 */
export function retryStateAfterServerWentOffline(
  state: ServerRetryState | undefined
): ServerRetryState | undefined {
  return state && state.failures > 0 ? state : undefined;
}

/**
 * Whether a lookup found the engine. A record that still names the URL the
 * client already sees offline has not caught up with the engine's newest
 * publish yet, so it is retried on the fast cadence rather than in five
 * minutes.
 */
export function rendezvousLookupFoundEngine(input: {
  resolvedBaseUrl: string | null | undefined;
  currentBaseUrl: string;
  currentHealth: RendezvousRefreshHealth | undefined;
}): boolean {
  if (!input.resolvedBaseUrl) {
    return false;
  }
  return !(
    input.resolvedBaseUrl === input.currentBaseUrl &&
    (input.currentHealth === "offline" || input.currentHealth === "degraded")
  );
}
