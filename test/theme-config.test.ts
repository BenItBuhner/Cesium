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

function runBootstrap(options: {
  storage: Record<string, string>;
  systemPrefersDark: boolean;
}): {
  classes: Set<string>;
  style: Record<string, string>;
  properties: Map<string, string>;
} {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const properties = new Map<string, string>();

  vm.runInNewContext(buildThemeBootstrapScript(), {
    localStorage: {
      getItem: (key: string) => options.storage[key] ?? null,
    },
    window: {
      matchMedia: () => ({
        matches: options.systemPrefersDark,
        addEventListener() {},
      }),
    },
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, enabled: boolean) => {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
        style: Object.assign(style, {
          setProperty: (key: string, value: string) => {
            properties.set(key, value);
          },
          removeProperty: (key: string) => {
            properties.delete(key);
          },
        }),
      },
    },
  });

  return { classes, style, properties };
}

describe("theme config", () => {
  test("defaults tool call dropdown max height", () => {
    const config = createDefaultThemeConfig();
    assert.equal(config.toolCallDropdownMaxHeightPx, TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX);
    assert.equal(config.editDiffRenderingMode, "full");
    assert.equal(config.composerLayout, "concise");
  });

  test("normalizes composer layout density", () => {
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        composerLayout: "detailed",
      }).composerLayout,
      "detailed"
    );
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        composerLayout: "invalid",
      }).composerLayout,
      "concise"
    );
    assert.equal(
      normalizeThemeConfig({ schemaVersion: 1, appearance: "system" }).composerLayout,
      "concise"
    );
  });

  test("defaults dark appearance to the OLED black theme", () => {
    const config = createDefaultThemeConfig();
    assert.equal(config.darkThemeId, "oled");
    assert.equal(config.lightThemeId, "default");
    assert.equal(
      normalizeThemeConfig({ schemaVersion: 1, appearance: "dark" }).darkThemeId,
      "oled"
    );
    // Explicit stored choices are preserved as-is.
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "dark",
        darkThemeId: "default",
      }).darkThemeId,
      "default"
    );
  });

  test("normalizes edit diff rendering mode", () => {
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        editDiffRenderingMode: "counts",
      }).editDiffRenderingMode,
      "counts"
    );
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        editDiffRenderingMode: "invalid",
      }).editDiffRenderingMode,
      "full"
    );
  });

  test("hides tool call icons by default and honors an explicit opt-in", () => {
    assert.equal(createDefaultThemeConfig().showToolCallIcons, false);
    assert.equal(
      normalizeThemeConfig({ schemaVersion: 1, appearance: "system" }).showToolCallIcons,
      false
    );
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        showToolCallIcons: true,
      }).showToolCallIcons,
      true
    );
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "system",
        showToolCallIcons: "yes",
      }).showToolCallIcons,
      false
    );
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
    const { classes, style } = runBootstrap({
      storage: {
        "opencursor-theme-config": JSON.stringify({
          schemaVersion: 1,
          appearance: "dark",
        }),
        "opencursor-theme": "light",
      },
      systemPrefersDark: false,
    });

    assert.equal(classes.has("dark"), true);
    assert.equal(style.colorScheme, "dark");
  });

  test("bootstrap defaults system preference to dark when no theme is stored", () => {
    const { classes } = runBootstrap({
      storage: {},
      systemPrefersDark: true,
    });

    assert.equal(classes.has("dark"), true);
  });

  test("bootstrap pre-paints OLED black for the default dark theme", () => {
    const { properties } = runBootstrap({
      storage: {},
      systemPrefersDark: true,
    });

    assert.equal(properties.get("--bg-main"), "#000000");
    assert.equal(properties.get("--background"), "#000000");
  });

  test("bootstrap skips OLED pre-paint for a non-OLED dark theme", () => {
    const { classes, properties } = runBootstrap({
      storage: {
        "opencursor-theme-config": JSON.stringify({
          schemaVersion: 1,
          appearance: "dark",
          darkThemeId: "default",
        }),
      },
      systemPrefersDark: false,
    });

    assert.equal(classes.has("dark"), true);
    assert.equal(properties.size, 0);
  });

  test("bootstrap skips OLED pre-paint when resolved appearance is light", () => {
    const { classes, properties } = runBootstrap({
      storage: {
        "opencursor-theme-config": JSON.stringify({
          schemaVersion: 1,
          appearance: "light",
        }),
      },
      systemPrefersDark: true,
    });

    assert.equal(classes.has("dark"), false);
    assert.equal(properties.size, 0);
  });
});
