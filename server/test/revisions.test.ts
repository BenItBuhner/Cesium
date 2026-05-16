import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

// Isolate every run so legacy JSON writes land in a throwaway directory and
// drivers / caches hit their in-process fallbacks.
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-revisions-tests-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
);
delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const { ensureDataDir } = await import("../src/lib/persistence.js");
await ensureDataDir();

const { Hono } = await import("hono");
const { settingsRoutes } = await import("../src/routes/settings.js");
const { workspaceRoutes } = await import("../src/routes/workspaces.js");
const { resetRevisionsForTesting } = await import(
  "../src/storage/revisions.js"
);
const { ensureWorkspaceRegistered } = await import(
  "../src/lib/workspace-registry.js"
);
const fsPromises = await import("node:fs/promises");

function makeApp() {
  const app = new Hono();
  app.route("/", settingsRoutes);
  app.route("/", workspaceRoutes);
  return app;
}

before(() => {
  resetRevisionsForTesting();
});

after(async () => {
  const fs = await import("node:fs/promises");
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("ETag / If-Match for global settings", () => {
  test("GET emits a weak ETag that round-trips into a 304 on If-None-Match", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    const first = await app.request("/api/settings/global");
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "ETag header should be set on GET");
    assert.match(etag!, /^W\/"\d+"$/);
    const body = (await first.json()) as {
      settings: unknown;
      revision: number;
    };
    assert.equal(typeof body.revision, "number");

    const cached = await app.request("/api/settings/global", {
      headers: { "if-none-match": etag! },
    });
    assert.equal(cached.status, 304);
    const cachedEtag = cached.headers.get("etag");
    assert.equal(cachedEtag, etag);
  });

  test("PUT with matching If-Match succeeds and advances the revision", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    const initial = await app.request("/api/settings/global");
    const etag0 = initial.headers.get("etag");
    assert.ok(etag0);

    const response = await app.request("/api/settings/global", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "if-match": etag0!,
      },
      body: JSON.stringify({ settings: { version: 1 } }),
    });
    assert.equal(response.status, 200);
    const etag1 = response.headers.get("etag");
    assert.ok(etag1);
    assert.notEqual(etag1, etag0, "ETag should change after a successful PUT");
    const body = (await response.json()) as { ok: true; revision: number };
    assert.ok(body.revision > 0);
  });

  test("PUT with stale If-Match returns 412 and the current ETag", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    await app.request("/api/settings/global"); // seed revision=0 in registry

    // Advance state with one successful PUT so the server's counter is > 0.
    const firstPut = await app.request("/api/settings/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { version: 1 } }),
    });
    assert.equal(firstPut.status, 200);

    // Client attempts to PUT while still believing it holds revision 0.
    const stale = await app.request("/api/settings/global", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "if-match": 'W/"0"',
      },
      body: JSON.stringify({ settings: { version: 2 } }),
    });
    assert.equal(stale.status, 412);
    const etag = stale.headers.get("etag");
    assert.ok(etag, "412 responses should include the current ETag so the client can retry");
    const body = (await stale.json()) as {
      error: string;
      actualRevision: number;
      expectedRevision: number;
    };
    assert.equal(body.error, "Revision mismatch");
    assert.equal(body.expectedRevision, 0);
    assert.equal(body.actualRevision, 1);
  });

  test("PUT without If-Match always wins (no opt-in, no rejection)", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    await app.request("/api/settings/global");
    const first = await app.request("/api/settings/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { version: 1 } }),
    });
    assert.equal(first.status, 200);
    const second = await app.request("/api/settings/global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { version: 2 } }),
    });
    assert.equal(second.status, 200);
  });
});

async function makeWorkspace(name: string) {
  const root = path.join(TEST_DATA_DIR, name);
  await fsPromises.mkdir(root, { recursive: true });
  return ensureWorkspaceRegistered(root, name, { trackOpen: false });
}

describe("ETag / If-Match for workspace session", () => {
  test("session GET emits ETag and subsequent PUT accepts matching If-Match", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    const workspace = await makeWorkspace("workspace-a");

    const initial = await app.request(
      `/api/workspaces/${encodeURIComponent(workspace.id)}/session`
    );
    assert.equal(initial.status, 200);
    const etag0 = initial.headers.get("etag");
    assert.ok(etag0);

    const put = await app.request(
      `/api/workspaces/${encodeURIComponent(workspace.id)}/session`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "if-match": etag0!,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          editor: null,
          chat: null,
          explorer: null,
          layout: null,
          agentView: null,
          settingsView: null,
        }),
      }
    );
    assert.equal(put.status, 200);
    const etag1 = put.headers.get("etag");
    assert.ok(etag1);
    assert.notEqual(etag1, etag0);
  });

  test("stale If-Match on session PUT returns 412", async () => {
    resetRevisionsForTesting();
    const app = makeApp();
    const workspace = await makeWorkspace("workspace-b");

    const sessionUrl = `/api/workspaces/${encodeURIComponent(workspace.id)}/session`;
    await app.request(sessionUrl);

    // Bump server state with one write.
    const first = await app.request(sessionUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        editor: null,
        chat: null,
        explorer: null,
        layout: null,
        agentView: null,
        settingsView: null,
      }),
    });
    assert.equal(first.status, 200);

    // Now pretend we still hold the pre-write revision.
    const stale = await app.request(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "if-match": 'W/"0"',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        editor: null,
        chat: null,
        explorer: null,
        layout: null,
        agentView: null,
        settingsView: null,
      }),
    });
    assert.equal(stale.status, 412);
    const body = (await stale.json()) as {
      error: string;
      actualRevision: number;
      expectedRevision: number;
    };
    assert.equal(body.error, "Revision mismatch");
    assert.equal(body.expectedRevision, 0);
    assert.equal(body.actualRevision, 1);
  });
});
