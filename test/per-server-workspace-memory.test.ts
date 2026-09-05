import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import {
  LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY,
  clearLegacyLastWorkspaceByServer,
  getLastWorkspaceForServer,
  normalizeLastWorkspaceByServer,
  readLegacyLastWorkspaceByServer,
  withLastWorkspaceForServer,
} from "../src/lib/per-server-workspace-memory.ts";

before(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
});

afterEach(() => {
  globalThis.localStorage.removeItem(LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY);
});

describe("per-server workspace memory (account setting helpers)", () => {
  test("remembers and restores last workspace per server without mutating input", () => {
    const empty = {};
    const withA = withLastWorkspaceForServer(empty, "server-a", "workspace-1");
    const withB = withLastWorkspaceForServer(withA, "server-b", "workspace-2");
    assert.deepEqual(empty, {});
    assert.equal(getLastWorkspaceForServer(withB, "server-a"), "workspace-1");
    assert.equal(getLastWorkspaceForServer(withB, "server-b"), "workspace-2");
    assert.equal(getLastWorkspaceForServer(withB, "server-c"), null);
  });

  test("returns the same map for no-op writes so settings edits can short-circuit", () => {
    const map = { "server-a": "workspace-1" };
    assert.equal(withLastWorkspaceForServer(map, "server-a", "workspace-1"), map);
    assert.equal(withLastWorkspaceForServer(map, "", "workspace-1"), map);
    assert.equal(withLastWorkspaceForServer(map, "server-a", "  "), map);
  });

  test("normalizes persisted maps", () => {
    assert.deepEqual(
      normalizeLastWorkspaceByServer({ a: "w", "": "x", b: "", c: 3 }),
      { a: "w" }
    );
    assert.deepEqual(normalizeLastWorkspaceByServer(["a"]), {});
  });

  test("reads and clears the pre-account device store", () => {
    assert.equal(readLegacyLastWorkspaceByServer(), null);
    globalThis.localStorage.setItem(
      LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY,
      JSON.stringify({ "server-a": "workspace-1", junk: 1 })
    );
    assert.deepEqual(readLegacyLastWorkspaceByServer(), { "server-a": "workspace-1" });
    clearLegacyLastWorkspaceByServer();
    assert.equal(readLegacyLastWorkspaceByServer(), null);
  });
});
