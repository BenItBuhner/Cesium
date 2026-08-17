import assert from "node:assert/strict";
import test from "node:test";
import { scrollEdgeMaskStyle } from "../src/components/chat/scroll-edge-mask";

test("scroll edge mask paints no theme color", () => {
  const style = scrollEdgeMaskStyle({ top: true, bottom: true }, { size: 28 });

  assert.equal(
    style.maskImage,
    "linear-gradient(to bottom, transparent 0, black 28px, black calc(100% - 28px), transparent 100%)"
  );
  assert.equal(style.WebkitMaskImage, style.maskImage);
  assert.equal(JSON.stringify(style).includes("var(--bg"), false);
});

test("scroll edge mask supports one-sided and asymmetric fades", () => {
  assert.equal(
    scrollEdgeMaskStyle(
      { top: true, bottom: true },
      { topSize: 20, bottomSize: "64px" }
    ).maskImage,
    "linear-gradient(to bottom, transparent 0, black 20px, black calc(100% - 64px), transparent 100%)"
  );
  assert.equal(
    scrollEdgeMaskStyle({ right: true }, { rightSize: 32 }).maskImage,
    "linear-gradient(to right, black calc(100% - 32px), transparent 100%)"
  );
});

test("scroll edge mask intersects vertical and horizontal opacity", () => {
  const style = scrollEdgeMaskStyle({
    top: true,
    right: true,
    bottom: true,
    left: true,
  });

  assert.match(String(style.maskImage), /to bottom/);
  assert.match(String(style.maskImage), /to right/);
  assert.equal(style.maskComposite, "intersect");
  assert.equal(style.WebkitMaskComposite, "source-in");
});

test("scroll edge mask is absent when no edge is clipped", () => {
  assert.deepEqual(scrollEdgeMaskStyle({}), {});
});
