import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LANDING_PICKER_MOBILE_MAX_WIDTH_PX,
  resolveLandingPickerCondenseTier,
} from "../src/components/agent/landing-picker-overflow.ts";

describe("landing picker overflow", () => {
  test("wide row with a fitting full probe keeps everything full size", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: LANDING_PICKER_MOBILE_MAX_WIDTH_PX + 200,
        fullRowWidthPx: 500,
        noImportRowWidthPx: 440,
        condensedDeviceRowWidthPx: 320,
      }),
      0
    );
  });

  test("mobile-width rows always hide Import, even when the full row fits", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: LANDING_PICKER_MOBILE_MAX_WIDTH_PX,
        fullRowWidthPx: 400,
        noImportRowWidthPx: 340,
        condensedDeviceRowWidthPx: 260,
      }),
      1
    );
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: 390,
        fullRowWidthPx: 380,
        noImportRowWidthPx: 330,
        condensedDeviceRowWidthPx: 250,
      }),
      1
    );
  });

  test("wide row that overflows drops Import before condensing pills", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: 700,
        fullRowWidthPx: 760,
        noImportRowWidthPx: 690,
        condensedDeviceRowWidthPx: 540,
      }),
      1
    );
  });

  test("device pill condenses when the Import-less row still overflows", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: 390,
        fullRowWidthPx: 560,
        noImportRowWidthPx: 500,
        condensedDeviceRowWidthPx: 380,
      }),
      2
    );
  });

  test("branch pill condenses last, when even the condensed-device row overflows", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: 320,
        fullRowWidthPx: 640,
        noImportRowWidthPx: 580,
        condensedDeviceRowWidthPx: 460,
      }),
      3
    );
  });

  test("sub-pixel rounding at the exact boundary does not condense", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: 800,
        fullRowWidthPx: 801,
        noImportRowWidthPx: 700,
        condensedDeviceRowWidthPx: 500,
      }),
      0
    );
  });

  test("missing measurements keep the row full size until the first layout pass", () => {
    assert.equal(
      resolveLandingPickerCondenseTier({
        availableWidthPx: null,
        fullRowWidthPx: null,
        noImportRowWidthPx: null,
        condensedDeviceRowWidthPx: null,
      }),
      0
    );
  });
});
