import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const {
  extractCursorPromptPathHints,
  extractCursorPromptSearchHints,
  inferCursorReadPathFromContent,
  inferCursorSearchLocations,
} = await import("../src/lib/agents/providers.js");

test("extractCursorPromptPathHints preserves explicit workspace file order", () => {
  const hints = extractCursorPromptPathHints(
    repoRoot,
    "Read exactly these files: package.json, README.md, server/src/lib/agents/providers.ts"
  );
  assert.deepEqual(hints, [
    "package.json",
    "README.md",
    "server/src/lib/agents/providers.ts",
  ]);
});

test("extractCursorPromptSearchHints parses reference queries", () => {
  const hints = extractCursorPromptSearchHints(
    "Then find all references to summarizeAcpToolCallTitle across the workspace."
  );
  assert.deepEqual(hints, [
    {
      query: "summarizeAcpToolCallTitle",
      presentation: "find",
    },
  ]);
});

test("inferCursorReadPathFromContent matches file content back to a workspace path", async () => {
  const packageJson = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const inferred = await inferCursorReadPathFromContent(repoRoot, packageJson, [
    "README.md",
    "package.json",
  ]);
  assert.equal(inferred, "package.json");
});

test("inferCursorSearchLocations returns concrete file locations for symbol references", async () => {
  const locations = await inferCursorSearchLocations(repoRoot, "summarizeAcpToolCallTitle");
  assert.ok(locations.length > 0, "expected at least one inferred search location");
  assert.ok(
    locations.some(
      (location) =>
        location.path === "server/src/lib/agents/providers.ts" &&
        typeof location.line === "number" &&
        location.line > 0
    ),
    "expected providers.ts to appear in inferred locations"
  );
});
