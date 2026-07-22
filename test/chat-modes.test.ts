import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ensureCurrentModeOption,
  getModeTone,
  isOrchestrationMode,
  isOrchestrationModeLocked,
  resolveCanonicalModeId,
  resolveNextModeInCycle,
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

  test("uses goal emphasis for Goal mode", () => {
    assert.equal(getModeTone("goal"), "goal");
    assert.equal(resolveCanonicalModeId("Goal", [{ id: "goal", label: "Goal" }]), "goal");
  });

  test("uses workflow emphasis for Workflow mode", () => {
    assert.equal(getModeTone("workflow"), "workflow");
    assert.equal(
      resolveCanonicalModeId("Workflow", [{ id: "workflow", label: "Workflow" }]),
      "workflow"
    );
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

  test("cycles only through the effective mode catalog", () => {
    const enabled = [
      { id: "agent", label: "Agent" },
      { id: "workflow", label: "Workflow" },
      { id: "ask", label: "Ask" },
    ];
    assert.equal(resolveNextModeInCycle("agent", enabled), "workflow");
    assert.equal(resolveNextModeInCycle("workflow", enabled), "ask");
    assert.equal(resolveNextModeInCycle("ask", enabled), "agent");
  });

  test("exits a disabled active mode and preserves focus with one mode", () => {
    assert.equal(
      resolveNextModeInCycle("plan", [{ id: "agent", label: "Agent" }]),
      "agent"
    );
    assert.equal(
      resolveNextModeInCycle("agent", [{ id: "agent", label: "Agent" }]),
      null
    );
  });
});
