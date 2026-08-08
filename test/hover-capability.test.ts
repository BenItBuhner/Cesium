import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  HOVER_CAPABLE_MEDIA_QUERY,
  isHoverCapablePointer,
} from "../src/lib/hover-capability.ts";

function env(input: { hoverFine?: boolean; matchMedia?: false | "throws" }) {
  if (input.matchMedia === false) {
    return {};
  }
  if (input.matchMedia === "throws") {
    return {
      matchMedia: () => {
        throw new Error("matchMedia unavailable");
      },
    };
  }
  return {
    matchMedia: (query: string) => ({
      matches: query === HOVER_CAPABLE_MEDIA_QUERY && input.hoverFine === true,
    }),
  };
}

describe("hover-capable pointer detection", () => {
  test("matches the CSS hover gate used by globals.css", () => {
    assert.equal(
      HOVER_CAPABLE_MEDIA_QUERY,
      "(any-hover: hover) and (any-pointer: fine)"
    );
  });

  test("reports hover-capable on desktop-style fine pointers", () => {
    assert.equal(isHoverCapablePointer(env({ hoverFine: true })), true);
  });

  test("reports not hover-capable on touch-only devices", () => {
    assert.equal(isHoverCapablePointer(env({ hoverFine: false })), false);
  });

  test("defaults to hover-capable when matchMedia is missing or broken", () => {
    assert.equal(isHoverCapablePointer(env({ matchMedia: false })), true);
    assert.equal(isHoverCapablePointer(env({ matchMedia: "throws" })), true);
  });
});
