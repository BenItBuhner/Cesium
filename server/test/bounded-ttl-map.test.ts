import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedTtlMap } from "../src/lib/bounded-ttl-map.js";

function clockedMap(options: { maxEntries: number; ttlMs: number }) {
  let now = 0;
  const map = new BoundedTtlMap<string, number>({ ...options, now: () => now });
  return { map, advance: (ms: number) => (now += ms) };
}

test("entries idle past the TTL expire; entries in use do not", () => {
  const { map, advance } = clockedMap({ maxEntries: 10, ttlMs: 1_000 });
  map.set("idle", 1);
  map.set("active", 2);
  for (let step = 0; step < 5; step += 1) {
    advance(600);
    assert.equal(map.get("active"), 2, "a read refreshes the entry");
  }
  assert.equal(map.get("idle"), undefined, "the untouched entry expired");
  assert.equal(map.size, 1);
});

test("past maxEntries the least recently used entry goes first", () => {
  const { map, advance } = clockedMap({ maxEntries: 3, ttlMs: 60_000 });
  for (const key of ["a", "b", "c"]) {
    map.set(key, 0);
    advance(1);
  }
  map.get("a");
  map.set("d", 0);
  assert.deepEqual([...map.keys()], ["c", "a", "d"], "b was the least recently used");
  assert.equal(map.has("a"), true, "a was read after b");
  assert.equal(map.size, 3);
});

test("expired entries are swept on any access, not only on their own key", () => {
  const { map, advance } = clockedMap({ maxEntries: 100, ttlMs: 1_000 });
  for (let index = 0; index < 50; index += 1) {
    map.set(`k${index}`, index);
  }
  advance(1_500);
  map.set("fresh", 1);
  assert.equal(map.size, 1);
});
