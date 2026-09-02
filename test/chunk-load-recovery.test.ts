import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  CHUNK_RELOAD_GRACE_MS,
  CHUNK_RELOAD_STORAGE_KEY,
  CHUNK_RETRY_DELAY_MS,
  canReloadForStaleChunks,
  isChunkLoadError,
  loadChunkWithRecovery,
  reloadForStaleChunks,
} from "../src/lib/chunk-load-recovery.ts";

function turbopackChunkError(): Error {
  // Exact shape thrown by the Next 16 Turbopack runtime (see the user-facing
  // console: "Uncaught ChunkLoadError: Failed to load chunk ... from module 66735").
  const error = new Error(
    "Failed to load chunk /_next/static/chunks/2ff386cc4637a09a.js from module 66735"
  );
  error.name = "ChunkLoadError";
  return error;
}

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class ExplodingStorage {
  getItem(): string | null {
    throw new Error("storage disabled");
  }
  setItem(): void {
    throw new Error("storage disabled");
  }
}

describe("isChunkLoadError", () => {
  test("recognises the Turbopack ChunkLoadError by name", () => {
    assert.equal(isChunkLoadError(turbopackChunkError()), true);
  });

  test("recognises the Turbopack message even without the name", () => {
    assert.equal(
      isChunkLoadError(new Error("Failed to load chunk /_next/static/chunks/a.js from module 1")),
      true
    );
  });

  test("recognises webpack chunk and CSS chunk failures", () => {
    assert.equal(isChunkLoadError(new Error("Loading chunk 123 failed.")), true);
    assert.equal(isChunkLoadError(new Error("Loading CSS chunk app-layout failed.")), true);
  });

  test("recognises native dynamic import failures across browsers", () => {
    assert.equal(
      isChunkLoadError(
        new TypeError("Failed to fetch dynamically imported module: https://x/y.js")
      ),
      true
    );
    assert.equal(
      isChunkLoadError(new TypeError("error loading dynamically imported module")),
      true
    );
    assert.equal(isChunkLoadError(new TypeError("Importing a module script failed.")), true);
    assert.equal(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css")), true);
  });

  test("walks error.cause", () => {
    const wrapped = new Error("panel failed to mount", { cause: turbopackChunkError() });
    assert.equal(isChunkLoadError(wrapped), true);
  });

  test("survives a cyclic cause chain", () => {
    const error = new Error("looping") as Error & { cause?: unknown };
    error.cause = error;
    assert.equal(isChunkLoadError(error), false);
  });

  test("accepts raw message strings", () => {
    assert.equal(isChunkLoadError("Loading chunk 9 failed"), true);
    assert.equal(isChunkLoadError("nope"), false);
  });

  test("ignores unrelated failures", () => {
    // A bare fetch failure to an engine is NOT a chunk problem and must not
    // trigger a reload.
    assert.equal(isChunkLoadError(new TypeError("Failed to fetch")), false);
    assert.equal(
      isChunkLoadError(new Error("Revision conflict: server rejected If-Match")),
      false
    );
    assert.equal(isChunkLoadError(null), false);
    assert.equal(isChunkLoadError(undefined), false);
    assert.equal(isChunkLoadError(42), false);
    assert.equal(isChunkLoadError({}), false);
  });
});

describe("reloadForStaleChunks", () => {
  test("reloads once and stamps session storage", () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const result = reloadForStaleChunks({
      storage,
      now: () => 1_000,
      reload: () => {
        reloads += 1;
      },
    });
    assert.equal(result, true);
    assert.equal(reloads, 1);
    assert.equal(storage.getItem(CHUNK_RELOAD_STORAGE_KEY), "1000");
  });

  test("refuses a second reload inside the cooldown window", () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const reload = () => {
      reloads += 1;
    };
    assert.equal(reloadForStaleChunks({ storage, now: () => 1_000, reload }), true);
    assert.equal(
      reloadForStaleChunks({
        storage,
        now: () => 1_000 + CHUNK_RELOAD_COOLDOWN_MS - 1,
        reload,
      }),
      false
    );
    assert.equal(reloads, 1);
  });

  test("allows a reload again once the cooldown has elapsed", () => {
    const storage = new MemoryStorage();
    let reloads = 0;
    const reload = () => {
      reloads += 1;
    };
    reloadForStaleChunks({ storage, now: () => 1_000, reload });
    assert.equal(
      reloadForStaleChunks({ storage, now: () => 1_000 + CHUNK_RELOAD_COOLDOWN_MS, reload }),
      true
    );
    assert.equal(reloads, 2);
    assert.equal(storage.getItem(CHUNK_RELOAD_STORAGE_KEY), String(1_000 + CHUNK_RELOAD_COOLDOWN_MS));
  });

  test("treats a stamp from the future as recent", () => {
    const storage = new MemoryStorage();
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, "5000");
    assert.equal(canReloadForStaleChunks({ storage, now: () => 4_000, reload: () => {} }), false);
    assert.equal(
      canReloadForStaleChunks({
        storage,
        now: () => 5_000 - CHUNK_RELOAD_COOLDOWN_MS,
        reload: () => {},
      }),
      true
    );
  });

  test("ignores garbage stamps", () => {
    const storage = new MemoryStorage();
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, "not-a-number");
    assert.equal(canReloadForStaleChunks({ storage, now: () => 1, reload: () => {} }), true);
  });

  test("still reloads when session storage is unavailable or throws", () => {
    let reloads = 0;
    const reload = () => {
      reloads += 1;
    };
    assert.equal(reloadForStaleChunks({ storage: null, now: () => 1, reload }), true);
    assert.equal(
      reloadForStaleChunks({ storage: new ExplodingStorage(), now: () => 1, reload }),
      true
    );
    assert.equal(reloads, 2);
  });

  test("canReloadForStaleChunks never writes", () => {
    const storage = new MemoryStorage();
    assert.equal(canReloadForStaleChunks({ storage, now: () => 1, reload: () => {} }), true);
    assert.equal(storage.data.size, 0);
  });

  test("does nothing without a window or an injected reload", () => {
    assert.equal(canReloadForStaleChunks({ storage: new MemoryStorage() }), false);
    assert.equal(reloadForStaleChunks({ storage: new MemoryStorage() }), false);
  });
});

describe("loadChunkWithRecovery", () => {
  function harness(now = 10_000) {
    const sleeps: number[] = [];
    let reloads = 0;
    const storage = new MemoryStorage();
    const deps = {
      storage,
      now: () => now,
      reload: () => {
        reloads += 1;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };
    return { deps, sleeps, storage, reloads: () => reloads };
  }

  test("passes a successful import straight through", async () => {
    const { deps, sleeps, reloads } = harness();
    let calls = 0;
    const value = await loadChunkWithRecovery(async () => {
      calls += 1;
      return "Terminal";
    }, deps);
    assert.equal(value, "Terminal");
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(reloads(), 0);
  });

  test("rethrows non-chunk errors without retrying or reloading", async () => {
    const { deps, sleeps, reloads } = harness();
    let calls = 0;
    const boom = new Error("module threw during evaluation");
    await assert.rejects(
      loadChunkWithRecovery(async () => {
        calls += 1;
        throw boom;
      }, deps),
      (error) => error === boom
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(reloads(), 0);
  });

  test("retries once after a transient chunk failure", async () => {
    const { deps, sleeps, reloads } = harness();
    let calls = 0;
    const value = await loadChunkWithRecovery(async () => {
      calls += 1;
      if (calls === 1) throw turbopackChunkError();
      return "Terminal";
    }, deps);
    assert.equal(value, "Terminal");
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [CHUNK_RETRY_DELAY_MS]);
    assert.equal(reloads(), 0);
  });

  test("reloads the page when the retry also fails on a stale chunk", async () => {
    const { deps, sleeps, storage, reloads } = harness(42_000);
    let calls = 0;
    const failure = turbopackChunkError();
    await assert.rejects(
      loadChunkWithRecovery(async () => {
        calls += 1;
        throw failure;
      }, deps),
      (error) => error === failure
    );
    assert.equal(calls, 2);
    assert.equal(reloads(), 1);
    assert.equal(storage.getItem(CHUNK_RELOAD_STORAGE_KEY), "42000");
    // Retry delay, then the grace period that parks the Suspense fallback
    // while the navigation happens.
    assert.deepEqual(sleeps, [CHUNK_RETRY_DELAY_MS, CHUNK_RELOAD_GRACE_MS]);
  });

  test("surfaces the error instead of looping when a reload just happened", async () => {
    const { deps, sleeps, storage, reloads } = harness(42_000);
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(42_000 - 5_000));
    const failure = turbopackChunkError();
    await assert.rejects(
      loadChunkWithRecovery(async () => {
        throw failure;
      }, deps),
      (error) => error === failure
    );
    assert.equal(reloads(), 0);
    assert.deepEqual(sleeps, [CHUNK_RETRY_DELAY_MS]);
  });

  test("does not reload when the retry fails for an unrelated reason", async () => {
    const { deps, reloads } = harness();
    let calls = 0;
    const evaluationError = new Error("Cannot read properties of undefined");
    await assert.rejects(
      loadChunkWithRecovery(async () => {
        calls += 1;
        if (calls === 1) throw turbopackChunkError();
        throw evaluationError;
      }, deps),
      (error) => error === evaluationError
    );
    assert.equal(calls, 2);
    assert.equal(reloads(), 0);
  });
});
