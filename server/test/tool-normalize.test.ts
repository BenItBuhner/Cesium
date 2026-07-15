import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "../src/lib/agents/tool-normalize.js";

test("infers canonical tool kinds for common SDK and dynamic tools", () => {
  assert.equal(inferCanonicalToolKind({ name: "Read", input: { file_path: "src/app.ts" } }), "read");
  assert.equal(inferCanonicalToolKind({ name: "Bash", input: { command: "rg \"foo\" src" } }), "grep");
  assert.equal(inferCanonicalToolKind({ name: "web_fetch", input: { url: "https://example.com" } }), "fetch");
  assert.equal(inferCanonicalToolKind({ name: "mcp__context7__query_docs" }), "mcp");
  assert.equal(inferCanonicalToolKind({ name: "AskUserQuestion" }), "question");
  assert.equal(inferCanonicalToolKind({ name: "TodoWrite" }), "todo");
  assert.equal(inferCanonicalToolKind({ name: "WebSearch", input: { query: "docs" } }), "search_web");
  assert.equal(inferCanonicalToolKind({ name: "Glob", input: { pattern: "**/*.ts" } }), "search");
});

test("formats canonical tool titles consistently", () => {
  assert.equal(
    titleForCanonicalTool({
      name: "Read",
      kind: "read",
      payload: { input: { file_path: "server/src/index.ts" } },
    }),
    "Read index.ts"
  );
  assert.equal(
    titleForCanonicalTool({
      name: "Bash",
      kind: "terminal",
      payload: { input: { command: "npm test" } },
    }),
    "Ran npm test"
  );
  assert.equal(
    titleForCanonicalTool({
      name: "SearchWeb",
      kind: "search_web",
      payload: { input: { query: "Cursor SDK mcpServers" } },
    }),
    "Web · Cursor SDK mcpServers"
  );
});

test("extracts locations and useful details from structured tool payloads", () => {
  assert.deepEqual(
    locationsForToolPayload({
      input: { path: "src/a.ts" },
      result: { files: ["src/b.ts", { file_path: "src/c.ts" }] },
    }),
    [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }]
  );
  assert.equal(detailForToolPayload({ result: { totalFiles: 3 } }), "3 files matched");
  assert.equal(detailForToolPayload({ result: { value: { totalLines: 8 } } }), "8 lines");
  assert.equal(detailForToolPayload({ result: { content: "hello" } }), "hello");
});
