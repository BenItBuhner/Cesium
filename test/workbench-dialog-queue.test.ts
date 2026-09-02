import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  activeDialogRequest,
  cancelAllDialogRequests,
  cancelDialogRequest,
  enqueueDialogRequest,
  normalizePromptValue,
  removeDialogRequest,
  resolveDialogRequest,
  validatePromptValue,
  type WorkbenchDialogRequest,
} from "../src/lib/workbench-dialog-queue.ts";

function confirmRequest(id: string, sink: unknown[]): WorkbenchDialogRequest {
  return {
    id,
    kind: "confirm",
    options: { title: `confirm ${id}` },
    resolve: (value) => sink.push(["confirm", id, value]),
  };
}

function alertRequest(id: string, sink: unknown[]): WorkbenchDialogRequest {
  return {
    id,
    kind: "alert",
    options: { title: `alert ${id}` },
    resolve: () => sink.push(["alert", id]),
  };
}

function promptRequest(id: string, sink: unknown[]): WorkbenchDialogRequest {
  return {
    id,
    kind: "prompt",
    options: { title: `prompt ${id}` },
    resolve: (value) => sink.push(["prompt", id, value]),
  };
}

describe("dialog queue ordering", () => {
  test("shows nothing when empty", () => {
    assert.equal(activeDialogRequest([]), null);
  });

  test("serializes requests FIFO - the oldest request is the active one", () => {
    const sink: unknown[] = [];
    let queue = enqueueDialogRequest([], confirmRequest("a", sink));
    queue = enqueueDialogRequest(queue, alertRequest("b", sink));
    queue = enqueueDialogRequest(queue, promptRequest("c", sink));
    assert.equal(activeDialogRequest(queue)?.id, "a");
    queue = removeDialogRequest(queue, "a");
    assert.equal(activeDialogRequest(queue)?.id, "b");
    queue = removeDialogRequest(queue, "b");
    assert.equal(activeDialogRequest(queue)?.id, "c");
  });

  test("enqueue and remove never mutate the input array", () => {
    const sink: unknown[] = [];
    const original: WorkbenchDialogRequest[] = [];
    const next = enqueueDialogRequest(original, confirmRequest("a", sink));
    assert.equal(original.length, 0);
    assert.equal(next.length, 1);
    const removed = removeDialogRequest(next, "a");
    assert.equal(next.length, 1);
    assert.equal(removed.length, 0);
  });

  test("removing an unknown id is a no-op", () => {
    const sink: unknown[] = [];
    const queue = enqueueDialogRequest([], confirmRequest("a", sink));
    assert.deepEqual(removeDialogRequest(queue, "zzz"), queue);
  });
});

describe("dialog resolution", () => {
  test("resolves each kind with its explicit result", () => {
    const sink: unknown[] = [];
    resolveDialogRequest(confirmRequest("a", sink), { kind: "confirm", value: true });
    resolveDialogRequest(alertRequest("b", sink), { kind: "alert" });
    resolveDialogRequest(promptRequest("c", sink), { kind: "prompt", value: "hello" });
    assert.deepEqual(sink, [
      ["confirm", "a", true],
      ["alert", "b"],
      ["prompt", "c", "hello"],
    ]);
  });

  test("cancel produces the dismissal value per kind", () => {
    const sink: unknown[] = [];
    cancelDialogRequest(confirmRequest("a", sink));
    cancelDialogRequest(alertRequest("b", sink));
    cancelDialogRequest(promptRequest("c", sink));
    assert.deepEqual(sink, [
      ["confirm", "a", false],
      ["alert", "b"],
      ["prompt", "c", null],
    ]);
  });

  test("a mismatched result kind degrades to a cancel instead of hanging", () => {
    const sink: unknown[] = [];
    resolveDialogRequest(confirmRequest("a", sink), { kind: "prompt", value: "oops" });
    resolveDialogRequest(promptRequest("b", sink), { kind: "confirm", value: true });
    assert.deepEqual(sink, [
      ["confirm", "a", false],
      ["prompt", "b", null],
    ]);
  });

  test("cancelAll settles every pending request and returns an empty queue", () => {
    const sink: unknown[] = [];
    let queue = enqueueDialogRequest([], confirmRequest("a", sink));
    queue = enqueueDialogRequest(queue, promptRequest("b", sink));
    const cleared = cancelAllDialogRequests(queue);
    assert.deepEqual(cleared, []);
    assert.deepEqual(sink, [
      ["confirm", "a", false],
      ["prompt", "b", null],
    ]);
  });
});

describe("prompt validation", () => {
  test("trims input", () => {
    assert.equal(normalizePromptValue("  feature/x  "), "feature/x");
  });

  test("rejects blank input unless allowEmpty is set", () => {
    assert.match(validatePromptValue({}, "   ") ?? "", /enter a value/i);
    assert.equal(validatePromptValue({ allowEmpty: true }, "   "), null);
  });

  test("runs the caller validator against the trimmed value", () => {
    const seen: string[] = [];
    const validate = (value: string) => {
      seen.push(value);
      return /^#[0-9a-f]{6}$/i.test(value) ? null : "bad hex";
    };
    assert.equal(validatePromptValue({ validate }, " #3b82f6 "), null);
    assert.equal(validatePromptValue({ validate }, "blue"), "bad hex");
    assert.deepEqual(seen, ["#3b82f6", "blue"]);
  });

  test("blank check runs before the caller validator", () => {
    let called = false;
    const validate = () => {
      called = true;
      return null;
    };
    assert.notEqual(validatePromptValue({ validate }, ""), null);
    assert.equal(called, false);
  });
});
