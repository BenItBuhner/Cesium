import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isMobileNativeRuntime,
  isPhoneLikeTextInputRuntime,
  shouldAutoFocusTextInput,
} from "../src/lib/mobile-autofocus.ts";

function env(input: {
  width?: number;
  visualWidth?: number;
  coarse?: boolean;
  touchPoints?: number;
  userAgent?: string;
  mobileNativeClass?: boolean;
  reactNative?: boolean;
}) {
  return {
    innerWidth: input.width,
    visualViewport:
      input.visualWidth == null ? undefined : { width: input.visualWidth },
    matchMedia: (query: string) => ({
      matches: query === "(pointer: coarse)" && input.coarse === true,
    }),
    navigator: {
      maxTouchPoints: input.touchPoints ?? 0,
      userAgent: input.userAgent ?? "",
    },
    document: {
      documentElement: {
        classList: {
          contains: (className: string) =>
            className === "opencursor-mobile-native" &&
            input.mobileNativeClass === true,
        },
      },
    },
    cesiumMobile: input.reactNative ? { isReactNative: true } : undefined,
  };
}

describe("mobile autofocus gating", () => {
  test("allows autofocus on desktop and tablet-sized touch screens", () => {
    assert.equal(
      shouldAutoFocusTextInput(env({ width: 1280, coarse: false })),
      true
    );
    assert.equal(
      shouldAutoFocusTextInput(env({ width: 820, coarse: true, touchPoints: 5 })),
      true
    );
  });

  test("blocks autofocus on phone-like touch viewports", () => {
    const phone = env({ width: 390, coarse: true, touchPoints: 5 });

    assert.equal(isPhoneLikeTextInputRuntime(phone), true);
    assert.equal(shouldAutoFocusTextInput(phone), false);
  });

  test("does not treat a narrow desktop window as phone-like", () => {
    assert.equal(
      shouldAutoFocusTextInput(env({ width: 500, coarse: false, touchPoints: 0 })),
      true
    );
  });

  test("blocks autofocus in the mobile native runtime regardless of width", () => {
    const mobileNative = env({
      width: 1024,
      coarse: false,
      reactNative: true,
      mobileNativeClass: true,
    });

    assert.equal(isMobileNativeRuntime(mobileNative), true);
    assert.equal(shouldAutoFocusTextInput(mobileNative), false);
  });
});
