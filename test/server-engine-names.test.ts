import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, test } from "node:test";
import { probeServerBaseUrl } from "../packages/client/src/server-connection-health.ts";
import {
  SERVER_ENGINE_NAMES_STORAGE_KEY,
  applyServerEngineNameProbes,
  engineNamesForServers,
  readStoredServerEngineNames,
  sanitizeEngineName,
  writeStoredServerEngineNames,
  type ServerEngineNames,
} from "../packages/client/src/server-engine-names.ts";

type AuthStatusReply = Record<string, unknown> | null;

let authStatusReply: AuthStatusReply = null;
let engine: http.Server;
let engineBaseUrl = "";

before(async () => {
  engine = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/auth/status" && authStatusReply) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(authStatusReply));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  engineBaseUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => engine.close(() => resolve()));
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function installMockStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
      },
    },
  });
  return data;
}

function server(id: string, baseUrl: string, rendezvousId?: string) {
  return {
    id,
    baseUrl,
    ...(rendezvousId
      ? {
          rendezvous: {
            version: 1 as const,
            serverId: rendezvousId,
            secret: "secret",
            registryBaseUrl: "https://registry.example",
          },
        }
      : {}),
  };
}

describe("probing an engine's name", () => {
  test("reads the name an engine reports", async () => {
    authStatusReply = { enabled: false, authenticated: true, engineName: "  Build   box " };
    const probe = await probeServerBaseUrl(engineBaseUrl);
    assert.equal(probe.ok, true);
    assert.equal(probe.engineName, "Build box");
  });

  test("an engine that answers without a name has none", async () => {
    authStatusReply = { enabled: false, authenticated: true };
    assert.equal((await probeServerBaseUrl(engineBaseUrl)).engineName, null);
    authStatusReply = { enabled: true, authenticated: true, engineName: "   " };
    assert.equal((await probeServerBaseUrl(engineBaseUrl)).engineName, null);
  });

  test("a signed-out caller learns nothing about the name", async () => {
    authStatusReply = { enabled: true, authenticated: false };
    const probe = await probeServerBaseUrl(engineBaseUrl);
    assert.equal(probe.ok, true);
    assert.equal(probe.engineName, undefined);
  });

  test("an engine without the auth route or offline says nothing", async () => {
    authStatusReply = null;
    assert.equal((await probeServerBaseUrl(engineBaseUrl)).engineName, undefined);

    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const offline = await probeServerBaseUrl(`http://127.0.0.1:${port}`);
    assert.equal(offline.ok, false);
    assert.equal(offline.engineName, undefined);
  });
});

describe("remembered engine names", () => {
  const home = server("home", "http://localhost:9100");
  const buildBox = server("build", "http://localhost:9101");

  test("sanitizes names to one trimmed line", () => {
    assert.equal(sanitizeEngineName(" Home\n office "), "Home office");
    assert.equal(sanitizeEngineName(""), null);
    assert.equal(sanitizeEngineName(42), null);
    assert.equal(sanitizeEngineName("x".repeat(200))?.length, 80);
  });

  test("learns names, forgets them on an explicit no-name, keeps them when unknown", () => {
    const learned = applyServerEngineNameProbes(
      {},
      [
        { server: home, engineName: "Home" },
        { server: buildBox, engineName: "Build box" },
      ],
      [home, buildBox]
    );
    assert.deepEqual(engineNamesForServers(learned, [home, buildBox]), {
      home: "Home",
      build: "Build box",
    });

    const offline = applyServerEngineNameProbes(
      learned,
      [
        { server: home, engineName: undefined },
        { server: buildBox, engineName: undefined },
      ],
      [home, buildBox]
    );
    assert.equal(offline, learned, "an offline engine keeps its name and nothing is rewritten");

    const downgraded = applyServerEngineNameProbes(
      learned,
      [{ server: buildBox, engineName: null }],
      [home, buildBox]
    );
    assert.deepEqual(engineNamesForServers(downgraded, [home, buildBox]), { home: "Home" });
  });

  test("drops removed servers and names from a connection's old address", () => {
    const names: ServerEngineNames = {
      home: { name: "Home", endpoint: home.baseUrl },
      build: { name: "Build box", endpoint: buildBox.baseUrl },
    };
    const pruned = applyServerEngineNameProbes(names, [], [home]);
    assert.deepEqual(Object.keys(pruned), ["home"]);

    const repointed = server("home", "http://10.0.0.5:9100");
    assert.deepEqual(engineNamesForServers(names, [repointed]), {});
    const stale = applyServerEngineNameProbes(
      names,
      [{ server: home, engineName: "Home" }],
      [repointed, buildBox]
    );
    assert.deepEqual(
      engineNamesForServers(stale, [repointed, buildBox]),
      { build: "Build box" },
      "a probe of the old address does not name the re-pointed connection"
    );
  });

  test("tunnel-backed engines keep their name across URL rotations", () => {
    const before = server("tunnel", "https://a.trycloudflare.com", "srv_1");
    const rotated = server("tunnel", "https://b.trycloudflare.com", "srv_1");
    const names = applyServerEngineNameProbes(
      {},
      [{ server: before, engineName: "Laptop" }],
      [before]
    );
    assert.deepEqual(engineNamesForServers(names, [rotated]), { tunnel: "Laptop" });
  });

  test("persists across reloads and survives corrupt storage", () => {
    const storage = installMockStorage();
    assert.deepEqual(readStoredServerEngineNames(), {});
    writeStoredServerEngineNames({ home: { name: "Home", endpoint: home.baseUrl } });
    assert.deepEqual(readStoredServerEngineNames(), {
      home: { name: "Home", endpoint: home.baseUrl },
    });
    storage.set(SERVER_ENGINE_NAMES_STORAGE_KEY, "{not json");
    assert.deepEqual(readStoredServerEngineNames(), {});
    storage.set(
      SERVER_ENGINE_NAMES_STORAGE_KEY,
      JSON.stringify({ home: { name: " ", endpoint: home.baseUrl }, build: "Build box" })
    );
    assert.deepEqual(readStoredServerEngineNames(), {});
  });
});
