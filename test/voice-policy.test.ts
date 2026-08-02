import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestSpokenText,
  diffConversationsForNotifications,
  type VoiceWatchedConversation,
} from "../src/lib/voice/notification-policy.ts";
import { parseLocalVoiceCommand } from "../src/lib/voice/local-commands.ts";
import { splitIntoClauses } from "../src/lib/voice/clauses.ts";

function record(
  overrides: Partial<VoiceWatchedConversation> & { id: string }
): VoiceWatchedConversation {
  return {
    title: `Session ${overrides.id}`,
    status: "idle",
    pendingPermissionTitle: null,
    pendingQuestion: false,
    lastError: null,
    ...overrides,
  };
}

test("permission requests speak promptly", () => {
  const before = new Map([["a", record({ id: "a", status: "running" })]]);
  const notifications = diffConversationsForNotifications(before, [
    record({
      id: "a",
      status: "awaiting_permission",
      pendingPermissionTitle: "Run npm install",
    }),
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.kind, "permission");
  assert.equal(notifications[0]!.policy, "speak");
  assert.match(notifications[0]!.spokenText, /needs permission/i);
  assert.match(notifications[0]!.spokenText, /Run npm install/);
});

test("agent questions and blocking failures speak promptly", () => {
  const before = new Map([
    ["q", record({ id: "q", status: "running" })],
    ["f", record({ id: "f", status: "running" })],
  ]);
  const notifications = diffConversationsForNotifications(before, [
    record({ id: "q", status: "awaiting_question", pendingQuestion: true }),
    record({ id: "f", status: "failed", lastError: "compile error" }),
  ]);
  const kinds = notifications.map((n) => `${n.kind}:${n.policy}`).sort();
  assert.deepEqual(kinds, ["failure:speak", "question:speak"]);
});

test("routine completions queue instead of interrupting", () => {
  const before = new Map([["a", record({ id: "a", status: "running" })]]);
  const notifications = diffConversationsForNotifications(before, [
    record({ id: "a", status: "idle" }),
  ]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.kind, "completion");
  assert.equal(notifications[0]!.policy, "queue");
});

test("explicitly watched completions speak", () => {
  const before = new Map([["a", record({ id: "a", status: "running" })]]);
  const notifications = diffConversationsForNotifications(
    before,
    [record({ id: "a", status: "idle" })],
    { speakCompletionsFor: new Set(["a"]) }
  );
  assert.equal(notifications[0]!.policy, "speak");
});

test("unseen conversations are primed silently (no initial-load flood)", () => {
  const notifications = diffConversationsForNotifications(new Map(), [
    record({ id: "new", status: "failed", lastError: "boom" }),
  ]);
  assert.equal(notifications.length, 0);
});

test("digest folds several queued events into one summary", () => {
  const before = new Map([
    ["a", record({ id: "a", status: "running", title: "Auth fix" })],
    ["b", record({ id: "b", status: "running", title: "Mobile build" })],
    ["c", record({ id: "c", status: "running", title: "Research" })],
  ]);
  const notifications = diffConversationsForNotifications(before, [
    record({ id: "a", status: "idle", title: "Auth fix" }),
    record({ id: "b", status: "failed", title: "Mobile build" }),
    record({ id: "c", status: "idle", title: "Research" }),
  ]);
  const digest = buildDigestSpokenText(notifications);
  assert.match(digest, /^Three things happened/);
  assert.match(digest, /Auth fix finished/);
  assert.match(digest, /Mobile build hit a failure/);
  const single = buildDigestSpokenText([notifications[0]!]);
  assert.equal(single, notifications[0]!.spokenText);
});

test("local commands match whole utterances only", () => {
  assert.deepEqual(parseLocalVoiceCommand("Stop."), { kind: "stop_speaking" });
  assert.deepEqual(parseLocalVoiceCommand("stop talking"), {
    kind: "stop_speaking",
  });
  assert.deepEqual(parseLocalVoiceCommand("Go quiet"), { kind: "quiet_mode" });
  assert.deepEqual(parseLocalVoiceCommand("pause listening"), {
    kind: "pause_listening",
  });
  assert.deepEqual(parseLocalVoiceCommand("resume listening"), {
    kind: "resume_listening",
  });
  // Never hijack real requests that merely contain command words.
  assert.equal(parseLocalVoiceCommand("stop the dev server"), null);
  assert.equal(parseLocalVoiceCommand("can you pause the tests"), null);
});

test("clause splitting produces speakable chunks and folds fragments", () => {
  const clauses = splitIntoClauses(
    "I started two agents. One is tracing the authentication path; the other is building regression coverage. Ping me if anything needs permission."
  );
  assert.ok(clauses.length >= 2);
  assert.match(clauses[0]!, /^I started two agents\./);
  // Short fragments merge with neighbors.
  const merged = splitIntoClauses("Done. All tests pass now.");
  assert.equal(merged.length, 1);
  // Empty input yields nothing.
  assert.deepEqual(splitIntoClauses("   "), []);
});
