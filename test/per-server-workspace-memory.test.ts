import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import {
  getLastWorkspaceForServer,
  rememberLastWorkspaceForServer,
} from "../src/lib/per-server-workspace-memory.ts";

const STORAGE_KEY = "opencursor.last-workspace-by-server";

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
  globalThis.localStorage.removeItem(STORAGE_KEY);
});

describe("per-server workspace memory", () => {
  test("remembers and restores last workspace per server", () => {
    rememberLastWorkspaceForServer("server-a", "workspace-1");
    rememberLastWorkspaceForServer("server-b", "workspace-2");
    assert.equal(getLastWorkspaceForServer("server-a"), "workspace-1");
    assert.equal(getLastWorkspaceForServer("server-b"), "workspace-2");
    assert.equal(getLastWorkspaceForServer("server-c"), null);
  });
});
