import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
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

describe("isRightPaneSwipeAction", () => {
  test("treats open and close as the same drawer", () => {
    assert.equal(isRightPaneSwipeAction("open-right"), true);
    assert.equal(isRightPaneSwipeAction("close-right"), true);
    assert.equal(isRightPaneSwipeAction("open-left"), false);
    assert.equal(isRightPaneSwipeAction("close-left"), false);
    assert.equal(isRightPaneSwipeAction(null), false);
  });
});
