import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AgentConversationRecord } from "../src/lib/agents/types.js";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-glob-tests-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
await fs.mkdir(TEST_DATA_DIR, { recursive: true });

// Dynamic imports after the OPENCURSOR_DATA_DIR override so persistence.ts
// never freezes DATA_DIR to the real data directory.
const [
  { AGENT_BACKENDS },
  { createCesiumAgentProvider },
  { globToRegExp, globWorkspaceEntries },
  { resolveCesiumTools, toolKind, toolTitle, resolveCesiumToolPermissionCategory },
  { resolveCesiumModeToolPolicy, summarizeCesiumModeToolPolicy },
  { CESIUM_PROFILE_LOCKED_TOOLS },
  { SUBAGENT_SHARED_HOST_TOOL_NAMES },
] = await Promise.all([
  import("../src/lib/agents/providers.js"),
  import("../src/lib/agents/cesium-provider.js"),
  import("../src/lib/agents/cesium/cesium-glob.js"),
  import("../src/lib/agents/cesium/cesium-tools.js"),
  import("../src/lib/agents/cesium-mode-policy.js"),
  import("../src/lib/agents/cesium-profiles.js"),
  import("../src/lib/agents/cesium/subagent-toolset.js"),
]);

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

test("globToRegExp covers *, **, ?, {a,b}, and [...] over slash-separated paths", () => {
  const star = globToRegExp("*.ts");
  assert.ok(star.test("a.ts"));
  assert.ok(!star.test("src/a.ts"), "* must not cross a segment");

  const deep = globToRegExp("src/**/*.ts");
  assert.ok(deep.test("src/a.ts"), "**/ matches zero segments");
  assert.ok(deep.test("src/x/y/a.ts"));
  assert.ok(!deep.test("lib/a.ts"));

  const anyDepth = globToRegExp("**/*.md");
  assert.ok(anyDepth.test("README.md"));
  assert.ok(anyDepth.test("docs/guide/intro.md"));

  assert.ok(globToRegExp("?.ts").test("a.ts"));
  assert.ok(!globToRegExp("?.ts").test("ab.ts"));

  const alt = globToRegExp("**/*.{test,spec}.ts");
  assert.ok(alt.test("src/a.test.ts"));
  assert.ok(alt.test("a.spec.ts"));
  assert.ok(!alt.test("a.ts"));

  assert.ok(globToRegExp("[ab].ts").test("a.ts"));
  assert.ok(!globToRegExp("[ab].ts").test("c.ts"));

  // Leading "./", trailing "/", and backslashes normalise away.
  assert.ok(globToRegExp("./src\\*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/").test("src"));
  // Regex metacharacters in literals are escaped.
  assert.ok(globToRegExp("a+b.ts").test("a+b.ts"));
  assert.ok(!globToRegExp("a+b.ts").test("aab.ts"));
});

async function writeFixtureTree(root: string): Promise<void> {
  const files = [
    "README.md",
    "a.ts",
    "src/b.ts",
    "src/sub/c.test.ts",
    "src/sub/d.md",
    "node_modules/pkg/index.ts",
    ".git/HEAD",
    ".next/cache.ts",
  ];
  for (const file of files) {
    const full = path.join(root, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `// ${file}\n`, "utf8");
  }
  await fs.mkdir(path.join(root, "empty-dir"), { recursive: true });
}

test("globWorkspaceEntries lists a directory with '*' and recurses with '**', skipping vendor dirs", async () => {
  const root = path.join(TEST_DATA_DIR, "tree-a");
  await writeFixtureTree(root);

  const listing = await globWorkspaceEntries({ workspaceRoot: root, searchRoot: root, pattern: "*" });
  assert.deepEqual(
    listing.entries.map((entry) => entry.path),
    ["README.md", "a.ts", "empty-dir/", "src/"],
    "'*' is a directory listing: files plus directories (with trailing slash), no .git/node_modules/.next"
  );
  assert.equal(listing.truncated, false);

  const typescript = await globWorkspaceEntries({
    workspaceRoot: root,
    searchRoot: root,
    pattern: "**/*.ts",
  });
  assert.deepEqual(
    typescript.entries.map((entry) => entry.path),
    ["a.ts", "src/b.ts", "src/sub/c.test.ts"],
    "recursive matches exclude node_modules and .next"
  );

  const scoped = await globWorkspaceEntries({
    workspaceRoot: root,
    searchRoot: path.join(root, "src"),
    pattern: "**/*.{test,spec}.ts",
  });
  assert.deepEqual(
    scoped.entries.map((entry) => entry.path),
    ["src/sub/c.test.ts"],
    "pattern is relative to the search root but results are workspace-relative"
  );

  const capped = await globWorkspaceEntries({
    workspaceRoot: root,
    searchRoot: root,
    pattern: "**/*.ts",
    maxResults: 2,
  });
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.truncated, true);
});

type GlobToolHandle = {
  toolGlob: (args: Record<string, unknown>) => Promise<string>;
  dispose: () => Promise<void>;
};

test("glob tool returns sorted workspace-relative paths and rejects paths outside the workspace", async () => {
  const root = path.join(TEST_DATA_DIR, "tree-b");
  await writeFixtureTree(root);
  const backend = AGENT_BACKENDS["cesium-agent"]!;
  const provider = await createCesiumAgentProvider({ backend });
  let conversation: AgentConversationRecord = {
    schemaVersion: 1,
    id: "cesium-glob-tool",
    workspaceId: "ws-glob",
    title: "Glob tool",
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cesium-agent",
      mode: "ask",
      modelId: "openai/gpt-5.1",
      modelName: "GPT-5.1",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: backend.capabilities,
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
  };
  const handle = (await provider.startSession({
    conversation,
    workspace: { id: "ws-glob", root, name: "glob", createdAt: 1 },
    appendEvents: async () => undefined,
    readSnapshot: async () => null,
    updateConversation: async (patch) => {
      conversation =
        typeof patch === "function" ? patch(conversation) : { ...conversation, ...patch };
      return conversation;
    },
  })) as unknown as GlobToolHandle;
  try {
    assert.equal(
      await handle.toolGlob({ pattern: "*", path: "src" }),
      "src/b.ts\nsrc/sub/"
    );
    assert.equal(
      await handle.toolGlob({ pattern: "**/*.md" }),
      "README.md\nsrc/sub/d.md"
    );
    assert.match(await handle.toolGlob({ pattern: "*.py" }), /^No matches for \*\.py under \./);
    const capped = await handle.toolGlob({ pattern: "**/*", maxResults: 1 });
    assert.ok(capped.includes("more matches exist"), capped);
    await assert.rejects(
      handle.toolGlob({ pattern: "*", path: "../" }),
      /Path escapes workspace/
    );
    await assert.rejects(
      handle.toolGlob({ pattern: "*", path: "a.ts" }),
      /must be an existing directory/
    );
    await assert.rejects(handle.toolGlob({}), /glob\.pattern is required/);
  } finally {
    await handle.dispose();
  }
});

test("glob is advertised as a read-only workspace tool in every mode and profile", () => {
  const advertised = resolveCesiumTools().tools.find((tool) => tool.name === "glob");
  assert.ok(advertised, "glob must be in the base tool set");
  assert.equal(advertised!.requiresPermission, undefined, "listing files needs no permission");
  assert.equal(resolveCesiumToolPermissionCategory(resolveCesiumTools().tools, "glob"), undefined);
  assert.equal(toolKind("glob"), "search");
  assert.equal(toolTitle("glob", { pattern: "*", path: "src" }), "Glob * in src");
  assert.equal(toolTitle("glob", { pattern: "**/*.ts" }), "Glob **/*.ts");

  for (const mode of ["ask", "plan", "agent", "goal", "workflow"]) {
    assert.equal(
      resolveCesiumModeToolPolicy({ mode, toolName: "glob" }).allowed,
      true,
      `glob should be allowed in ${mode} mode (it is read-only)`
    );
    assert.ok(
      summarizeCesiumModeToolPolicy(mode).allowed.includes("glob"),
      `${mode} mode reminder should list glob as allowed`
    );
  }
  // Orchestration mode blocks direct workspace tools, glob included.
  assert.equal(resolveCesiumModeToolPolicy({ mode: "orchestration", toolName: "glob" }).allowed, false);

  assert.ok(CESIUM_PROFILE_LOCKED_TOOLS.includes("glob"), "every profile keeps glob like read_file/grep");
  assert.ok(SUBAGENT_SHARED_HOST_TOOL_NAMES.includes("glob"), "subagents share glob with the parent");
});
