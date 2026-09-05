import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  editorAddTabMenuNeedsSeparatorBefore,
  listEditorAddTabMenuItems,
} from "../src/lib/editor-add-tab-menu.ts";

describe("editor add-tab menu catalog", () => {
  test("keeps the original terminal and browser entries first", () => {
    const items = listEditorAddTabMenuItems({
      terminal: true,
      browser: true,
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["terminal", "browser"]
    );
    assert.deepEqual(
      items.map((item) => item.label),
      ["New Terminal", "New Browser Tab"]
    );
  });

  test("includes the later editor surfaces when those actions exist", () => {
    const items = listEditorAddTabMenuItems({
      terminal: true,
      browser: true,
      pullRequest: true,
      orchestrationBoard: true,
      marketplace: true,
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["terminal", "browser", "pullRequest", "orchestrationBoard", "marketplace"]
    );
    assert.equal(items.find((item) => item.id === "pullRequest")?.label, "Open Pull Request");
    assert.equal(
      items.find((item) => item.id === "orchestrationBoard")?.label,
      "New Orchestration Board"
    );
    assert.equal(
      items.find((item) => item.id === "marketplace")?.label,
      "Extension Marketplace"
    );
  });

  test("omits surfaces that are not wired", () => {
    const items = listEditorAddTabMenuItems({
      pullRequest: true,
      marketplace: false,
    });
    assert.deepEqual(
      items.map((item) => item.id),
      ["pullRequest"]
    );
  });

  test("returns an empty list when nothing is available", () => {
    assert.deepEqual(listEditorAddTabMenuItems({}), []);
  });

  test("separates session tabs from later editor surfaces", () => {
    const items = listEditorAddTabMenuItems({
      terminal: true,
      browser: true,
      pullRequest: true,
      orchestrationBoard: true,
      marketplace: true,
    });
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(items, 0), false);
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(items, 1), false);
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(items, 2), true);
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(items, 3), false);
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(items, 4), false);
  });

  test("does not insert a separator when only one group is present", () => {
    const surfacesOnly = listEditorAddTabMenuItems({
      pullRequest: true,
      marketplace: true,
    });
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(surfacesOnly, 1), false);

    const sessionsOnly = listEditorAddTabMenuItems({
      terminal: true,
      browser: true,
    });
    assert.equal(editorAddTabMenuNeedsSeparatorBefore(sessionsOnly, 1), false);
  });
});
