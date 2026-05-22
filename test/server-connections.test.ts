import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  clearStoredAuth,
  getStoredSessionToken,
  setStoredSessionToken,
} from "../src/lib/auth-client.ts";
import {
  applyServerUrlBootstrap,
  bootstrapStoredServerConnection,
  createDefaultServerConnectionsState,
  getServerConnectionKey,
  getSettingsServerConnection,
  markServerConnectionUsed,
  mergeServerConnectionBootstrap,
  normalizeServerConnectionsState,
  requiresDefaultServerSelection,
  setDefaultServerConnection,
  shouldApplyServerUrlFromSearch,
  writeStoredServerConnectionsState,
} from "../src/lib/server-connections.ts";
import { getConfiguredServerBaseUrl } from "../src/lib/configured-server-base-url.ts";
import {
  parseServerUrlSearchParam,
  resolveClientServerBaseUrlForLocation,
} from "../src/lib/resolve-server-base-url.ts";

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

describe("base URL resolution", () => {
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
