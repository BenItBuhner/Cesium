import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CAPABILITY_KEYS as CORE_AGENT_CAPABILITY_KEYS,
  AGENT_STORED_EVENT_KINDS as CORE_AGENT_STORED_EVENT_KINDS,
} from "../../packages/core/src/protocol.ts";
import {
  AGENT_CAPABILITY_KEYS,
  AGENT_STORED_EVENT_KINDS,
  BACKEND_HARNESS_EXPECTATIONS,
} from "../src/lib/agents/agent-contract.js";
import { AGENT_BACKENDS } from "../src/lib/agents/providers.js";
import type { AgentBackendId } from "../src/lib/agents/types.js";

test("core protocol constants stay aligned with server harness contract", () => {
  assert.deepEqual([...CORE_AGENT_CAPABILITY_KEYS], [...AGENT_CAPABILITY_KEYS]);
  assert.deepEqual([...CORE_AGENT_STORED_EVENT_KINDS], [...AGENT_STORED_EVENT_KINDS]);
});

test("every registered backend has harness expectations", () => {
  const registered = Object.keys(AGENT_BACKENDS).sort();
  const expected = Object.keys(BACKEND_HARNESS_EXPECTATIONS).sort();
  assert.deepEqual(expected, registered);
});

test("backend capabilities are complete and matched by expectation matrix", () => {
  const knownEventKinds = new Set<string>(AGENT_STORED_EVENT_KINDS);

  for (const [backendId, backend] of Object.entries(AGENT_BACKENDS) as Array<
    [AgentBackendId, (typeof AGENT_BACKENDS)[AgentBackendId]]
  >) {
    assert.deepEqual(
      Object.keys(backend.capabilities).sort(),
      [...AGENT_CAPABILITY_KEYS].sort(),
      `${backendId} capabilities drifted`
    );

    const expectation = BACKEND_HARNESS_EXPECTATIONS[backendId];
    assert.ok(expectation.expectedEventKinds.includes("user_message"), backendId);
    assert.ok(expectation.expectedEventKinds.includes("status"), backendId);

    if (backend.capabilities.supportsToolCalls) {
      assert.ok(expectation.expectedEventKinds.includes("tool_call"), backendId);
      assert.ok(expectation.expectedEventKinds.includes("tool_call_update"), backendId);
    }
    if (backend.capabilities.supportsStructuredPlans || backend.capabilities.supportsTodos) {
      assert.ok(expectation.expectedEventKinds.includes("plan"), backendId);
    }
    if (backend.capabilities.supportsPermissions) {
      assert.ok(expectation.expectedEventKinds.includes("permission_request"), backendId);
      assert.ok(expectation.expectedEventKinds.includes("permission_resolved"), backendId);
    }

    for (const kind of expectation.expectedEventKinds) {
      assert.ok(knownEventKinds.has(kind), `${backendId} references unknown event kind ${kind}`);
    }
  }
});
