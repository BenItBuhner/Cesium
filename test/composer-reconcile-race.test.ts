import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPOSER_ECHO_QUEUE_LIMIT,
  planComposerReconcile,
  pushComposerEcho,
} from "../src/components/chat/composer-editor-utils.ts";

describe("pushComposerEcho", () => {
  test("appends reports and dedupes consecutive duplicates", () => {
    const queue: string[] = [];
    pushComposerEcho(queue, "a");
    pushComposerEcho(queue, "ab");
    pushComposerEcho(queue, "ab"); // selectionchange re-report of the same text
    pushComposerEcho(queue, "abc");
    assert.deepEqual(queue, ["a", "ab", "abc"]);
  });

  test("caps the queue at the configured limit", () => {
    const queue: string[] = [];
    for (let i = 0; i < COMPOSER_ECHO_QUEUE_LIMIT + 25; i += 1) {
      pushComposerEcho(queue, `text-${i}`);
    }
    assert.equal(queue.length, COMPOSER_ECHO_QUEUE_LIMIT);
    assert.equal(queue[0], "text-25");
    assert.equal(queue[queue.length - 1], `text-${COMPOSER_ECHO_QUEUE_LIMIT + 24}`);
  });
});

describe("planComposerReconcile", () => {
  test("skips a stale echo so newer keystrokes in the DOM survive", () => {
    // Android fast-typing race: user typed "ab"; the DOM already holds it, but
    // the reconcile effect flushes with the echo of the earlier "a" report.
    const plan = planComposerReconcile({
      value: "a",
      domText: "ab",
      isComposing: false,
      pendingEchoes: ["a", "ab"],
    });
    assert.equal(plan.action, "skip");
    // "a" is consumed; "ab" stays queued for its own echo.
    assert.deepEqual(plan.pendingEchoes, ["ab"]);
  });

  test("skips echoes that lag multiple keystrokes behind", () => {
    // Burst "abc" where the parent round-trip lags two keystrokes.
    let queue = ["a", "ab", "abc"];
    const first = planComposerReconcile({
      value: "a",
      domText: "abc",
      isComposing: false,
      pendingEchoes: queue,
    });
    assert.equal(first.action, "skip");
    queue = first.pendingEchoes;
    assert.deepEqual(queue, ["ab", "abc"]);

    const second = planComposerReconcile({
      value: "ab",
      domText: "abc",
      isComposing: false,
      pendingEchoes: queue,
    });
    assert.equal(second.action, "skip");
    assert.deepEqual(second.pendingEchoes, ["abc"]);
  });

  test("reconciles genuine external changes and resets the queue", () => {
    // Draft switch / history recall: the incoming value was never reported
    // from this DOM, so the DOM must be rebuilt even though the user typed.
    const plan = planComposerReconcile({
      value: "restored older draft",
      domText: "ab",
      isComposing: false,
      pendingEchoes: ["a", "ab"],
    });
    assert.equal(plan.action, "reconcile");
    assert.deepEqual(plan.pendingEchoes, []);
  });

  test("a consumed echo regains external-change semantics", () => {
    // Once "he" is pruned (its echo confirmed), a later external reset to the
    // very same string must reconcile instead of being mistaken for an echo.
    const first = planComposerReconcile({
      value: "he",
      domText: "hello",
      isComposing: false,
      pendingEchoes: ["he", "hel", "hell", "hello"],
    });
    assert.equal(first.action, "skip");

    const second = planComposerReconcile({
      value: "he",
      domText: "hello",
      isComposing: false,
      pendingEchoes: first.pendingEchoes,
    });
    assert.equal(second.action, "reconcile");
  });

  test("never rebuilds the DOM during IME composition", () => {
    // Even a genuine external change waits until compositionend; the queue is
    // preserved so echo tracking resumes intact afterwards.
    const plan = planComposerReconcile({
      value: "external",
      domText: "typing with ime",
      isComposing: true,
      pendingEchoes: ["typing with ime"],
    });
    assert.equal(plan.action, "skip");
    assert.deepEqual(plan.pendingEchoes, ["typing with ime"]);
  });

  test("reconciles pill-only mismatches when the text is already in sync", () => {
    // composerEditorDomInSync can fail on pill metadata (link title resolved)
    // while the plain text matches; that rebuild is safe and must proceed.
    const plan = planComposerReconcile({
      value: "see \u27E6link:abc\u27E7",
      domText: "see \u27E6link:abc\u27E7",
      isComposing: false,
      pendingEchoes: ["see \u27E6link:abc\u27E7"],
    });
    assert.equal(plan.action, "reconcile");
  });

  test("post-submit clear skips a late echo of the submitted prompt", () => {
    // submitComposer wipes the DOM to "" and records "" as the newest report.
    // A parent that re-applies the stale prompt afterwards must not resurrect
    // it in the editor.
    const queue: string[] = ["deploy the fix"];
    pushComposerEcho(queue, "");
    const plan = planComposerReconcile({
      value: "deploy the fix",
      domText: "",
      isComposing: false,
      pendingEchoes: queue,
    });
    assert.equal(plan.action, "skip");
    assert.deepEqual(plan.pendingEchoes, [""]);
  });
});
