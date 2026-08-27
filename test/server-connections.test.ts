import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  clearStoredAuth,
  getStoredSessionToken,
  migrateStoredAuthServerBaseUrl,
  setStoredSessionToken,
} from "../src/lib/auth-client.ts";
import {
  applyRendezvousBootstrap,
  applyServerUrlBootstrap,
  bootstrapStoredServerConnection,
  createDefaultServerConnectionsState,
  getActiveServerStorageKey,
  getServerConnectionKey,
  getSettingsServerConnection,
  markServerConnectionUsed,
  mergeServerConnectionBootstrap,
  normalizeServerConnectionsState,
  requiresDefaultServerSelection,
  setDefaultServerConnection,
  shouldApplyServerUrlFromSearch,
  updateRendezvousServerEndpoint,
  writeStoredServerConnectionsState,
} from "../src/lib/server-connections.ts";
import { getConfiguredServerBaseUrl } from "../src/lib/configured-server-base-url.ts";
import {
  isConfiguredDefaultServerBaseUrl,
  parseServerUrlSearchParam,
  resolveClientServerBaseUrlForLocation,
  resolveServerRequestBaseUrlForLocation,
} from "../src/lib/resolve-server-base-url.ts";
import {
  CESIUM_SERVER_INSTALLER_URL,
  buildCesiumServerInstallCommand,
  normalizeWebAppOrigin,
} from "../src/lib/server-install-command.ts";

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

function installMockWindow() {
  const storage = new MemoryStorage();
  const mockWindow = {
    localStorage: storage,
    dispatchEvent() {
      return true;
    },
    location: {
      protocol: "http:",
      hostname: "localhost",
      host: "localhost:3000",
      origin: "http://localhost:3000",
      search: "",
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: mockWindow,
  });
  return mockWindow;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("server connections", () => {
  test("default state seeds the configured base URL", () => {
    const state = createDefaultServerConnectionsState("http://localhost:9100/");
    assert.equal(state.servers.length, 1);
    assert.equal(state.servers[0]?.baseUrl, "http://localhost:9100");
    assert.equal(state.activeServerId, state.servers[0]?.id ?? null);
    assert.equal(state.defaultServerId, state.servers[0]?.id ?? null);
  });

  test("the Cesium account site is never seeded as a default server", () => {
    const state = createDefaultServerConnectionsState("https://cesium.techlitnow.com");
    assert.deepEqual(state.servers, []);
    assert.equal(state.activeServerId, null);
    assert.equal(state.defaultServerId, null);
  });

  test("account-site pages do not seed a leftover localhost default", () => {
    const mockWindow = installMockWindow();
    mockWindow.location.hostname = "cesium.techlitnow.com";
    mockWindow.location.host = "cesium.techlitnow.com";
    mockWindow.location.origin = "https://cesium.techlitnow.com";
    mockWindow.location.protocol = "https:";
    const state = createDefaultServerConnectionsState("http://localhost:9100");
    assert.deepEqual(state.servers, []);
  });

  test("normalization drops the Cesium account site and does not re-inject it", () => {
    const state = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "site",
        servers: [
          {
            id: "site",
            label: "Cesium",
            baseUrl: "https://cesium.techlitnow.com",
            updatedAt: 1,
          },
        ],
      },
      "https://cesium.techlitnow.com"
    );
    assert.deepEqual(state.servers, []);
    assert.equal(state.activeServerId, null);
  });

  test("applyServerUrlBootstrap ignores the Cesium account site", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const next = applyServerUrlBootstrap(base, "https://cesium.techlitnow.com", {
      force: true,
    });
    assert.equal(next, base);
    assert.equal(
      next.servers.some((server) => server.baseUrl.includes("cesium.techlitnow.com")),
      false
    );
  });

  test("normalization drops invalid entries and dedupes by base URL", () => {
    const state = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "missing",
        servers: [
          { id: "one", label: "A", baseUrl: "http://localhost:9100/", updatedAt: 1 },
          { id: "two", label: "B", baseUrl: "http://localhost:9100", updatedAt: 2 },
          { id: "bad", label: "Bad", baseUrl: "notaurl" },
          { id: "three", label: "C", baseUrl: "https://example.com" },
        ],
      },
      "http://fallback:9100"
    );
    assert.equal(state.servers.length, 3);
    assert.deepEqual(
      state.servers.map((server) => server.baseUrl).sort(),
      ["http://fallback:9100", "http://localhost:9100", "https://example.com"]
    );
    assert.equal(
      state.servers.find((server) => server.id === state.activeServerId)?.baseUrl,
      "http://localhost:9100"
    );
  });

  test("normalization dedupes loopback aliases for the same local server", () => {
    const state = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "loopback-two",
        servers: [
          {
            id: "localhost",
            label: "localhost:9100",
            baseUrl: "http://localhost:9100",
            updatedAt: 1,
            lastUsedAt: 1,
          },
          {
            id: "loopback-two",
            label: "127.0.0.2:9100",
            baseUrl: "http://127.0.0.2:9100",
            updatedAt: 2,
            lastUsedAt: 2,
          },
          {
            id: "prod",
            label: "Prod",
            baseUrl: "https://opencursor.techlitnow.com",
            updatedAt: 3,
            lastUsedAt: 3,
          },
        ],
      },
      "http://localhost:9100"
    );

    assert.equal(getServerConnectionKey("http://127.0.0.2:9100"), "http://localhost:9100");
    assert.equal(state.servers.length, 2);
    assert.equal(
      state.servers.filter((server) => getServerConnectionKey(server.baseUrl) === "http://localhost:9100").length,
      1
    );
  });

  test("normalization keeps the saved active server over a newer configured default", () => {
    const state = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "old",
        servers: [{ id: "old", label: "Old", baseUrl: "http://localhost:9100" }],
      },
      "http://localhost:9200"
    );
    assert.equal(
      state.servers.find((server) => server.id === state.activeServerId)?.baseUrl,
      "http://localhost:9100"
    );
  });

  test("multi-server profiles migrate default server from active server", () => {
    const state = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "local",
        servers: [
          { id: "local", label: "Local", baseUrl: "http://localhost:9100", updatedAt: 1 },
          { id: "prod", label: "Prod", baseUrl: "https://example.com", updatedAt: 2 },
        ],
      },
      "http://localhost:9100"
    );
    assert.equal(state.defaultServerId, "local");
    assert.equal(getSettingsServerConnection(state)?.id, "local");
    assert.equal(requiresDefaultServerSelection(state), false);
  });

  test("setDefaultServerConnection stores the chosen settings server", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const withSecond = {
      ...base,
      servers: [
        ...base.servers,
        {
          id: "prod",
          label: "Prod",
          baseUrl: "https://example.com",
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
        },
      ],
      defaultServerId: null,
    };
    assert.equal(requiresDefaultServerSelection(withSecond), true);
    const next = setDefaultServerConnection(withSecond, "prod");
    assert.equal(next.defaultServerId, "prod");
    assert.equal(getSettingsServerConnection(next)?.id, "prod");
    assert.equal(requiresDefaultServerSelection(next), false);
  });

  test("configured default uses port 9100 when env is unset", () => {
    assert.equal(getConfiguredServerBaseUrl(), "http://localhost:9100");
  });

  test("serverUrl query is ignored when another active server is already saved", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const withActive9100 = {
      ...base,
      activeServerId: base.servers[0]?.id ?? null,
    };
    assert.equal(
      shouldApplyServerUrlFromSearch(withActive9100, "http://localhost:9107"),
      false
    );
  });

  test("serverUrl query is applied for a new unsaved server", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    assert.equal(
      shouldApplyServerUrlFromSearch(base, "http://192.168.1.50:9100"),
      true
    );
  });

  test("serverUrl query switches to an existing remote server", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const withRemote = applyServerUrlBootstrap(base, "https://opencursor.techlitnow.com", {
      force: true,
    });
    const backToLocal = markServerConnectionUsed(withRemote, base.servers[0]?.id ?? "");
    assert.equal(
      shouldApplyServerUrlFromSearch(backToLocal, "https://opencursor.techlitnow.com"),
      true
    );
    const next = applyServerUrlBootstrap(backToLocal, "https://opencursor.techlitnow.com");
    assert.equal(
      next.servers.find((server) => server.id === next.activeServerId)?.baseUrl,
      "https://opencursor.techlitnow.com"
    );
  });

  test("applyServerUrlBootstrap switches active only when allowed", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const next = applyServerUrlBootstrap(base, "http://localhost:9107");
    assert.equal(
      base.servers.find((server) => server.id === base.activeServerId)?.baseUrl,
      "http://localhost:9100"
    );
    assert.equal(next, base);
    const forced = applyServerUrlBootstrap(base, "http://localhost:9107", { force: true });
    assert.equal(
      forced.servers.find((server) => server.id === forced.activeServerId)?.baseUrl,
      "http://localhost:9107"
    );
  });

  test("applyServerUrlBootstrap does not create duplicate loopback alias entries", () => {
    const base = createDefaultServerConnectionsState("http://localhost:9100");
    const next = applyServerUrlBootstrap(base, "http://127.0.0.2:9100", { force: true });

    assert.equal(next.servers.length, 1);
    assert.equal(getServerConnectionKey(next.servers[0]!.baseUrl), "http://localhost:9100");
  });

  test("runtime bootstrap merges without replacing manually saved servers", () => {
    const saved = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "remote",
        defaultServerId: "remote",
        servers: [
          {
            id: "mobile-server",
            label: "This device",
            baseUrl: "http://10.0.2.2:9100",
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
          {
            id: "remote",
            label: "Prod",
            baseUrl: "https://opencursor.example.com",
            createdAt: 2,
            updatedAt: 2,
            lastUsedAt: 2,
          },
        ],
      },
      "http://10.0.2.2:9100"
    );

    const next = mergeServerConnectionBootstrap(
      saved,
      {
        id: "mobile-server",
        label: "This device",
        baseUrl: "http://10.0.2.2:9100/",
        now: 3,
      },
      { activate: "if-missing", defaultServer: "if-missing" }
    );

    assert.equal(next.activeServerId, "remote");
    assert.equal(next.defaultServerId, "remote");
    assert.deepEqual(
      next.servers.map((server) => server.baseUrl).sort(),
      ["http://10.0.2.2:9100", "https://opencursor.example.com"]
    );
  });

  test("runtime bootstrap seeds the native server when storage is empty", () => {
    installMockWindow();

    const next = bootstrapStoredServerConnection({
      id: "mobile-server",
      label: "This device",
      baseUrl: "http://10.0.2.2:9100/",
    });

    assert.equal(next.servers.length, 1);
    assert.equal(next.servers[0]?.baseUrl, "http://10.0.2.2:9100");
    assert.equal(next.activeServerId, "mobile-server");
    assert.equal(next.defaultServerId, "mobile-server");
  });

  test("runtime bootstrap keeps auth lookup on the saved active server", () => {
    installMockWindow();
    const saved = normalizeServerConnectionsState(
      {
        version: 1,
        activeServerId: "remote",
        defaultServerId: "remote",
        servers: [
          {
            id: "remote",
            label: "Prod",
            baseUrl: "https://opencursor.example.com",
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 2,
          },
        ],
      },
      "http://10.0.2.2:9100"
    );
    writeStoredServerConnectionsState(saved);
    setStoredSessionToken(
      "remote-token",
      {
        username: "user",
        createdAt: 1,
        expiresAt: 2,
        lastSeenAt: 3,
        remember: true,
      },
      "https://opencursor.example.com"
    );

    bootstrapStoredServerConnection({
      id: "mobile-server",
      label: "This device",
      baseUrl: "http://10.0.2.2:9100",
    });

    assert.equal(getStoredSessionToken(), "remote-token");
  });

  test("desktop runtime bootstrap always activates the local sidecar server", () => {
    installMockWindow();
    writeStoredServerConnectionsState(
      normalizeServerConnectionsState(
        {
          version: 1,
          activeServerId: "remote",
          defaultServerId: "remote",
          servers: [
            {
              id: "remote",
              label: "Prod",
              baseUrl: "https://opencursor.example.com",
              createdAt: 1,
              updatedAt: 1,
              lastUsedAt: 2,
            },
          ],
        },
        "http://127.0.0.1:54320"
      )
    );

    const next = bootstrapStoredServerConnection(
      {
        id: "desktop-sidecar",
        label: "This device",
        baseUrl: "http://127.0.0.1:54321",
      },
      { activate: "always" }
    );

    assert.equal(next.activeServerId, "desktop-sidecar");
    assert.equal(
      next.servers.find((server) => server.id === "desktop-sidecar")?.baseUrl,
      "http://127.0.0.1:54321"
    );
  });
});

describe("stable rendezvous server identity", () => {
  const locator = {
    version: 1 as const,
    serverId: "server_1234567890abcdefghijklmnop",
    secret: "secret_1234567890abcdefghijklmnopqrstuvwxyz",
    registryBaseUrl: "https://cesium.example",
  };

  test("bootstraps and rotates one logical server in place", () => {
    const initial = createDefaultServerConnectionsState("http://localhost:9100");
    const connected = applyRendezvousBootstrap(initial, {
      locator,
      baseUrl: "https://first-tunnel.example",
      label: "Home server",
      now: 10,
    });
    const stable = connected.servers.find(
      (server) => server.rendezvous?.serverId === locator.serverId
    );
    assert.ok(stable);
    assert.equal(connected.activeServerId, stable.id);

    const rotated = updateRendezvousServerEndpoint(connected, {
      serverId: locator.serverId,
      baseUrl: "https://second-tunnel.example",
      now: 20,
    });
    const current = rotated.servers.find((server) => server.id === stable.id);
    assert.equal(current?.baseUrl, "https://second-tunnel.example");
    assert.equal(current?.rendezvous?.secret, locator.secret);
    assert.equal(rotated.activeServerId, stable.id);
  });

  test("migrates authentication to a verified rotated endpoint", () => {
    installMockWindow();
    setStoredSessionToken(
      "stable-session-token",
      {
        username: "cesium",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        lastSeenAt: 1,
        remember: true,
      },
      "https://first-tunnel.example"
    );
    assert.equal(
      migrateStoredAuthServerBaseUrl(
        "https://first-tunnel.example",
        "https://second-tunnel.example"
      ),
      true
    );
    assert.equal(
      getStoredSessionToken("https://second-tunnel.example"),
      "stable-session-token"
    );
    assert.equal(getStoredSessionToken("https://first-tunnel.example"), null);
  });

  test("uses a stable local-storage scope across endpoint rotations", () => {
    installMockWindow();
    const initial = applyRendezvousBootstrap(
      createDefaultServerConnectionsState("http://localhost:9100"),
      {
        locator,
        baseUrl: "https://first-tunnel.example",
      }
    );
    writeStoredServerConnectionsState(initial);
    const firstKey = getActiveServerStorageKey("http://localhost:9100");
    const rotated = updateRendezvousServerEndpoint(initial, {
      serverId: locator.serverId,
      baseUrl: "https://second-tunnel.example",
    });
    writeStoredServerConnectionsState(rotated);
    assert.equal(
      getActiveServerStorageKey("http://localhost:9100"),
      firstKey
    );
  });
});

describe("base URL resolution", () => {
  test("does not collapse requests onto the Cesium account site", () => {
    assert.equal(
      resolveClientServerBaseUrlForLocation("http://localhost:9100", {
        location: {
          protocol: "https:",
          hostname: "cesium.techlitnow.com",
          host: "cesium.techlitnow.com",
        },
      }),
      "http://localhost:9100"
    );
  });

  test("uses same-origin on https pages when configured server is http", () => {
    assert.equal(
      resolveClientServerBaseUrlForLocation("http://192.168.1.22:9100", {
        location: {
          protocol: "https:",
          hostname: "cesium.example.com",
          host: "cesium.example.com",
        },
      }),
      ""
    );
  });

  test("rewrites localhost server to current localhost origin scheme", () => {
    assert.equal(
      resolveClientServerBaseUrlForLocation("http://127.0.0.1:9100", {
        location: {
          protocol: "https:",
          hostname: "localhost",
          host: "localhost:3000",
        },
      }),
      ""
    );
  });

  test("rewrites loopback server to LAN host on plain http", () => {
    assert.equal(
      resolveClientServerBaseUrlForLocation("http://localhost:9100", {
        location: {
          protocol: "http:",
          hostname: "192.168.4.172",
          host: "192.168.4.172:3000",
        },
      }),
      "http://192.168.4.172:9100"
    );
  });

  test("explicit multi-server targets keep their configured origin on https pages", () => {
    assert.equal(
      resolveClientServerBaseUrlForLocation(
        "http://localhost:9100",
        {
          location: {
            protocol: "https:",
            hostname: "opencursor.example.com",
            host: "opencursor.example.com",
          },
        },
        { explicitTarget: true }
      ),
      "http://localhost:9100"
    );
    assert.equal(
      resolveClientServerBaseUrlForLocation(
        "https://opencursor.example.com",
        {
          location: {
            protocol: "https:",
            hostname: "opencursor.example.com",
            host: "opencursor.example.com",
          },
        },
        { explicitTarget: true }
      ),
      "https://opencursor.example.com"
    );
  });

  test("parseServerUrlSearchParam normalizes values", () => {
    assert.equal(
      parseServerUrlSearchParam("?serverUrl=http%3A%2F%2Flocalhost%3A9100%2F"),
      "http://localhost:9100"
    );
  });

  test("detects the configured default server across trivial URL variants", () => {
    // Test env has no NEXT_PUBLIC_SERVER_URL, so the default is http://localhost:9100.
    assert.equal(isConfiguredDefaultServerBaseUrl("http://localhost:9100"), true);
    assert.equal(isConfiguredDefaultServerBaseUrl("http://localhost:9100/"), true);
    assert.equal(isConfiguredDefaultServerBaseUrl("http://127.0.0.1:9100"), true);
    assert.equal(isConfiguredDefaultServerBaseUrl("http://192.168.1.50:9100"), false);
    assert.equal(isConfiguredDefaultServerBaseUrl("https://api.example.com"), false);
    assert.equal(isConfiguredDefaultServerBaseUrl("not a url"), false);
  });

  test("request resolution collapses the default server to same-origin on https pages", () => {
    // Reverse-proxy deployment: the page is served over TLS while the stored
    // server entry still carries the build-time HTTP loopback URL. Requests
    // must go same-origin (like auth and the agent WebSocket) or they would
    // target the *browser's* loopback and the rail could never load.
    const httpsLocation = {
      location: {
        protocol: "https:",
        hostname: "cesium.example.com",
        host: "cesium.example.com",
      },
    };
    assert.equal(
      resolveServerRequestBaseUrlForLocation("http://localhost:9100", httpsLocation),
      ""
    );
    assert.equal(
      resolveServerRequestBaseUrlForLocation("http://127.0.0.1:9100", httpsLocation),
      ""
    );
  });

  test("request resolution keeps genuinely different servers explicit", () => {
    const httpsLocation = {
      location: {
        protocol: "https:",
        hostname: "cesium.example.com",
        host: "cesium.example.com",
      },
    };
    // A saved server that is NOT the app's default keeps its own host so
    // multi-server fan-out still reaches the right machine.
    assert.equal(
      resolveServerRequestBaseUrlForLocation("https://other-server.example.com", httpsLocation),
      "https://other-server.example.com"
    );
    assert.equal(
      resolveServerRequestBaseUrlForLocation("http://192.168.1.50:9100", httpsLocation),
      "http://192.168.1.50:9100"
    );
  });

  test("request resolution rewrites the default server on plain-http LAN pages", () => {
    assert.equal(
      resolveServerRequestBaseUrlForLocation("http://localhost:9100", {
        location: {
          protocol: "http:",
          hostname: "192.168.4.172",
          host: "192.168.4.172:3000",
        },
      }),
      "http://192.168.4.172:9100"
    );
  });
});

describe("server installer command", () => {
  test("targets the current web origin and starts the installer through bash", () => {
    assert.equal(
      buildCesiumServerInstallCommand("https://cesium-example.vercel.app/workspace?tab=server"),
      `curl -fsSL ${CESIUM_SERVER_INSTALLER_URL} | env CESIUM_WEB_URL='https://cesium-example.vercel.app' bash`
    );
  });

  test("rejects non-http web app URLs", () => {
    assert.throws(() => normalizeWebAppOrigin("file:///tmp/cesium"), /http or https/);
  });
});

describe("per-server auth storage", () => {
  test("stores and clears auth state per server", () => {
    installMockWindow();

    setStoredSessionToken(
      "token-a",
      {
        username: "a",
        createdAt: 1,
        expiresAt: 2,
        lastSeenAt: 3,
        remember: true,
      },
      "http://server-a:9100"
    );
    setStoredSessionToken(
      "token-b",
      {
        username: "b",
        createdAt: 4,
        expiresAt: 5,
        lastSeenAt: 6,
        remember: false,
      },
      "http://server-b:9100"
    );

    assert.equal(getStoredSessionToken("http://server-a:9100"), "token-a");
    assert.equal(getStoredSessionToken("http://server-b:9100"), "token-b");

    clearStoredAuth("http://server-a:9100");

    assert.equal(getStoredSessionToken("http://server-a:9100"), null);
    assert.equal(getStoredSessionToken("http://server-b:9100"), "token-b");
  });
});
