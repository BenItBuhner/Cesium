import assert from "node:assert/strict";
import test from "node:test";
import {
  DESIGN_2_MODE_RECIPES,
  DESIGN_2_RECIPES,
  DESIGN_2_SURFACE_ALIASES,
  resolveComposerIsMultiLine,
  resolveDesign2ComposerLayout,
  resolveDesign2ThemeTokens,
} from "../packages/design/src/design-language.ts";
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
} from "../packages/design/src/theme-tokens.ts";

test("Design 2.0 composer recipes are shared across adapters", () => {
  assert.equal(DESIGN_2_RECIPES.composer.plusSize, 22);
  assert.equal(DESIGN_2_RECIPES.composer.sendSize, 20);
  assert.equal(DESIGN_2_RECIPES.rail.toolbarButtonSize, 18);
  assert.equal(DESIGN_2_RECIPES.cards.borderWidth, 1);
  assert.equal(
    resolveDesign2ComposerLayout({
      measuredMultiline: false,
      latchedMultiline: false,
      hasAttachments: false,
      value: "",
    }).radius,
    999
  );
  assert.equal(
    resolveDesign2ComposerLayout({
      measuredMultiline: true,
      latchedMultiline: true,
      hasAttachments: false,
      value: "wrapped content",
    }).radius,
    10
  );
});

test("Design 2.0 mode recipes map Plan and Workflow to canonical tokens", () => {
  assert.equal(DESIGN_2_MODE_RECIPES.plan.backgroundToken, "--plan-accent-bg");
  assert.equal(DESIGN_2_MODE_RECIPES.workflow.sendToken, "--workflow-accent-dark");
  assert.equal(DESIGN_2_MODE_RECIPES.agent.hiddenWhenDefault, true);
});

test("native token resolution includes the same Design 2.0 aliases as CSS", () => {
  const light = resolveDesign2ThemeTokens(DEFAULT_THEME_TOKENS_LIGHT, "light");
  const dark = resolveDesign2ThemeTokens(DEFAULT_THEME_TOKENS_DARK, "dark");
  assert.equal(light["--agent-plus-button-bg"], DESIGN_2_SURFACE_ALIASES.light["--agent-plus-button-bg"]);
  assert.equal(dark["--agent-plus-button-bg"], DESIGN_2_SURFACE_ALIASES.dark["--agent-plus-button-bg"]);
  assert.equal(light["--d2-composer-send-size"], "20px");
});

test("web sticky multiline behavior remains sourced from the design package", () => {
  assert.equal(
    resolveComposerIsMultiLine({
      useStickyMultiline: true,
      hookMeasuresMultiline: false,
      latchedMultiline: true,
      value: "still has content",
    }),
    true
  );
});
