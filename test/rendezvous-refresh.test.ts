import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RENDEZVOUS_REFRESH_DEGRADED_MS,
  RENDEZVOUS_REFRESH_HEALTHY_MS,
  RENDEZVOUS_DEAD_SERVER_CUTOFF_MS,
  isRendezvousServerReachable,
  nextServerRetryState,
  rendezvousServerJustWentOffline,
  shouldAttemptServer,
  shouldRefreshRendezvous,
} from "../packages/client/src/rendezvous-refresh.ts";

describe("rendezvous refresh cadence", () => {
  test("the healthy cadence is a small fraction of the engine's publish rate", () => {
    // Convex pushes production changes; legacy/custom registries use one
    // batched lookup every five minutes while healthy.
    assert.equal(RENDEZVOUS_REFRESH_HEALTHY_MS, 5 * 60_000);
    assert.equal(RENDEZVOUS_REFRESH_DEGRADED_MS, 30_000);
    assert.ok(RENDEZVOUS_REFRESH_DEGRADED_MS < RENDEZVOUS_REFRESH_HEALTHY_MS);
  });

  test("unreachable servers back off exponentially and stop after one day", () => {
    const startedAt = 1_000_000;
    const first = nextServerRetryState({
      now: startedAt,
      reachable: false,
    });
    assert.equal(first.nextAttemptAt, startedAt + 30_000);
    assert.equal(shouldAttemptServer(first, startedAt + 29_999), false);
    assert.equal(shouldAttemptServer(first, startedAt + 30_000), true);

    const second = nextServerRetryState({
      previous: first,
      now: first.nextAttemptAt,
      reachable: false,
    });
    assert.equal(second.nextAttemptAt, first.nextAttemptAt + 60_000);
    assert.equal(
      shouldAttemptServer(second, startedAt + RENDEZVOUS_DEAD_SERVER_CUTOFF_MS),
      false
    );
    assert.equal(
      shouldAttemptServer(second, startedAt + RENDEZVOUS_DEAD_SERVER_CUTOFF_MS, true),
      true,
      "a user-triggered refresh can revive a stale server"
    );
  });

  test("Retry-After extends the global exponential delay", () => {
    const state = nextServerRetryState({
      now: 10_000,
      reachable: false,
      retryAfterMs: 120_000,
    });
    assert.equal(state.nextAttemptAt, 130_000);
  });

  test("no rendezvous servers means nothing to refresh", () => {
    assert.equal(
      shouldRefreshRendezvous({ now: 1_000_000, lastRefreshAt: 0, healths: [] }),
      false
    );
  });

  test("reachable servers only refresh once the slow interval has elapsed", () => {
    const lastRefreshAt = 100_000;
    for (const health of ["online", "auth_required", "unknown", undefined] as const) {
      assert.equal(
        shouldRefreshRendezvous({
          now: lastRefreshAt + RENDEZVOUS_REFRESH_HEALTHY_MS - 1,
          lastRefreshAt,
          healths: [health],
        }),
        false,
        `${String(health)} must wait for the slow interval`
      );
      assert.equal(
        shouldRefreshRendezvous({
          now: lastRefreshAt + RENDEZVOUS_REFRESH_HEALTHY_MS,
          lastRefreshAt,
          healths: [health],
        }),
        true,
        `${String(health)} refreshes at the slow interval`
      );
    }
  });

  test("any offline or degraded server switches to the fast interval", () => {
    const lastRefreshAt = 100_000;
    for (const health of ["offline", "degraded"] as const) {
      assert.equal(
        shouldRefreshRendezvous({
          now: lastRefreshAt + RENDEZVOUS_REFRESH_DEGRADED_MS - 1,
          lastRefreshAt,
          healths: ["online", health],
        }),
        false
      );
      assert.equal(
        shouldRefreshRendezvous({
          now: lastRefreshAt + RENDEZVOUS_REFRESH_DEGRADED_MS,
          lastRefreshAt,
          healths: ["online", health],
        }),
        true
      );
    }
  });

  test("a server that just dropped offline triggers an immediate lookup", () => {
    assert.equal(rendezvousServerJustWentOffline("online", "offline"), true);
    assert.equal(rendezvousServerJustWentOffline(undefined, "offline"), true);
    assert.equal(rendezvousServerJustWentOffline("unknown", "degraded"), true);
    assert.equal(rendezvousServerJustWentOffline("offline", "offline"), false);
    assert.equal(rendezvousServerJustWentOffline("degraded", "offline"), false);
    assert.equal(rendezvousServerJustWentOffline("offline", "online"), false);
    assert.equal(rendezvousServerJustWentOffline("online", "online"), false);
  });

  test("auth_required counts as reachable", () => {
    assert.equal(isRendezvousServerReachable("online"), true);
    assert.equal(isRendezvousServerReachable("auth_required"), true);
    assert.equal(isRendezvousServerReachable("offline"), false);
    assert.equal(isRendezvousServerReachable("degraded"), false);
    assert.equal(isRendezvousServerReachable("unknown"), false);
    assert.equal(isRendezvousServerReachable(undefined), false);
  });
});
