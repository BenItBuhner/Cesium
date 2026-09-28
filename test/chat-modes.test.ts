import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_MODE_OPTIONS,
  ensureCurrentModeOption,
  getModeTone,
  resolveCanonicalModeId,
  resolveNextModeInCycle,
} from "../src/lib/chat-modes.ts";

describe("chat modes", () => {
  test("backends without a mode option get a single-entry catalog", () => {
    assert.deepEqual(DEFAULT_MODE_OPTIONS, [{ id: "agent", label: "Agent" }]);
    assert.equal(resolveNextModeInCycle("agent", DEFAULT_MODE_OPTIONS), null);
  });

  test("a mode the backend does not offer resolves to its first option", () => {
    assert.equal(resolveCanonicalModeId("plan", DEFAULT_MODE_OPTIONS), "agent");
    assert.equal(resolveCanonicalModeId("goal", DEFAULT_MODE_OPTIONS), "agent");
    assert.equal(
      resolveCanonicalModeId("agent", [
        { id: "default", label: "Default" },
        { id: "plan", label: "Plan" },
      ]),
      "default"
    );
  });

  test("aliases map onto the backend's concrete mode ids", () => {
    const options = [
      { id: "build", label: "Build" },
      { id: "architect", label: "Architect" },
    ];
    assert.equal(resolveCanonicalModeId("agent", options), "build");
    assert.equal(resolveCanonicalModeId("Plan", options), "architect");
  });

  test("third-party mode tones", () => {
    assert.equal(getModeTone("plan"), "plan");
    assert.equal(getModeTone("debug"), "debug");
    assert.equal(getModeTone("read-only"), "ask");
    assert.equal(getModeTone("acceptEdits"), "agent");
    assert.equal(getModeTone("orchestration"), "agent");
  });

  test("cycles only through the effective mode catalog", () => {
    const enabled = [
      { id: "agent", label: "Agent" },
      { id: "plan", label: "Plan" },
      { id: "ask", label: "Ask" },
    ];
    assert.equal(resolveNextModeInCycle("agent", enabled), "plan");
    assert.equal(resolveNextModeInCycle("plan", enabled), "ask");
    assert.equal(resolveNextModeInCycle("ask", enabled), "agent");
  });

  test("exits a stale active mode and preserves focus with one mode", () => {
    assert.deepEqual(ensureCurrentModeOption("plan", DEFAULT_MODE_OPTIONS)[0], {
      id: "plan",
      label: "Plan",
    });
    assert.equal(resolveNextModeInCycle("plan", DEFAULT_MODE_OPTIONS), "agent");
  });
});
