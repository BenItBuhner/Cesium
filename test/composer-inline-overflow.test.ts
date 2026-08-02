import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPOSER_INLINE_FORCE_COMPACT_MAX_ROW_WIDTH_PX,
  shouldCompactComposerInlineControls,
} from "../src/components/chat/composer-inline-overflow.ts";

describe("composer inline overflow", () => {
  test("no overflow on a wide row keeps full-size single-line controls", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
        rowWidthPx: COMPOSER_INLINE_FORCE_COMPACT_MAX_ROW_WIDTH_PX + 80,
      }),
      false
    );
  });

  test("overflow compacts controls to icons while single-line", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: true,
        contentIsMultiLine: false,
        rowWidthPx: 900,
      }),
      true
    );
  });

  test("narrow rows always compact, even when a short model name would fit", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
        rowWidthPx: COMPOSER_INLINE_FORCE_COMPACT_MAX_ROW_WIDTH_PX,
      }),
      true
    );
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
        rowWidthPx: 390,
      }),
      true
    );
  });

  test("content-driven multiline restores full labels on the control row", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: true,
        contentIsMultiLine: true,
        rowWidthPx: 390,
      }),
      false
    );
  });

  test("multiline without overflow never compacts", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: true,
        rowWidthPx: 390,
      }),
      false
    );
  });

  test("missing row width does not force compact without overflow", () => {
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
        rowWidthPx: null,
      }),
      false
    );
    assert.equal(
      shouldCompactComposerInlineControls({
        inlineControlsOverflow: false,
        contentIsMultiLine: false,
      }),
      false
    );
  });
});
