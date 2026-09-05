import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import {
  LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY,
  clearLegacyPinnedAgentConversationIds,
  normalizePinnedAgentConversationIds,
  pinAgentConversationId,
  readLegacyPinnedAgentConversationIds,
  unpinAgentConversationId,
} from "../src/lib/agent-rail-pins.ts";

const LEGACY_SESSION_KEY = "opencursor.workspace-session.ws-1";

function createLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

const localStorageStub = createLocalStorageStub();

before(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: localStorageStub },
  });
});

beforeEach(() => {
  localStorageStub.clear();
});

function seedLegacySession(pinnedIds: string[]): void {
  localStorageStub.setItem(
    LEGACY_SESSION_KEY,
    JSON.stringify({ session: { agentView: { pinnedAgentConversationIds: pinnedIds } } })
  );
}

describe("agent rail pins (account setting helpers)", () => {
  test("normalizes and dedupes ids", () => {
    assert.deepEqual(normalizePinnedAgentConversationIds(["a", "b", "a", "", 3]), ["a", "b"]);
    assert.deepEqual(normalizePinnedAgentConversationIds("nope"), []);
  });

  test("pin moves the id to the front and is a no-op when already first", () => {
    const pinned = ["a", "b"];
    assert.deepEqual(pinAgentConversationId(pinned, "b"), ["b", "a"]);
    assert.deepEqual(pinAgentConversationId(pinned, "c"), ["c", "a", "b"]);
    assert.equal(pinAgentConversationId(pinned, "a"), pinned);
  });

  test("unpin removes the id and is a no-op when absent", () => {
    const pinned = ["a", "b"];
    assert.deepEqual(unpinAgentConversationId(pinned, "a"), ["b"]);
    assert.equal(unpinAgentConversationId(pinned, "zzz"), pinned);
  });
});

describe("agent rail pins legacy device store", () => {
  test("reads the pre-account global list, then legacy session backups, deduped", () => {
    localStorageStub.setItem(
      LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY,
      JSON.stringify(["global-1", "shared"])
    );
    seedLegacySession(["legacy-1", "shared", "legacy-2"]);
    assert.deepEqual(readLegacyPinnedAgentConversationIds(), [
      "global-1",
      "shared",
      "legacy-1",
      "legacy-2",
    ]);
  });

  test("falls back to the in-memory session list and reports null when nothing existed", () => {
    assert.equal(readLegacyPinnedAgentConversationIds(), null);
    assert.deepEqual(readLegacyPinnedAgentConversationIds(["fallback-1"]), ["fallback-1"]);
  });

  test("an explicitly empty legacy list is still 'found' (deliberate unpin-all)", () => {
    localStorageStub.setItem(LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY, JSON.stringify([]));
    assert.deepEqual(readLegacyPinnedAgentConversationIds(), []);
  });

  test("clear removes the legacy global key", () => {
    localStorageStub.setItem(LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY, JSON.stringify(["a"]));
    clearLegacyPinnedAgentConversationIds();
    assert.equal(localStorageStub.getItem(LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY), null);
  });
});
