import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX,
  createDefaultThemeConfig,
  normalizeThemeConfig,
  normalizeToolCallDropdownMaxHeightPx,
} from "../src/lib/theme-config.ts";

describe("theme config", () => {
  test("defaults tool call dropdown max height", () => {
    const config = createDefaultThemeConfig();
    assert.equal(config.toolCallDropdownMaxHeightPx, TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX);
  });

  test("clamps tool call dropdown max height", () => {
    assert.equal(normalizeToolCallDropdownMaxHeightPx(50), TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX);
    assert.equal(normalizeToolCallDropdownMaxHeightPx(9999), TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX);
    assert.equal(normalizeToolCallDropdownMaxHeightPx(320.7), 321);
    assert.equal(
      normalizeToolCallDropdownMaxHeightPx(undefined),
      TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX
    );
  });

  test("normalizes persisted theme config", () => {
    const config = normalizeThemeConfig({
      schemaVersion: 1,
      appearance: "dark",
      lightThemeId: "default",
      darkThemeId: "default",
      customThemes: [],
      toolCallDropdownMaxHeightPx: 400,
    });
    assert.equal(config.toolCallDropdownMaxHeightPx, 400);
  });
});
