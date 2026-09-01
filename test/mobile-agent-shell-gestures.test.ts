import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyOverlayDrawerSurfaceFrame,
  isRightPaneSwipeAction,
  resolveAgentShellSwipeAction,
} from "../src/components/mobile/drawer-motion.ts";

describe("resolveAgentShellSwipeAction", () => {
  test("opens the rail on a right swipe when nothing is open", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "right",
        leftProgress: 0,
        rightProgress: 0,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      "open-left"
    );
  });

  test("opens the workbench pane on a left swipe when enabled", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "left",
        leftProgress: 0,
        rightProgress: 0,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      "open-right"
    );
  });

  test("does not open the workbench pane on the new-chat landing", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "left",
        leftProgress: 0,
        rightProgress: 0,
        rightOpenGestureEnabled: false,
        rightCloseGestureEnabled: true,
      }),
      null
    );
  });

  test("closes the rail on a left swipe while it is open", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "left",
        leftProgress: 1,
        rightProgress: 0,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      "close-left"
    );
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "right",
        leftProgress: 1,
        rightProgress: 0,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      null
    );
  });

  test("swallows swipes while the workbench pane has tabs", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "right",
        leftProgress: 0,
        rightProgress: 1,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: false,
      }),
      null
    );
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "left",
        leftProgress: 0,
        rightProgress: 1,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: false,
      }),
      null
    );
  });

  test("closes an empty workbench pane on a right swipe only", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "right",
        leftProgress: 0,
        rightProgress: 1,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      "close-right"
    );
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "left",
        leftProgress: 0,
        rightProgress: 1,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      null
    );
  });

  test("right pane still owns the screen while a close gesture is mid-flight", () => {
    assert.equal(
      resolveAgentShellSwipeAction({
        direction: "right",
        leftProgress: 0,
        rightProgress: 0.4,
        rightOpenGestureEnabled: true,
        rightCloseGestureEnabled: true,
      }),
      "close-right"
    );
  });
});

describe("applyOverlayDrawerSurfaceFrame", () => {
  function fakeDrawer(): { el: HTMLElement; style: Record<string, string> } {
    const style: Record<string, string> = {};
    return { el: { style } as unknown as HTMLElement, style };
  }

  test("drops the resting transform so backdrop-filter can sample behind the pane", () => {
    const { el, style } = fakeDrawer();
    applyOverlayDrawerSurfaceFrame(el, 1, "left");
    assert.equal(style.transform, "none");
    assert.equal(style.willChange, "auto");
  });

  test("keeps a sliding transform while the left drawer is mid-flight", () => {
    const { el, style } = fakeDrawer();
    applyOverlayDrawerSurfaceFrame(el, 0.4, "left");
    assert.equal(style.transform, "translate3d(-60%, 0, 0)");
    assert.equal(style.willChange, "transform");
  });

  test("slides the right drawer from the opposite edge", () => {
    const { el, style } = fakeDrawer();
    applyOverlayDrawerSurfaceFrame(el, 0.25, "right");
    assert.equal(style.transform, "translate3d(75%, 0, 0)");
    applyOverlayDrawerSurfaceFrame(el, 1, "right");
    assert.equal(style.transform, "none");
  });

  test("ignores a missing drawer node", () => {
    assert.doesNotThrow(() => applyOverlayDrawerSurfaceFrame(null, 1, "left"));
  });
});

describe("isRightPaneSwipeAction", () => {
  test("treats open and close as the same drawer", () => {
    assert.equal(isRightPaneSwipeAction("open-right"), true);
    assert.equal(isRightPaneSwipeAction("close-right"), true);
    assert.equal(isRightPaneSwipeAction("open-left"), false);
    assert.equal(isRightPaneSwipeAction("close-left"), false);
    assert.equal(isRightPaneSwipeAction(null), false);
  });
});
