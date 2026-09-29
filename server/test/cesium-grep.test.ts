import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CesiumToolContext } from "../src/lib/agents/cesium/tools/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-grep-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
await fs.mkdir(TEST_DATA_DIR, { recursive: true });

// Dynamic imports after the OPENCURSOR_DATA_DIR override so persistence.ts
// never freezes DATA_DIR to the real data directory.
const [
  { grepTool },
  { resolveRipgrepBinary, setRipgrepBinaryOverride },
  { resolveCesiumTools, resolveCesiumToolPermissionCategory },
] = await Promise.all([
  import("../src/lib/agents/cesium/tools/file-tools.js"),
  import("../src/lib/agents/cesium/cesium-ripgrep.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
]);

after(async () => {
  setRipgrepBinaryOverride(undefined);
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

const ROOT = path.join(TEST_DATA_DIR, "repo");
const RIPGREP = await resolveRipgrepBinary();
const ripgrepOnly = { skip: RIPGREP ? false : "ripgrep is not installed" };

async function writeTree(files: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(ROOT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
}

await writeTree({
  ".gitignore": "lib/\n*.log\n# comment\n",
  ".git/HEAD": "needle in git metadata\n",
  ".github/workflow.yml": "run: needle hidden but tracked\n",
  "src/a.ts": "export const Needle = 1;\nconst other = 2;\nneedle lower\nlast line\n",
  "src/sub/b.tsx": "needle in tsx\n",
  "src/.gitignore": "generated/\n",
  "src/generated/g.ts": "needle generated\n",
  "src/bin.dat": Buffer.from("needle\u0000binary", "utf8"),
  "lib/ignored.ts": "needle ignored dir\n",
  "build.log": "needle log file\n",
  "node_modules/pkg/index.ts": "needle vendored\n",
  "docs/notes.md": "Needle upper\n--flag needle\n",
});

type GrepHandle = {
  toolGrep: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

async function startSession(): Promise<GrepHandle> {
  const ctx: CesiumToolContext = {
    workspace: { id: "ws-grep", root: ROOT, name: "ws-grep", createdAt: 1 },
    conversationId: "cesium-grep-tool",
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    extraRoots: [],
    readOnlyRoot: path.join(ROOT, ".tool-output"),
    turnSupportsImages: false,
    attachImage: () => undefined,
    refineTitle: () => undefined,
  };
  return { toolGrep: (args) => grepTool(ctx, args), dispose: async () => undefined };
}

const handle = await startSession();
after(async () => {
  await handle.dispose();
});

async function grepWith(engine: "ripgrep" | "javascript", args: Record<string, unknown>): Promise<string> {
  setRipgrepBinaryOverride(engine === "ripgrep" ? RIPGREP : null);
  try {
    return await handle.toolGrep(args);
  } finally {
    setRipgrepBinaryOverride(undefined);
  }
}

const QUERIES: Array<Record<string, unknown>> = [
  { pattern: "needle" },
  { pattern: "needle", ignoreCase: true },
  { pattern: "Needle" },
  { pattern: "needle", glob: "*.ts" },
  { pattern: "needle", glob: "src/**/*.tsx" },
  { pattern: "needle", glob: "!*.md", ignoreCase: true },
  { pattern: "other", context: 1 },
  { pattern: "--flag" },
  { pattern: "needle", path: "src" },
  { pattern: "Needle", path: "src/a.ts", context: 5 },
  { pattern: "needle", ignoreCase: true, maxResults: 2 },
  { pattern: "zzz_no_such_text" },
];

for (const engine of ["ripgrep", "javascript"] as const) {
  test(`grep via ${engine}: case-sensitive by default, filters, and skips ignored/binary/vendor files`, engine === "ripgrep" ? ripgrepOnly : {}, async () => {
    assert.equal(
      await grepWith(engine, { pattern: "needle" }),
      [
        ".github/workflow.yml:1\n1|run: needle hidden but tracked",
        "docs/notes.md:2\n2|--flag needle",
        "src/a.ts:3\n3|needle lower",
        "src/sub/b.tsx:1\n1|needle in tsx",
      ].join("\n\n"),
      "gitignored (lib/, *.log, nested generated/), binary, .git, and node_modules files are skipped"
    );
    assert.equal(
      await grepWith(engine, { pattern: "Needle" }),
      "docs/notes.md:1\n1|Needle upper\n\nsrc/a.ts:1\n1|export const Needle = 1;"
    );
    const insensitive = await grepWith(engine, { pattern: "NEEDLE", ignoreCase: true });
    assert.ok(insensitive.includes("src/a.ts:1") && insensitive.includes("src/a.ts:3"), insensitive);
    assert.equal(
      await grepWith(engine, { pattern: "needle", glob: "*.tsx" }),
      "src/sub/b.tsx:1\n1|needle in tsx"
    );
    assert.equal(
      await grepWith(engine, { pattern: "other", context: 1 }),
      "src/a.ts:2\n1|export const Needle = 1;\n2|const other = 2;\n3|needle lower"
    );
    assert.equal(await grepWith(engine, { pattern: "--flag" }), "docs/notes.md:2\n2|--flag needle");
    const capped = await grepWith(engine, { pattern: "needle", ignoreCase: true, maxResults: 2 });
    assert.match(capped, /\.\.\.\[2 matches shown; more exist - raise maxResults \(max 5000\)/);
    assert.equal(await grepWith(engine, { pattern: "zzz_no_such_text" }), "No matches.");
    assert.equal(
      await grepWith(engine, { pattern: "needle(?= lower)" }),
      "src/a.ts:3\n3|needle lower",
      "lookaround works on either path"
    );
  });
}

test("ripgrep and the fallback walker return identical results", ripgrepOnly, async () => {
  for (const query of QUERIES) {
    assert.equal(
      await grepWith("ripgrep", query),
      await grepWith("javascript", query),
      `divergence for ${JSON.stringify(query)}`
    );
  }
});

test("grep validates the pattern and path", async () => {
  for (const engine of RIPGREP ? (["ripgrep", "javascript"] as const) : (["javascript"] as const)) {
    await assert.rejects(grepWith(engine, { pattern: "(" }), /grep\.pattern is not a valid/);
  }
  await assert.rejects(handle.toolGrep({ pattern: "x", path: "../" }), /Path escapes workspace/);
  await assert.rejects(handle.toolGrep({ pattern: "x", path: "missing" }), /grep\.path does not exist: missing/);
  await assert.rejects(handle.toolGrep({}), /grep\.pattern is required/);
});

test("grep advertises ripgrep syntax, ignoreCase, and glob, and needs no permission", () => {
  const tools = resolveCesiumTools().tools;
  const grep = tools.find((tool) => tool.name === "grep");
  assert.ok(grep);
  assert.equal(resolveCesiumToolPermissionCategory(tools, "grep"), undefined);
  const properties = (grep!.parameters as { properties: Record<string, { description?: string }> }).properties;
  assert.ok(properties.ignoreCase && properties.glob);
  assert.match(properties.pattern!.description ?? "", /ripgrep \(Rust regex\) syntax/);
  assert.doesNotMatch(grep!.description, /JavaScript regular expression/);
});
