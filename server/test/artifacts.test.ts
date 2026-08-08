import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildChartArtifactHtml,
  createArtifact,
  deleteArtifact,
  ensureCesiumDirGitignored,
  listArtifacts,
  readArtifact,
  readArtifactFile,
  resolveArtifactFilePath,
  updateArtifact,
} from "../src/lib/artifacts/store.js";
import {
  ARTIFACTS_MCP_SERVER_ID,
  ARTIFACTS_MCP_TOOLS,
  artifactEmbedTag,
  callBuiltInArtifactTool,
} from "../src/lib/mcp/builtin-artifact-tools.js";
import {
  listBrowserControlTabs,
  resetBrowserControlForTests,
} from "../src/lib/browser-control/service.js";

async function makeWorkspaceRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "opencursor-artifacts-"));
}

test("createArtifact chart writes responsive index.html + chart.json under .cesium/artifacts", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const summary = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "chart",
      title: "Revenue Growth",
      chart: { type: "line", data: { labels: ["Q1", "Q2"], datasets: [] } },
    });
    assert.match(summary.id, /^revenue-growth-[0-9a-f]{6}$/);
    assert.equal(summary.kind, "chart");
    assert.equal(summary.entry, "index.html");
    assert.deepEqual(summary.files, ["chart.json", "index.html"]);
    assert.equal(summary.serverPath, `/artifacts/ws-1/${summary.id}/`);

    const html = await readFile(
      path.join(root, ".cesium", "artifacts", summary.id, "files", "index.html"),
      "utf8"
    );
    assert.match(html, /chart\.umd\.js/);
    assert.match(html, /width=device-width/);
    assert.match(html, /maintainAspectRatio/);

    const config = JSON.parse(
      await readArtifactFile({ workspaceRoot: root, artifactId: summary.id, path: "chart.json" })
    );
    assert.equal(config.type, "line");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createArtifact html wraps fragments in a responsive document", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const summary = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "html",
      title: "Fragment",
      html: "<h1>Hello</h1>",
    });
    const html = await readArtifactFile({
      workspaceRoot: root,
      artifactId: summary.id,
      path: "index.html",
    });
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /width=device-width/);
    assert.match(html, /<h1>Hello<\/h1>/);

    const fullDoc = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "html",
      title: "Full",
      html: "<html><body>whole page</body></html>",
    });
    const raw = await readArtifactFile({
      workspaceRoot: root,
      artifactId: fullDoc.id,
      path: "index.html",
    });
    assert.equal(raw, "<html><body>whole page</body></html>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createArtifact project requires entry file and keeps its own file tree", async () => {
  const root = await makeWorkspaceRoot();
  try {
    await assert.rejects(
      createArtifact({
        workspaceRoot: root,
        workspaceId: "ws-1",
        kind: "project",
        title: "Broken",
        files: { "app.js": "console.log(1);" },
      }),
      /entry file/
    );
    const summary = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "project",
      title: "Mini Site",
      files: {
        "index.html": "<html><script src='app.js'></script></html>",
        "app.js": "console.log('hi');",
        "css/style.css": "body { margin: 0; }",
      },
    });
    assert.deepEqual(summary.files, ["app.js", "css/style.css", "index.html"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact file paths cannot escape the artifact directory", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const summary = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "html",
      title: "Escape",
      html: "<p>safe</p>",
    });
    assert.throws(() => resolveArtifactFilePath(root, summary.id, "../../etc/passwd"));
    assert.throws(() => resolveArtifactFilePath(root, summary.id, "a/../../escape.txt"));
    // Leading slashes are treated as artifact-relative, not filesystem-absolute.
    const normalized = resolveArtifactFilePath(root, summary.id, "/etc/passwd");
    assert.ok(normalized.startsWith(path.join(root, ".cesium", "artifacts", summary.id, "files")));
    await assert.rejects(
      createArtifact({
        workspaceRoot: root,
        workspaceId: "ws-1",
        kind: "project",
        title: "Nope",
        entry: "index.html",
        files: { "index.html": "<p>x</p>", "../outside.txt": "leak" },
      })
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureCesiumDirGitignored appends .cesium/ once", async () => {
  const root = await makeWorkspaceRoot();
  try {
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
    await ensureCesiumDirGitignored(root);
    await ensureCesiumDirGitignored(root);
    const content = await readFile(path.join(root, ".gitignore"), "utf8");
    assert.equal(content.match(/\.cesium\//g)?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateArtifact upserts files, deletes paths, and bumps updatedAt", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const created = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "project",
      title: "Site",
      files: { "index.html": "<p>v1</p>", "old.js": "1" },
    });
    const updated = await updateArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      artifactId: created.id,
      title: "Site v2",
      files: { "index.html": "<p>v2</p>", "new.js": "2" },
      deletePaths: ["old.js"],
    });
    assert.equal(updated.title, "Site v2");
    assert.deepEqual(updated.files, ["index.html", "new.js"]);
    assert.ok(updated.updatedAt >= created.updatedAt);
    const html = await readArtifactFile({
      workspaceRoot: root,
      artifactId: created.id,
      path: "index.html",
    });
    assert.equal(html, "<p>v2</p>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listArtifacts and deleteArtifact round trip", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const a = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "html",
      title: "One",
      html: "<p>1</p>",
    });
    const b = await createArtifact({
      workspaceRoot: root,
      workspaceId: "ws-1",
      kind: "html",
      title: "Two",
      html: "<p>2</p>",
    });
    const listed = await listArtifacts({ workspaceRoot: root, workspaceId: "ws-1" });
    assert.deepEqual(new Set(listed.map((s) => s.id)), new Set([a.id, b.id]));

    assert.equal(await deleteArtifact({ workspaceRoot: root, artifactId: a.id }), true);
    assert.equal(await deleteArtifact({ workspaceRoot: root, artifactId: a.id }), false);
    assert.equal(await readArtifact({ workspaceRoot: root, workspaceId: "ws-1", artifactId: a.id }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built-in artifacts MCP server exposes expected tools", () => {
  assert.equal(ARTIFACTS_MCP_SERVER_ID, "artifacts");
  const names = new Set(ARTIFACTS_MCP_TOOLS.map((tool) => tool.name));
  assert.deepEqual(
    names,
    new Set([
      "artifact_create",
      "artifact_update",
      "artifact_list",
      "artifact_read",
      "artifact_open",
      "artifact_delete",
    ])
  );
});

test("callBuiltInArtifactTool create/list/read/update/delete round trip with embed tags", async () => {
  const root = await makeWorkspaceRoot();
  try {
    const created = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_create",
        arguments: {
          kind: "chart",
          title: "Inflation vs Rates",
          chart: JSON.stringify({ type: "bar", data: { labels: [], datasets: [] } }),
        },
      })
    );
    assert.equal(created.ok, true);
    assert.equal(created.embedTag, artifactEmbedTag(created.artifact.id));
    assert.match(created.instructions, /on its own line/);
    assert.match(created.url, new RegExp(`/artifacts/ws-artifacts/${created.artifact.id}/$`));

    const listed = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_list",
        arguments: {},
      })
    );
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0].embedTag, created.embedTag);

    const read = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_read",
        arguments: { artifactId: created.artifact.id, path: "chart.json" },
      })
    );
    assert.match(read.content, /"bar"/);

    const updated = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_update",
        arguments: {
          artifactId: created.artifact.id,
          chart: { type: "line", data: { labels: [], datasets: [] } },
        },
      })
    );
    assert.equal(updated.ok, true);
    const reread = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_read",
        arguments: { artifactId: created.artifact.id, path: "chart.json" },
      })
    );
    assert.match(reread.content, /"line"/);

    const deleted = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-artifacts",
        workspaceRoot: root,
        toolName: "artifact_delete",
        arguments: { artifactId: created.artifact.id },
      })
    );
    assert.equal(deleted.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact_open opens a visible proxy browser-control tab pointing at the artifact", async () => {
  resetBrowserControlForTests();
  const root = await makeWorkspaceRoot();
  try {
    const created = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-open",
        workspaceRoot: root,
        toolName: "artifact_create",
        arguments: { kind: "html", title: "Open Me", html: "<p>hi</p>" },
      })
    );
    const opened = JSON.parse(
      await callBuiltInArtifactTool({
        workspaceId: "ws-open",
        workspaceRoot: root,
        toolName: "artifact_open",
        arguments: { artifactId: created.artifact.id },
      })
    );
    assert.equal(opened.action, "opened_artifact_tab");
    const tabs = listBrowserControlTabs("ws-open");
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].engine, "proxy");
    assert.match(tabs[0].targetUrl, new RegExp(`/artifacts/ws-open/${created.artifact.id}/`));
    assert.equal(tabs[0].title, "Open Me");
  } finally {
    resetBrowserControlForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("chart artifact html escapes titles", () => {
  const html = buildChartArtifactHtml("<script>alert(1)</script>", "{}");
  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /&lt;script&gt;/);
});
