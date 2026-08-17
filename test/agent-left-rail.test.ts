import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLeftRailCollapsed,
  shouldRestorePersistedLeftRailCollapsed,
} from "../src/lib/agent-left-rail";

test("fresh mobile session starts with the rail collapsed", () => {
  assert.equal(
    resolveLeftRailCollapsed({
      isMobile: true,
      persistedLeftRailCollapsed: null,
    }),
    true
  );
});

test("fresh tablet/desktop session starts with the rail open", () => {
  assert.equal(
    resolveLeftRailCollapsed({
      isMobile: false,
      persistedLeftRailCollapsed: null,
    }),
    false
  );
});

test("an explicit preference wins on every viewport", () => {
  assert.equal(
    resolveLeftRailCollapsed({
      isMobile: true,
      persistedLeftRailCollapsed: false,
    }),
    false
  );
  assert.equal(
    resolveLeftRailCollapsed({
      isMobile: false,
      persistedLeftRailCollapsed: true,
    }),
    true
  );
});

test("only tablet/desktop restore a stored rail preference on hydrate", () => {
  assert.equal(shouldRestorePersistedLeftRailCollapsed(true), false);
  assert.equal(shouldRestorePersistedLeftRailCollapsed(false), true);
});
