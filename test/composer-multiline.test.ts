import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isComposerEffectivelyEmptyForMultiline,
  resolveComposerIsMultiLine,
  shouldLatchComposerMultiline,
} from "../src/components/chat/composer-multiline.ts";

describe("composer multiline layout", () => {
  test("treats newline-only input as non-empty once layout wraps", () => {
    assert.equal(
      isComposerEffectivelyEmptyForMultiline("\n\n\n", true),
      false
    );
    assert.equal(shouldLatchComposerMultiline("\n\n\n", true), true);
    assert.equal(
      resolveComposerIsMultiLine({
        useStickyMultiline: true,
        hookMeasuresMultiline: true,
        latchedMultiline: false,
        value: "\n\n\n",
      }),
      true
    );
  });

  test("still treats a lone phantom newline as empty when layout is single-line", () => {
    assert.equal(isComposerEffectivelyEmptyForMultiline("\n", false), true);
    assert.equal(shouldLatchComposerMultiline("\n", false), false);
    assert.equal(
      resolveComposerIsMultiLine({
        useStickyMultiline: true,
        hookMeasuresMultiline: false,
        latchedMultiline: true,
        value: "\n",
      }),
      false
    );
  });

  test("clears sticky multiline when value is fully empty", () => {
    assert.equal(
      resolveComposerIsMultiLine({
        useStickyMultiline: true,
        hookMeasuresMultiline: true,
        latchedMultiline: true,
        value: "",
      }),
      false
    );
  });

  test("sticky multiline stays latched while content remains even if hook measures single line", () => {
    assert.equal(
      resolveComposerIsMultiLine({
        useStickyMultiline: true,
        hookMeasuresMultiline: false,
        latchedMultiline: true,
        value: "hello world",
      }),
      true
    );
  });

  test("non-sticky layout follows hook measurement directly", () => {
    assert.equal(
      resolveComposerIsMultiLine({
        useStickyMultiline: false,
        hookMeasuresMultiline: true,
        latchedMultiline: false,
        value: "\n\n",
      }),
      true
    );
  });

  test("forceMultiline overrides measurement", () => {
    assert.equal(
      resolveComposerIsMultiLine({
        forceMultiline: true,
        useStickyMultiline: true,
        hookMeasuresMultiline: false,
        latchedMultiline: false,
        value: "",
      }),
      true
    );
  });
});
