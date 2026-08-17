import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";

const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "cesium-ws-bootstrap-"));
const tempWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-ws-root-"));
process.env.OPENCURSOR_DATA_DIR = tempDataDir;
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";
// A configured WORKSPACE_ROOT (the mobile shell always sets one) must NOT be
// auto-registered anymore; it is only a hint for browse/create flows.
process.env.WORKSPACE_ROOT = tempWorkspaceRoot;

const { workspaceRoutes } = await import("../src/routes/workspaces.ts");
const { ensureWorkspaceRegistered, listWorkspaces } = await import(
  "../src/lib/workspace-registry.ts"
);

const app = new Hono();
app.route("/", workspaceRoutes);

type BootstrapPayload = {
  workspaces: Array<{ id: string; name: string; root: string }>;
  defaultWorkspaceId: string | null;
  startupWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  homeWorkspaceId: string | null;
};

describe("workspace bootstrap on a fresh install", () => {
  after(async () => {
    await rm(tempDataDir, { recursive: true, force: true });
    await rm(tempWorkspaceRoot, { recursive: true, force: true });
  });

  test("bootstrap does not seed any workspace (no default, no Home)", async () => {
    const response = await app.request("/api/workspaces/bootstrap");
    assert.equal(response.status, 200);
    const body = (await response.json()) as BootstrapPayload;

    assert.deepEqual(body.workspaces, []);
    assert.equal(body.startupWorkspaceId, null);
    assert.equal(body.defaultWorkspaceId, null);
    assert.equal(body.homeWorkspaceId, null);
    assert.deepEqual(body.recentWorkspaceIds, []);

    // The call must not have registered anything as a side effect either.
    assert.deepEqual(await listWorkspaces(), []);
  });

  test("workspace listing does not seed the Home workspace", async () => {
    const response = await app.request("/api/workspaces");
    assert.equal(response.status, 200);
    const body = (await response.json()) as BootstrapPayload;

    assert.deepEqual(body.workspaces, []);
    assert.equal(body.homeWorkspaceId, null);
    assert.deepEqual(await listWorkspaces(), []);
  });

  test("bootstrap surfaces explicitly registered workspaces as startup", async () => {
    const registered = await ensureWorkspaceRegistered(tempWorkspaceRoot);

    const response = await app.request("/api/workspaces/bootstrap");
    assert.equal(response.status, 200);
    const body = (await response.json()) as BootstrapPayload;

    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0]?.id, registered.id);
    assert.equal(body.startupWorkspaceId, registered.id);
  });
});
