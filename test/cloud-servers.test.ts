import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildCloudServerPushPayloads,
  cloudServerIdentity,
  diffRemovedCloudServers,
  mergeCloudServersIntoState,
  parseCloudServerTombstones,
  serializeCloudServerTombstones,
  serverConnectionsSignature,
} from "../src/lib/cloud/cloud-servers.ts";
import {
  createDefaultServerConnectionsState,
  createServerConnection,
  type ServerConnectionsState,
} from "../src/lib/server-connections.ts";

const LOCATOR = {
  version: 1 as const,
  serverId: "abcdefghijklmnopqrstuvwx",
  secret: "s".repeat(43),
  registryBaseUrl: "https://cesium.example.com",
};

const OTHER_LOCATOR = {
  version: 1 as const,
  serverId: "zyxwvutsrqponmlkjihgfedc",
  secret: "t".repeat(43),
  registryBaseUrl: "https://cesium.example.com",
};

function defaultState(): ServerConnectionsState {
  return createDefaultServerConnectionsState("http://localhost:9100");
}

describe("cloud server sync helpers", () => {
  test("identity prefers the rendezvous server id over the base URL", () => {
    assert.equal(
      cloudServerIdentity({ baseUrl: "https://a.example.com", rendezvous: LOCATOR }),
      `rendezvous:${LOCATOR.serverId}`
    );
    assert.equal(
      cloudServerIdentity({ baseUrl: "http://127.0.0.1:9100" }),
      cloudServerIdentity({ baseUrl: "http://localhost:9100" })
    );
  });

  test("merge inherits a tunnel-backed cloud server with its locator", () => {
    const merged = mergeCloudServersIntoState(defaultState(), [
      {
        name: "Home desktop",
        baseUrl: "https://tunnel-1.lhr.life",
        rendezvous: LOCATOR,
      },
    ]);
    assert.equal(merged.changed, true);
    const inherited = merged.state.servers.find(
      (server) => server.rendezvous?.serverId === LOCATOR.serverId
    );
    assert.ok(inherited);
    assert.equal(inherited.baseUrl, "https://tunnel-1.lhr.life");
    assert.equal(inherited.label, "Home desktop");
    assert.equal(inherited.rendezvous?.secret, LOCATOR.secret);
    assert.equal(inherited.rendezvous?.registryBaseUrl, LOCATOR.registryBaseUrl);
    // The inherited server must not steal the active selection.
    assert.notEqual(merged.state.activeServerId, inherited.id);
  });

  test("merge is idempotent - a second application reports no change", () => {
    const first = mergeCloudServersIntoState(defaultState(), [
      { name: "Home desktop", baseUrl: "https://tunnel-1.lhr.life", rendezvous: LOCATOR },
      { name: "Plain remote", baseUrl: "https://engine.example.com" },
    ]);
    assert.equal(first.changed, true);
    const second = mergeCloudServersIntoState(first.state, [
      { name: "Home desktop", baseUrl: "https://tunnel-1.lhr.life", rendezvous: LOCATOR },
      { name: "Plain remote", baseUrl: "https://engine.example.com" },
    ]);
    assert.equal(second.changed, false);
    assert.equal(second.state, first.state);
  });

  test("merge keeps a fresher local endpoint for a known rendezvous server", () => {
    const seeded = mergeCloudServersIntoState(defaultState(), [
      { name: "Home desktop", baseUrl: "https://tunnel-2.lhr.life", rendezvous: LOCATOR },
    ]).state;
    // The cloud row still records the older tunnel URL.
    const merged = mergeCloudServersIntoState(seeded, [
      { name: "Home desktop", baseUrl: "https://tunnel-1.lhr.life", rendezvous: LOCATOR },
    ]);
    assert.equal(merged.changed, false);
    const server = merged.state.servers.find(
      (entry) => entry.rendezvous?.serverId === LOCATOR.serverId
    );
    assert.equal(server?.baseUrl, "https://tunnel-2.lhr.life");
  });

  test("merge keys inherited session tokens to the locally resolved endpoint", () => {
    const seeded = mergeCloudServersIntoState(defaultState(), [
      { name: "Home desktop", baseUrl: "https://tunnel-2.lhr.life", rendezvous: LOCATOR },
    ]).state;
    const merged = mergeCloudServersIntoState(seeded, [
      {
        name: "Home desktop",
        baseUrl: "https://tunnel-1.lhr.life",
        rendezvous: LOCATOR,
        sessionToken: "token-123",
      },
    ]);
    assert.deepEqual(merged.sessionTokens, [
      { baseUrl: "https://tunnel-2.lhr.life", sessionToken: "token-123" },
    ]);
  });

  test("merge skips tombstoned identities so removals do not resurrect", () => {
    const merged = mergeCloudServersIntoState(
      defaultState(),
      [
        { name: "Removed here", baseUrl: "https://tunnel-1.lhr.life", rendezvous: LOCATOR },
        { name: "Still wanted", baseUrl: "https://engine.example.com" },
      ],
      { skipIdentities: new Set([`rendezvous:${LOCATOR.serverId}`]) }
    );
    assert.equal(merged.changed, true);
    assert.equal(
      merged.state.servers.some((server) => server.rendezvous?.serverId === LOCATOR.serverId),
      false
    );
    assert.equal(
      merged.state.servers.some((server) => server.baseUrl === "https://engine.example.com"),
      true
    );
  });

  test("merge ignores cloud rows with invalid locators or base URLs", () => {
    const merged = mergeCloudServersIntoState(defaultState(), [
      {
        name: "Broken locator",
        baseUrl: "https://tunnel-1.lhr.life",
        rendezvous: { version: 1, serverId: "short", secret: "nope", registryBaseUrl: "x" },
      },
      { name: "Broken URL", baseUrl: "not-a-url" },
    ]);
    // The invalid locator degrades to a plain URL-keyed server; the invalid
    // URL row is dropped entirely.
    assert.equal(
      merged.state.servers.some((server) => server.baseUrl === "https://tunnel-1.lhr.life"),
      true
    );
    assert.equal(
      merged.state.servers.some((server) => Boolean(server.rendezvous)),
      false
    );
  });

  test("push payloads round-trip the rendezvous locator and session token", () => {
    const tunnel = createServerConnection({
      label: "Home desktop",
      baseUrl: "https://tunnel-1.lhr.life",
      rendezvous: LOCATOR,
    });
    const plain = createServerConnection({
      label: "Plain",
      baseUrl: "https://engine.example.com",
    });
    const payloads = buildCloudServerPushPayloads([tunnel, plain], (baseUrl) =>
      baseUrl === tunnel.baseUrl ? "token-123" : null
    );
    assert.deepEqual(payloads, [
      {
        name: "Home desktop",
        baseUrl: "https://tunnel-1.lhr.life",
        kind: "remote",
        sessionToken: "token-123",
        rendezvous: LOCATOR,
      },
      {
        name: "Plain",
        baseUrl: "https://engine.example.com",
        kind: "remote",
      },
    ]);
  });

  test("removed-server diff identifies tunnel servers by locator", () => {
    const tunnel = createServerConnection({
      label: "Home desktop",
      baseUrl: "https://tunnel-1.lhr.life",
      rendezvous: LOCATOR,
    });
    const rotated = createServerConnection({
      label: "Home desktop",
      baseUrl: "https://tunnel-2.lhr.life",
      rendezvous: LOCATOR,
    });
    const other = createServerConnection({
      label: "Other tunnel",
      baseUrl: "https://tunnel-3.lhr.life",
      rendezvous: OTHER_LOCATOR,
    });
    const plain = createServerConnection({
      label: "Plain",
      baseUrl: "https://engine.example.com",
    });
    // Rotation is not a removal: the locator identity survived.
    assert.deepEqual(diffRemovedCloudServers([tunnel, plain], [rotated, plain]), []);
    assert.deepEqual(diffRemovedCloudServers([tunnel, other, plain], [tunnel]), [
      {
        baseUrl: "https://tunnel-3.lhr.life",
        rendezvousServerId: OTHER_LOCATOR.serverId,
      },
      { baseUrl: "https://engine.example.com" },
    ]);
  });

  test("tombstones serialize and parse as a stable string set", () => {
    const identities = new Set([
      `rendezvous:${LOCATOR.serverId}`,
      "https://engine.example.com:443",
    ]);
    const parsed = parseCloudServerTombstones(serializeCloudServerTombstones(identities));
    assert.deepEqual([...parsed].sort(), [...identities].sort());
    assert.deepEqual([...parseCloudServerTombstones(null)], []);
    assert.deepEqual([...parseCloudServerTombstones("{corrupt")], []);
    assert.deepEqual([...parseCloudServerTombstones(JSON.stringify({ nope: 1 }))], []);
  });

  test("signature ignores timestamps but tracks material changes", () => {
    const base = defaultState();
    const touched: ServerConnectionsState = {
      ...base,
      servers: base.servers.map((server) => ({
        ...server,
        updatedAt: server.updatedAt + 10_000,
        lastUsedAt: server.lastUsedAt + 10_000,
      })),
    };
    assert.equal(serverConnectionsSignature(base), serverConnectionsSignature(touched));
    const relabeled: ServerConnectionsState = {
      ...base,
      servers: base.servers.map((server) => ({ ...server, label: "Renamed" })),
    };
    assert.notEqual(serverConnectionsSignature(base), serverConnectionsSignature(relabeled));
  });
});
