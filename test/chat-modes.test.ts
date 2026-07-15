import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ensureCurrentModeOption,
  getModeTone,
  isOrchestrationMode,
  isOrchestrationModeLocked,
  resolveCanonicalModeId,
} from "../src/lib/chat-modes.ts";

describe("chat modes", () => {
  test("preserves orchestration as a concrete mode when the backend option list is stale", () => {
    assert.equal(
      resolveCanonicalModeId("orchestration", [{ id: "agent", label: "Agent" }]),
      "orchestration"
    );
    assert.deepEqual(
      ensureCurrentModeOption("orchestration", [{ id: "agent", label: "Agent" }])[0],
      { id: "orchestration", label: "Orchestration" }
    );
  });

  test("uses purple orchestration emphasis for orchestration mode", () => {
    assert.equal(getModeTone("orchestration"), "orchestration");
  });

  test("uses burn emphasis for Burn mode", () => {
    assert.equal(getModeTone("burn"), "burn");
    assert.equal(resolveCanonicalModeId("Burn", [{ id: "burn", label: "Burn" }]), "burn");
  });

  test("detects orchestration mode case-insensitively", () => {
    assert.equal(isOrchestrationMode("orchestration"), true);
    assert.equal(isOrchestrationMode(" Orchestration "), true);
    assert.equal(isOrchestrationMode("plan"), false);
  });

  test("does not lock orchestration mode after chat initiation", () => {
    assert.equal(isOrchestrationModeLocked("orchestration", false), false);
    assert.equal(isOrchestrationModeLocked("orchestration", true), false);
    assert.equal(isOrchestrationModeLocked("plan", true), false);
    assert.equal(isOrchestrationModeLocked("agent", false), false);
  });
});
