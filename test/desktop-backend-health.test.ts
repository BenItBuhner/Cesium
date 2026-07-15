import assert from "node:assert/strict";
import test from "node:test";

function healthIsReady(payload) {
  return payload?.ok === true && payload?.bootstrapping !== true;
}

test("healthIsReady accepts fully booted payload", () => {
  assert.equal(healthIsReady({ ok: true, transcription: { configured: false } }), true);
});

test("healthIsReady rejects bootstrapping payload", () => {
  assert.equal(healthIsReady({ ok: true, bootstrapping: true }), false);
});

test("healthIsReady rejects missing ok", () => {
  assert.equal(healthIsReady({ bootstrapping: true }), false);
  assert.equal(healthIsReady(null), false);
});
