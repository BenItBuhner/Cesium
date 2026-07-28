import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCesiumFileEdit,
  describeWriteFileOutcome,
  parseCesiumEditFileArgs,
  parseCesiumWriteFileArgs,
} from "../src/lib/agents/cesium/cesium-file-tools.js";
import {
  resolveCesiumToolPermissionCategory,
  resolveCesiumTools,
  toolKind,
  toolTitle,
} from "../src/lib/agents/cesium/cesium-tools.js";
import { resolveCesiumModeToolPolicy } from "../src/lib/agents/cesium-mode-policy.js";

test("write_file is registered with editFile permission and edit tool kind", () => {
  const harness = resolveCesiumTools();
  const writeFile = harness.tools.find((tool) => tool.name === "write_file");
  assert.ok(writeFile, "write_file tool should be registered");
  assert.equal(writeFile?.requiresPermission, "editFile");
  assert.equal(resolveCesiumToolPermissionCategory(harness.tools, "write_file"), "editFile");
  assert.equal(toolKind("write_file"), "edit");
  assert.equal(toolTitle("write_file", { path: "src/new-file.ts" }), "Write src/new-file.ts");
});

test("write_file is blocked in Ask and Plan modes but allowed in Agent mode", () => {
  assert.equal(resolveCesiumModeToolPolicy({ mode: "ask", toolName: "write_file" }).allowed, false);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "plan", toolName: "write_file" }).allowed, false);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "agent", toolName: "write_file" }).allowed, true);
  assert.equal(resolveCesiumModeToolPolicy({ mode: "goal", toolName: "write_file" }).allowed, true);
});

test("parseCesiumWriteFileArgs validates path and content", () => {
  assert.deepEqual(parseCesiumWriteFileArgs({ path: "a.txt", content: "hi" }), {
    path: "a.txt",
    content: "hi",
  });
  assert.deepEqual(parseCesiumWriteFileArgs({ path: "a.txt", content: "" }), {
    path: "a.txt",
    content: "",
  });
  assert.throws(() => parseCesiumWriteFileArgs({ content: "hi" }), /path is required/);
  assert.throws(() => parseCesiumWriteFileArgs({ path: "a.txt" }), /content is required/);
});

test("describeWriteFileOutcome distinguishes creates from overwrites", () => {
  assert.deepEqual(describeWriteFileOutcome({ path: "a.txt", before: null, content: "x\ny" }), {
    created: true,
    resultMessage: "Created a.txt (2 lines).",
  });
  assert.deepEqual(describeWriteFileOutcome({ path: "a.txt", before: "old", content: "x" }), {
    created: false,
    resultMessage: "Overwrote a.txt (1 line).",
  });
});

test("edit_file on a missing file points the model at write_file", () => {
  assert.throws(
    () =>
      applyCesiumFileEdit({
        path: "does/not/exist.ts",
        before: null,
        oldString: "foo",
        newString: "bar",
      }),
    /does not exist.*write_file/s
  );
});

test("edit_file with empty oldString creates a missing file", () => {
  const outcome = applyCesiumFileEdit({
    path: "new/file.ts",
    before: null,
    oldString: "",
    newString: "export const x = 1;\n",
  });
  assert.equal(outcome.created, true);
  assert.equal(outcome.after, "export const x = 1;\n");
  assert.match(outcome.resultMessage, /Created new\/file\.ts/);
});

test("edit_file with empty oldString fills an empty file but rejects non-empty files", () => {
  const filled = applyCesiumFileEdit({
    path: "empty.txt",
    before: "",
    oldString: "",
    newString: "content",
  });
  assert.equal(filled.after, "content");
  assert.equal(filled.created, false);
  assert.throws(
    () =>
      applyCesiumFileEdit({
        path: "full.txt",
        before: "existing content",
        oldString: "",
        newString: "replacement",
      }),
    /oldString is required.*write_file/s
  );
});

test("edit_file replaces a unique match and reports ambiguous matches with counts", () => {
  const unique = applyCesiumFileEdit({
    path: "a.ts",
    before: "const a = 1;\nconst b = 2;\n",
    oldString: "const b = 2;",
    newString: "const b = 3;",
  });
  assert.equal(unique.after, "const a = 1;\nconst b = 3;\n");
  assert.equal(unique.replacements, 1);

  assert.throws(
    () =>
      applyCesiumFileEdit({
        path: "a.ts",
        before: "x = 1;\nx = 1;\nx = 1;\n",
        oldString: "x = 1;",
        newString: "x = 2;",
      }),
    /matches 3 times.*replaceAll/s
  );
});

test("edit_file replaceAll replaces every occurrence and reports the count", () => {
  const outcome = applyCesiumFileEdit({
    path: "a.ts",
    before: "x = 1;\nx = 1;\nx = 1;\n",
    oldString: "x = 1;",
    newString: "x = 2;",
    replaceAll: true,
  });
  assert.equal(outcome.after, "x = 2;\nx = 2;\nx = 2;\n");
  assert.equal(outcome.replacements, 3);
  assert.match(outcome.resultMessage, /3 replacements/);
});

test("edit_file no-match error includes a whitespace hint when a near-miss exists", () => {
  assert.throws(
    () =>
      applyCesiumFileEdit({
        path: "a.ts",
        before: "function foo() {\n\treturn 1;\n}\n",
        oldString: "function foo() {\n    return 1;\n}",
        newString: "function foo() {\n    return 2;\n}",
      }),
    /whitespace\/indentation/
  );
  assert.throws(
    () =>
      applyCesiumFileEdit({
        path: "a.ts",
        before: "const a = 1;\n",
        oldString: "completely absent text",
        newString: "x",
      }),
    /Re-read the file/
  );
});

test("parseCesiumEditFileArgs normalizes replaceAll and defaults strings", () => {
  assert.deepEqual(parseCesiumEditFileArgs({ path: "a.ts", oldString: "a", newString: "b" }), {
    path: "a.ts",
    oldString: "a",
    newString: "b",
    replaceAll: false,
  });
  assert.equal(
    parseCesiumEditFileArgs({ path: "a.ts", oldString: "a", newString: "b", replaceAll: true })
      .replaceAll,
    true
  );
  assert.throws(() => parseCesiumEditFileArgs({ oldString: "a", newString: "b" }), /path is required/);
});
