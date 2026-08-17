import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  edgeFadeMaskImage,
  edgeFadeMaskStyle,
  horizontalFadeState,
  verticalFadeState,
} from "../src/components/ui/scroll-edge-fade.ts";

describe("edge fade mask builder", () => {
  test("no active edges yields no mask", () => {
    assert.equal(edgeFadeMaskImage({}), null);
    assert.deepEqual(edgeFadeMaskStyle({}), {});
    assert.equal(
      edgeFadeMaskImage({ top: false, bottom: false, left: false, right: false }),
      null
    );
  });

  test("single vertical edge fades only that edge", () => {
    const top = edgeFadeMaskImage({ top: true });
    assert.equal(
      top?.image,
      "linear-gradient(to bottom, transparent, black 28px, black)"
    );
    assert.equal(top?.layers, 1);

    const bottom = edgeFadeMaskImage({ bottom: true }, 24);
    assert.equal(
      bottom?.image,
      "linear-gradient(to bottom, black, black calc(100% - 24px), transparent)"
    );
  });

  test("both vertical edges fade in one layer", () => {
    const both = edgeFadeMaskImage({ top: true, bottom: true });
    assert.equal(
      both?.image,
      "linear-gradient(to bottom, transparent, black 28px, black calc(100% - 28px), transparent)"
    );
    assert.equal(both?.layers, 1);
  });

  test("horizontal edges build a to-right layer", () => {
    const left = edgeFadeMaskImage({ left: true }, 32);
    assert.equal(
      left?.image,
      "linear-gradient(to right, transparent, black 32px, black)"
    );
    const right = edgeFadeMaskImage({ right: true });
    assert.equal(
      right?.image,
      "linear-gradient(to right, black, black calc(100% - 28px), transparent)"
    );
  });

  test("mixed axes produce two layers composited with intersect", () => {
    const mask = edgeFadeMaskImage({ top: true, right: true });
    assert.equal(mask?.layers, 2);
    assert.equal(
      mask?.image,
      "linear-gradient(to bottom, transparent, black 28px, black), " +
        "linear-gradient(to right, black, black calc(100% - 28px), transparent)"
    );

    const style = edgeFadeMaskStyle({ top: true, right: true });
    assert.equal(style.maskComposite, "intersect");
    assert.equal(style.WebkitMaskComposite, "source-in");
    assert.equal(style.maskImage, mask?.image);
    assert.equal(style.WebkitMaskImage, mask?.image);
  });

  test("single-axis style sets no composite and mirrors the -webkit- property", () => {
    const style = edgeFadeMaskStyle({ bottom: true });
    assert.equal(style.maskComposite, undefined);
    assert.equal(style.WebkitMaskComposite, undefined);
    assert.equal(style.maskImage, style.WebkitMaskImage);
  });
});

describe("scroll fade state thresholds", () => {
  test("vertical: needs >2px of overflow and >2px of scroll", () => {
    assert.deepEqual(
      verticalFadeState({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }),
      { top: false, bottom: false }
    );
    assert.deepEqual(
      verticalFadeState({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 }),
      { top: false, bottom: true }
    );
    assert.deepEqual(
      verticalFadeState({ scrollTop: 80, scrollHeight: 300, clientHeight: 100 }),
      { top: true, bottom: true }
    );
    assert.deepEqual(
      verticalFadeState({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 }),
      { top: true, bottom: false }
    );
  });

  test("horizontal: same thresholds along the x axis", () => {
    assert.deepEqual(
      horizontalFadeState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 100 }),
      { left: false, right: true }
    );
    assert.deepEqual(
      horizontalFadeState({ scrollLeft: 100, scrollWidth: 300, clientWidth: 100 }),
      { left: true, right: true }
    );
    assert.deepEqual(
      horizontalFadeState({ scrollLeft: 200, scrollWidth: 300, clientWidth: 100 }),
      { left: true, right: false }
    );
  });
});
