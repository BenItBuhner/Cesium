import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createInitialEditorState,
  editorPanelReducer,
} from "../src/components/editor/editor-panel-state.ts";

describe("OPEN_PROJECT_TAB", () => {
  test("opens one Project tab named after the Project", () => {
    const state = editorPanelReducer(createInitialEditorState([]), {
      type: "OPEN_PROJECT_TAB",
      projectId: "prj_1",
      title: "Checkout redesign",
    });
    assert.equal(state.split, false);
    assert.equal(state.leftTabs.length, 1);
    const tab = state.leftTabs[0]!;
    assert.equal(tab.id, "project:prj_1");
    assert.equal(tab.kind, "project");
    assert.equal(tab.icon, "project");
    assert.deepEqual(tab.project, { projectId: "prj_1" });
    assert.equal(tab.name, "Checkout redesign");
    assert.equal(state.leftActiveId, tab.id);
  });

  test("re-opening refocuses the tab and picks up a rename", () => {
    let state = editorPanelReducer(createInitialEditorState([]), {
      type: "OPEN_PROJECT_TAB",
      projectId: "prj_1",
      title: "Old name",
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
      type: "OPEN_PROJECT_TAB",
      projectId: "prj_1",
      title: "New name",
    });
    assert.equal(state.leftTabs.filter((tab) => tab.kind === "project").length, 1);
    assert.equal(state.leftActiveId, "project:prj_1");
    assert.equal(state.leftTabs.find((tab) => tab.id === "project:prj_1")!.name, "New name");
  });

  test("a right-group request splits, and blank titles fall back to 'Project'", () => {
    const state = editorPanelReducer(createInitialEditorState([]), {
      type: "OPEN_PROJECT_TAB",
      projectId: "prj_2",
      title: "  ",
      group: "right",
    });
    assert.equal(state.split, true);
    assert.equal(state.rightTabs[0]!.id, "project:prj_2");
    assert.equal(state.rightTabs[0]!.name, "Project");
    assert.equal(state.focusedGroup, "right");
  });
});
