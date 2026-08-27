import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  createMemoryKeyValueStore,
  setClientPlatform,
  getClientPlatform,
} from "../packages/client/src/index.ts";
import {
  adoptOnboardingForAccount,
  isOnboardingFinished,
  markStepComplete,
  mergeOnboardingState,
  ONBOARDING_STORAGE_KEY,
  onboardingStorageKey,
  readOnboardingState,
  writeOnboardingState,
} from "../src/lib/onboarding/state.ts";

const originalPlatform = getClientPlatform();

function useMemoryStore() {
  const store = createMemoryKeyValueStore();
  setClientPlatform({
    ...originalPlatform,
    keyValueStore: store,
  });
  return store;
}

afterEach(() => {
  setClientPlatform(originalPlatform);
});

describe("account-bound onboarding state", () => {
  test("scopes progress to the signed-in account key", () => {
    useMemoryStore();
    writeOnboardingState(
      { completedSteps: ["connect-server"], completedAt: null },
      "clerk:alice"
    );
    writeOnboardingState(
      { completedSteps: ["agents"], completedAt: null },
      "clerk:bob"
    );

    assert.deepEqual(readOnboardingState("clerk:alice").completedSteps, [
      "connect-server",
    ]);
    assert.deepEqual(readOnboardingState("clerk:bob").completedSteps, ["agents"]);
    assert.deepEqual(readOnboardingState(null).completedSteps, []);
    assert.equal(
      onboardingStorageKey("clerk:alice"),
      `${ONBOARDING_STORAGE_KEY}:clerk:alice`
    );
  });

  test("adopts guest progress into a new account once", () => {
    useMemoryStore();
    writeOnboardingState(
      { completedSteps: ["connect-server", "agents"], completedAt: null },
      null
    );

    const adopted = adoptOnboardingForAccount("clerk:new");
    assert.deepEqual(adopted.completedSteps, ["connect-server", "agents"]);
    assert.deepEqual(readOnboardingState("clerk:new").completedSteps, [
      "connect-server",
      "agents",
    ]);

    writeOnboardingState(
      { completedSteps: ["import"], completedAt: 10 },
      null
    );
    const again = adoptOnboardingForAccount("clerk:new");
    assert.deepEqual(again.completedSteps, ["connect-server", "agents"]);
  });

  test("merges cloud steps additively without dropping local ones", () => {
    const merged = mergeOnboardingState(
      { completedSteps: ["connect-server"], completedAt: null },
      { completedSteps: ["agents", "bogus"], completedAt: 99 }
    );
    assert.deepEqual(merged.completedSteps, ["connect-server", "agents"]);
    assert.equal(merged.completedAt, 99);
  });

  test("markStepComplete is idempotent and isOnboardingFinished checks required steps", () => {
    const once = markStepComplete(
      { completedSteps: [], completedAt: null },
      "connect-server"
    );
    const twice = markStepComplete(once, "connect-server");
    assert.equal(once, twice);
    assert.equal(
      isOnboardingFinished(once, ["connect-server", "agents"]),
      false
    );
    assert.equal(isOnboardingFinished(once, ["connect-server"]), true);
  });
});
