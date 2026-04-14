import assert from "node:assert/strict";
import { test } from "node:test";

const { extractToolEditPreview } = await import("../src/lib/agents/tool-edit-preview.js");

test("extractToolEditPreview builds a preview from before/after content", () => {
  const preview = extractToolEditPreview(
    {
      path: "src/example.ts",
      beforeFullFileContent: "const a = 1;\nconst b = 2;\nreturn a + b;",
      afterFullFileContent: "const a = 1;\nconst b = 3;\nreturn a + b;",
    },
    undefined
  );
  assert.ok(preview);
  assert.equal(preview?.path, "src/example.ts");
  assert.equal(preview?.addedLines, 1);
  assert.equal(preview?.removedLines, 1);
  assert.ok(preview?.lines.some((line) => line.kind === "remove" && line.text === "const b = 2;"));
  assert.ok(preview?.lines.some((line) => line.kind === "add" && line.text === "const b = 3;"));
});

test("extractToolEditPreview builds a preview from replacement snippets", () => {
  const preview = extractToolEditPreview(
    {
      file_path: "src/example.ts",
      old_string: "foo();\nbar();",
      new_string: "foo();\nbaz();",
    },
    undefined
  );
  assert.ok(preview);
  assert.equal(preview?.source, "replace");
  assert.ok(preview?.lines.some((line) => line.kind === "remove" && line.text === "bar();"));
  assert.ok(preview?.lines.some((line) => line.kind === "add" && line.text === "baz();"));
});

test("extractToolEditPreview builds a preview from a unified patch", () => {
  const preview = extractToolEditPreview(
    {
      path: "src/example.ts",
      patch: "@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;",
    },
    undefined
  );
  assert.ok(preview);
  assert.equal(preview?.source, "patch");
  assert.equal(preview?.addedLines, 1);
  assert.equal(preview?.removedLines, 1);
});

test("extractToolEditPreview builds a preview from Cursor diff content blocks", () => {
  const preview = extractToolEditPreview(
    {
      kind: "edit",
      content: [
        {
          type: "diff",
          path: "src/example.ts",
          oldText: "alpha\nbeta\ngamma\n",
          newText: "alpha\nbeta-updated\ngamma\n",
        },
      ],
    },
    undefined
  );
  assert.ok(preview);
  assert.equal(preview?.path, "src/example.ts");
  assert.equal(preview?.addedLines, 1);
  assert.equal(preview?.removedLines, 1);
  assert.ok(preview?.lines.some((line) => line.kind === "remove" && line.text === "beta"));
  assert.ok(preview?.lines.some((line) => line.kind === "add" && line.text === "beta-updated"));
});

test("extractToolEditPreview preserves create-file diffs when the before text is empty", () => {
  const preview = extractToolEditPreview(
    { path: "src/new-file.ts" },
    {
      path: "src/new-file.ts",
      beforeFullFileContent: "",
      afterFullFileContent: "alpha\nbeta\n",
    },
    "src/new-file.ts"
  );
  assert.ok(preview);
  assert.equal(preview?.addedLines, 2);
  assert.equal(preview?.removedLines, 0);
  assert.ok(preview?.lines.some((line) => line.kind === "add" && line.text === "alpha"));
});
