import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";

const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "cesium-skills-api-"));
const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-skills-empty-"));
const populatedRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-skills-pop-"));
process.env.OPENCURSOR_DATA_DIR = tempDataDir;
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";

const { workspaceRoutes } = await import("../src/routes/workspaces.ts");
const { ensureWorkspaceRegistered } = await import("../src/lib/workspace-registry.ts");

const app = new Hono();
app.route("/", workspaceRoutes);

describe("workspace skills catalog API", () => {
  after(async () => {
    await rm(tempDataDir, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(populatedRoot, { recursive: true, force: true });
  });

  test("returns an empty list when the workspace has no skills", async () => {
    const workspace = await ensureWorkspaceRegistered(emptyRoot);
    const response = await app.request(`/api/workspaces/${encodeURIComponent(workspace.id)}/skills`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { skills: unknown[] };
    assert.deepEqual(body.skills, []);
  });

  test("lists discovered skills including OpenCode", async () => {
    const skillDir = path.join(populatedRoot, ".opencode", "skills", "oc-demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: oc-demo
description: OpenCode skill exposed over the catalog API.
disable-model-invocation: true
---

# Body
`,
      "utf8"
    );
    const workspace = await ensureWorkspaceRegistered(populatedRoot);
    const response = await app.request(`/api/workspaces/${encodeURIComponent(workspace.id)}/skills`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      skills: Array<{
        name: string;
        source: string;
        relativePath: string;
        disableModelInvocation: boolean;
        skillDir?: string;
      }>;
    };
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0]?.name, "oc-demo");
    assert.equal(body.skills[0]?.source, "opencode");
    assert.equal(body.skills[0]?.relativePath, ".opencode/skills/oc-demo/SKILL.md");
    assert.equal(body.skills[0]?.disableModelInvocation, true);
    assert.equal(body.skills[0]?.skillDir, undefined);
  });

  test("returns 404 for an unknown workspace", async () => {
    const response = await app.request("/api/workspaces/does-not-exist/skills");
    assert.equal(response.status, 404);
  });
});
