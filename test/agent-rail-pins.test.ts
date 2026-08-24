import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import {
  AGENT_RAIL_PINNED_IDS_STORAGE_KEY,
  getGlobalPinnedAgentConversationIdsSnapshot,
  migrateGlobalPinnedAgentConversationIdsIfNeeded,
  writeGlobalPinnedAgentConversationIds,
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

describe("agent rail pins", () => {
  test("write + snapshot round-trips and dedupes", () => {
    writeGlobalPinnedAgentConversationIds(["a", "b", "a", ""]);
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), ["a", "b"]);
  });

  test("migration seeds global pins from legacy session keys when the key is absent", () => {
    seedLegacySession(["legacy-1", "legacy-2"]);
    migrateGlobalPinnedAgentConversationIdsIfNeeded();
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), ["legacy-1", "legacy-2"]);
  });

  test("migration folds in the react session fallback", () => {
    migrateGlobalPinnedAgentConversationIdsIfNeeded(["fallback-1"]);
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), ["fallback-1"]);
  });

  test("unpinning the last conversation is not undone by re-migration", () => {
    // Legacy backup still references the conversation (session backups lag).
    seedLegacySession(["conv-1"]);
    migrateGlobalPinnedAgentConversationIdsIfNeeded(["conv-1"]);
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), ["conv-1"]);

    // User unpins the only pinned conversation -> empty list is deliberate.
    writeGlobalPinnedAgentConversationIds([]);
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), []);

    // The migration effect re-runs on every session change; it must NOT
    // resurrect the pin from the stale legacy session backup.
    migrateGlobalPinnedAgentConversationIdsIfNeeded(["conv-1"]);
    assert.deepEqual(getGlobalPinnedAgentConversationIdsSnapshot(), []);
    assert.equal(
      localStorageStub.getItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY),
      "[]"
    );
  });
});
