import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldCompactComposerInlineControls } from "../src/components/chat/composer-inline-overflow.ts";

describe("composer inline overflow", () => {
  test("no overflow keeps full-size single-line controls", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
      }),
      false
    );
  });

  test("overflow compacts controls to icons while single-line", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: true,
        contentIsMultiLine: false,
      }),
      true
    );
  });

  test("content-driven multiline restores full labels on the control row", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: true,
        contentIsMultiLine: true,
      }),
      false
    );
  });

  test("multiline without overflow never compacts", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: true,
      }),
      false
    );
  });
});
