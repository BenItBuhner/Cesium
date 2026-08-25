import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  positionComposerCommandPanel,
  resolveComposerCommandPanelPlacement,
} from "../src/lib/composer-command-panel.ts";

describe("composer command panel placement", () => {
  test("opens below a new chat when nothing occupies the space beneath", () => {
    assert.equal(
      resolveComposerCommandPanelPlacement({
        layout: "empty-top",
        hasBeneathWidgets: false,
      }),
      "below"
    );
  });

  test("opens above a new chat when landing widgets sit beneath the composer", () => {
    assert.equal(
      resolveComposerCommandPanelPlacement({
        layout: "empty-top",
        hasBeneathWidgets: true,
      }),
      "above"
    );
  });

  test("opens above an existing conversation", () => {
    assert.equal(
      resolveComposerCommandPanelPlacement({
        layout: "docked-bottom",
        hasBeneathWidgets: false,
      }),
      "above"
    );
  });

  test("opens above the expanded composer", () => {
    assert.equal(
      resolveComposerCommandPanelPlacement({
        layout: "empty-top",
        isExpanded: true,
        hasBeneathWidgets: false,
      }),
      "above"
    );
  });

  test("matches the composer width and sits below with a gap", () => {
    const position = positionComposerCommandPanel(
      { left: 40, top: 120, bottom: 200, width: 520 },
      "below",
      { width: 1280, height: 800 }
    );
    assert.equal(position.placement, "below");
    assert.equal(position.left, 40);
    assert.equal(position.width, 520);
    assert.equal(position.top, 208);
  });

  test("matches the composer width and sits above with a gap", () => {
    const position = positionComposerCommandPanel(
      { left: 40, top: 640, bottom: 720, width: 520 },
      "above",
      { width: 1280, height: 800 }
    );
    assert.equal(position.placement, "above");
    assert.equal(position.left, 40);
    assert.equal(position.width, 520);
    assert.equal(position.bottom, 168);
  });
});
