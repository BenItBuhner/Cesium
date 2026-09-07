import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createInitialEditorState,
  editorPanelReducer,
} from "../src/components/editor/editor-panel-state.ts";

describe("OPEN_CONTEXT_INSPECTOR_TAB", () => {
  test("opens a dedicated inspector tab per conversation in the focused group", () => {
    let state = createInitialEditorState([]);
    state = editorPanelReducer(state, {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-1",
      title: "Refactor the billing module",
    });
    assert.equal(state.split, false);
    assert.equal(state.leftTabs.length, 1);
    const tab = state.leftTabs[0]!;
    assert.equal(tab.id, "context-inspector:conv-1");
    assert.equal(tab.kind, "contextInspector");
    assert.equal(tab.icon, "contextInspector");
    assert.deepEqual(tab.contextInspector, { conversationId: "conv-1" });
    assert.ok(tab.name.startsWith("Context · Refactor"));
    assert.equal(state.leftActiveId, tab.id);
    assert.equal(state.focusedGroup, "left");
  });

  test("re-opening focuses the existing tab and refreshes its title instead of duplicating", () => {
    let state = createInitialEditorState([]);
    state = editorPanelReducer(state, {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-1",
      title: "First title",
    });
    state = editorPanelReducer(state, {
      type: "OPEN_EXPLORER_FILE",
      path: "src/index.ts",
      name: "index.ts",
      language: "typescript",
      icon: "typescript",
    });
    assert.equal(state.leftActiveId, "explorer:src/index.ts");
    state = editorPanelReducer(state, {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-1",
      title: "Renamed chat",
    });
    assert.equal(state.leftTabs.filter((tab) => tab.kind === "contextInspector").length, 1);
    assert.equal(state.leftActiveId, "context-inspector:conv-1");
    assert.equal(state.leftTabs[0]!.name, "Context · Renamed chat");
  });

  test("different conversations get different tabs and the right group splits on demand", () => {
    let state = createInitialEditorState([]);
    state = editorPanelReducer(state, {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-1",
      title: "A",
    });
    state = editorPanelReducer(state, {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-2",
      title: "B",
      group: "right",
    });
    assert.equal(state.split, true);
    assert.equal(state.leftTabs.length, 1);
    assert.equal(state.rightTabs.length, 1);
    assert.equal(state.rightTabs[0]!.id, "context-inspector:conv-2");
    assert.equal(state.rightActiveId, "context-inspector:conv-2");
    assert.equal(state.focusedGroup, "right");
  });

  test("falls back to 'Untitled' for blank titles", () => {
    const state = editorPanelReducer(createInitialEditorState([]), {
      type: "OPEN_CONTEXT_INSPECTOR_TAB",
      conversationId: "conv-3",
      title: "   ",
    });
    assert.equal(state.leftTabs[0]!.name, "Context · Untitled");
  });
});
