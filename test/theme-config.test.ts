import assert from "node:assert/strict";
import { describe, test } from "node:test";
import vm from "node:vm";
import { buildThemeBootstrapScript } from "../src/lib/theme-bootstrap.ts";
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

  test("bootstrap honors persisted theme config before legacy theme", () => {
    const classes = new Set<string>();
    const style: Record<string, string> = {};
    const storage: Record<string, string> = {
      "opencursor-theme-config": JSON.stringify({
        schemaVersion: 1,
        appearance: "dark",
      }),
      "opencursor-theme": "light",
    };

    vm.runInNewContext(buildThemeBootstrapScript(), {
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
      },
      window: {
        matchMedia: () => ({ matches: false, addEventListener() {} }),
      },
      document: {
        documentElement: {
          classList: {
            toggle: (name: string, enabled: boolean) => {
              if (enabled) classes.add(name);
              else classes.delete(name);
            },
          },
          style,
        },
      },
    });

    assert.equal(classes.has("dark"), true);
    assert.equal(style.colorScheme, "dark");
  });

  test("bootstrap defaults system preference to dark when no theme is stored", () => {
    const classes = new Set<string>();

    vm.runInNewContext(buildThemeBootstrapScript(), {
      localStorage: {
        getItem: () => null,
      },
      window: {
        matchMedia: () => ({ matches: true, addEventListener() {} }),
      },
      document: {
        documentElement: {
          classList: {
            toggle: (name: string, enabled: boolean) => {
              if (enabled) classes.add(name);
              else classes.delete(name);
            },
          },
          style: {},
        },
      },
    });

    assert.equal(classes.has("dark"), true);
  });
});
