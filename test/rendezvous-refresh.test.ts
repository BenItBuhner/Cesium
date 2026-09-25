import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RENDEZVOUS_REFRESH_DEGRADED_MS,
  RENDEZVOUS_REFRESH_HEALTHY_MS,
  isRendezvousServerReachable,
  rendezvousServerJustWentOffline,
  shouldRefreshRendezvous,
} from "../packages/client/src/rendezvous-refresh.ts";

describe("rendezvous refresh cadence", () => {
  test("the healthy cadence is a small fraction of the engine's publish rate", () => {
    // Engines publish every 30 s into a 90 s TTL; one lookup a minute follows a
    // rotation well before the record can expire, and a tab that stays
    // visible all month costs ~43K lookups instead of ~260K at 10 s.
    assert.equal(RENDEZVOUS_REFRESH_HEALTHY_MS, 60_000);
    assert.equal(RENDEZVOUS_REFRESH_DEGRADED_MS, 10_000);
    assert.ok(RENDEZVOUS_REFRESH_DEGRADED_MS < RENDEZVOUS_REFRESH_HEALTHY_MS);
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
