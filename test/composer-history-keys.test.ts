import assert from "node:assert/strict";
import { test } from "node:test";

test("isArrowUpKey matches ArrowUp code when key is Unidentified (IME)", async () => {
  const { isArrowUpKey, isArrowDownKey } = await import(
    "../src/components/input/text-buffer.ts"
  );
  assert.equal(isArrowUpKey({ key: "Unidentified", code: "ArrowUp" }), true);
  assert.equal(isArrowUpKey({ key: "ArrowUp", code: "" }), true);
  assert.equal(isArrowUpKey({ key: "ArrowDown", code: "ArrowDown" }), false);
  assert.equal(isArrowDownKey({ key: "Unidentified", code: "ArrowDown" }), true);
  assert.equal(isArrowDownKey({ key: "ArrowUp", code: "ArrowUp" }), false);
});
