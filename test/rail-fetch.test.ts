import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveRailFetchServers } from "../src/lib/rail-fetch.ts";
import type { ServerConnection } from "../src/lib/server-connections.ts";

function server(id: string, baseUrl: string): ServerConnection {
  return {
    id,
    label: id,
    baseUrl,
    lastUsedAt: 1,
  };
}

describe("resolveRailFetchServers", () => {
  test("uses only health-verified servers when any are online", () => {
    const active = server("active", "http://127.0.0.1:8080");
    const remote = server("remote", "http://192.168.1.50:8080");
    const resolved = resolveRailFetchServers({
      activeServer: active,
      onlineServers: [active, remote],
      serverStatusById: {
        active: { health: "online" },
        remote: { health: "offline" },
      },
    });
    assert.deepEqual(resolved.map((entry) => entry.id), ["active"]);
  });

  test("falls back to active server while health is still unknown", () => {
    const active = server("active", "http://127.0.0.1:8080");
    const stale = server("stale", "http://10.0.0.99:8080");
    const resolved = resolveRailFetchServers({
      activeServer: active,
      onlineServers: [active, stale],
      serverStatusById: {},
    });
    assert.deepEqual(resolved.map((entry) => entry.id), ["active"]);
  });

  test("includes auth_required servers", () => {
    const active = server("active", "http://127.0.0.1:8080");
    const auth = server("auth", "http://127.0.0.1:8081");
    const resolved = resolveRailFetchServers({
      activeServer: active,
      onlineServers: [active, auth],
      serverStatusById: {
        active: { health: "online" },
        auth: { health: "auth_required" },
      },
    });
    assert.deepEqual(resolved.map((entry) => entry.id), ["active", "auth"]);
  });
});
