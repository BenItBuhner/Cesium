import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseComposerInlineOverflowStrategy,
  resolveComposerInlineOverflowUi,
} from "../src/components/chat/composer-inline-overflow.ts";

describe("composer inline overflow", () => {
  test("no overflow keeps full-size single-line controls", () => {
    for (const strategy of ["compact", "stack"] as const) {
      assert.deepEqual(
        resolveComposerInlineOverflowUi({
          strategy,
          inlineControlsOverflow: false,
          contentIsMultiLine: false,
        }),
        { compactInlineControls: false, forceStackedControls: false }
      );
    }
  });

  test("compact strategy collapses controls to icons while single-line", () => {
    assert.deepEqual(
      resolveComposerInlineOverflowUi({
        strategy: "compact",
        inlineControlsOverflow: true,
        contentIsMultiLine: false,
      }),
      { compactInlineControls: true, forceStackedControls: false }
    );
  });

  test("stack strategy forces the two-line stacked shell while single-line", () => {
    assert.deepEqual(
      resolveComposerInlineOverflowUi({
        strategy: "stack",
        inlineControlsOverflow: true,
        contentIsMultiLine: false,
      }),
      { compactInlineControls: false, forceStackedControls: true }
    );
  });

  test("content-driven multiline restores full labels on the control row", () => {
    for (const strategy of ["compact", "stack"] as const) {
      assert.deepEqual(
        resolveComposerInlineOverflowUi({
          strategy,
          inlineControlsOverflow: true,
          contentIsMultiLine: true,
        }),
        { compactInlineControls: false, forceStackedControls: false }
      );
    }
  });

  test("parses only known strategies", () => {
    assert.equal(parseComposerInlineOverflowStrategy("compact"), "compact");
    assert.equal(parseComposerInlineOverflowStrategy("stack"), "stack");
    assert.equal(parseComposerInlineOverflowStrategy("Stack"), null);
    assert.equal(parseComposerInlineOverflowStrategy(""), null);
    assert.equal(parseComposerInlineOverflowStrategy(null), null);
    assert.equal(parseComposerInlineOverflowStrategy(undefined), null);
  });
});
