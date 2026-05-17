import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  clearStoredAuth,
  getStoredSessionToken,
  setStoredSessionToken,
} from "../src/lib/auth-client.ts";
import {
  createDefaultServerConnectionsState,
  normalizeServerConnectionsState,
} from "../src/lib/server-connections.ts";
import {
  resolveClientServerBaseUrlForCurrentWindow,
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

  test("normalization activates new configured default over stale local dev port", () => {
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
      "http://localhost:9200"
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
      resolveClientServerBaseUrlForLocation("http://localhost:9107", {
        location: {
          protocol: "http:",
          hostname: "192.168.4.172",
          host: "192.168.4.172:3000",
        },
      }),
      "http://192.168.4.172:9107"
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
