import assert from "node:assert/strict";
import { test } from "node:test";

const { formatReadToolTitle } = await import(
  "../src/lib/agents/tool-display-labels.js"
);

test("read tools without a concrete path fall back to Ran", () => {
  assert.equal(formatReadToolTitle(undefined), "Ran");
});

test("read tools with a path still show the file basename", () => {
  assert.equal(formatReadToolTitle("src/lib/example.ts"), "Read example.ts");
});
