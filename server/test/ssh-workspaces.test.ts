import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

/**
 * SSH workspace test suite.
 *
 * Covers the surface introduced by OSP-97 (SSH mode):
 *   - SSH target / port parsing
 *   - Remote git clone + remote directory name validation
 *   - JSON-store mutation (get/remove, password redaction, schema rejection)
 *   - Lifecycle error paths for `pullSshWorkspace` / `pushSshWorkspace`
 *   - Workspace deletion cleanup (`removeSshWorkspaceMetadata`)
 *
 * The actual SSH/SFTP wire traffic requires a live OpenSSH server and is
 * therefore covered separately by a manual smoke. Everything testable
 * synchronously (parsing, validation, store I/O) lives here.
 */

const TEST_ROOT = path.join(
  os.tmpdir(),
  `cesium-ssh-workspaces-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_ROOT;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_ROOT;
process.env.NODE_ENV = "test";

const { DATA_DIR, ensureDataDir } = await import("../src/lib/persistence.js");
await ensureDataDir();

const { removeWorkspace, ensureWorkspaceRegistered } = await import(
  "../src/lib/workspace-registry.js"
);
const {
  browseSshDirectories,
  cloneRemoteGitDirectoryOverSsh,
  createRemoteSshDirectory,
  getSshWorkspaceMetadata,
  probeSshConnection,
  pullSshWorkspace,
  pushSshWorkspace,
  removeSshWorkspaceMetadata,
} = await import("../src/lib/ssh-workspaces.js");

const SSH_STORE_PATH = path.join(DATA_DIR, "ssh-workspaces.json");

type StoredSshWorkspace = {
  schemaVersion: 1;
  workspaceId: string;
  target: string;
  user: string | null;
  host: string;
  port: number | null;
  remotePath: string;
  localRoot: string;
  keyPath: string | null;
  password: string | null;
  createdAt: number;
  updatedAt: number;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
};

function makeStoredWorkspace(overrides: Partial<StoredSshWorkspace> = {}): StoredSshWorkspace {
  return {
    schemaVersion: 1,
    workspaceId: overrides.workspaceId ?? "seed",
    target: overrides.target ?? "user@host",
    user: overrides.user ?? "user",
    host: overrides.host ?? "host",
    port: overrides.port ?? null,
    remotePath: overrides.remotePath ?? "/srv/app",
    localRoot:
      overrides.localRoot ?? path.join(TEST_ROOT, "ssh-workspaces", "seed"),
    keyPath: overrides.keyPath ?? null,
    password: overrides.password ?? null,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    lastPulledAt: overrides.lastPulledAt ?? 1,
    lastPushedAt: overrides.lastPushedAt ?? null,
  };
}

async function writeStore(workspaces: StoredSshWorkspace[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    SSH_STORE_PATH,
    JSON.stringify({ schemaVersion: 1, workspaces }, null, 2)
  );
}

async function readStore(): Promise<{
  schemaVersion: number;
  workspaces: StoredSshWorkspace[];
}> {
  const raw = await readFile(SSH_STORE_PATH, "utf8");
  return JSON.parse(raw) as {
    schemaVersion: number;
    workspaces: StoredSshWorkspace[];
  };
}

before(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  await rm(SSH_STORE_PATH, { force: true }).catch(() => undefined);
});

describe("SSH target + port parsing (via probeSshConnection)", () => {
  test("rejects an empty target before attempting to connect", async () => {
    await assert.rejects(
      probeSshConnection({ target: "" }),
      /SSH target is required/
    );
  });

  test("rejects a target containing whitespace", async () => {
    await assert.rejects(
      probeSshConnection({ target: "user@hostname host" }),
      /must not contain spaces/
    );
  });

  test("steers users toward the dedicated Port field when the host carries `:port`", async () => {
    await assert.rejects(
      probeSshConnection({ target: "user@example.invalid:22" }),
      /Use the Port field/
    );
  });

  test("rejects target with an empty host (e.g. `user@`)", async () => {
    await assert.rejects(
      probeSshConnection({ target: "user@" }),
      /user@host|ssh:\/\/|target/i
    );
  });

  test("rejects an out-of-range port", async () => {
    await assert.rejects(
      probeSshConnection({
        target: "user@example.invalid",
        port: 70_000,
      }),
      /between 1 and 65535/
    );
  });

  test("rejects a zero port", async () => {
    await assert.rejects(
      probeSshConnection({
        target: "user@example.invalid",
        port: 0,
      }),
      /between 1 and 65535/
    );
  });
});

describe("remote git clone validation (cloneRemoteGitDirectoryOverSsh)", () => {
  test("rejects a directory name that contains a path separator", async () => {
    await assert.rejects(
      cloneRemoteGitDirectoryOverSsh({
        target: "user@example.invalid",
        repoUrl: "https://github.com/owner/repo.git",
        parentRemotePath: "/srv",
        directoryName: "nested/path",
      }),
      /single path segment/
    );
  });

  test("rejects '.' and '..' directory names", async () => {
    for (const directoryName of [".", ".."]) {
      await assert.rejects(
        cloneRemoteGitDirectoryOverSsh({
          target: "user@example.invalid",
          repoUrl: "https://github.com/owner/repo.git",
          parentRemotePath: "/srv",
          directoryName,
        }),
        /single path segment/
      );
    }
  });

  test("rejects an empty repo URL before reaching the network", async () => {
    await assert.rejects(
      cloneRemoteGitDirectoryOverSsh({
        target: "user@example.invalid",
        repoUrl: "   ",
        parentRemotePath: "/srv",
        directoryName: "ok",
      }),
      /Repository URL is required/
    );
  });

  test("rejects non-http(s) / non-git@ remotes (e.g. file://)", async () => {
    await assert.rejects(
      cloneRemoteGitDirectoryOverSsh({
        target: "user@example.invalid",
        repoUrl: "file:///etc/passwd",
        parentRemotePath: "/srv",
        directoryName: "ok",
      }),
      /http\(s\)|git@|supported/i
    );
  });

  test("rejects a git@ remote that does not follow user@host:path", async () => {
    await assert.rejects(
      cloneRemoteGitDirectoryOverSsh({
        target: "user@example.invalid",
        repoUrl: "git@example.com",
        parentRemotePath: "/srv",
        directoryName: "ok",
      }),
      /git@host:path/
    );
  });
});

describe("createRemoteSshDirectory validation", () => {
  test("rejects a name with forward slashes", async () => {
    await assert.rejects(
      createRemoteSshDirectory({
        target: "user@example.invalid",
        remotePath: "/srv",
        directoryName: "with/slash",
      }),
      /path separator/
    );
  });

  test("rejects a name with backslashes", async () => {
    await assert.rejects(
      createRemoteSshDirectory({
        target: "user@example.invalid",
        remotePath: "/srv",
        directoryName: "with\\slash",
      }),
      /path separator/
    );
  });

  test("rejects an empty / whitespace-only name", async () => {
    await assert.rejects(
      createRemoteSshDirectory({
        target: "user@example.invalid",
        remotePath: "/srv",
        directoryName: "   ",
      }),
      /path separator/
    );
  });
});

describe("browseSshDirectories validation", () => {
  test("propagates SSH target parse errors before opening any connection", async () => {
    await assert.rejects(
      browseSshDirectories({
        target: "   ", // whitespace-only → "SSH target is required."
        remotePath: "/srv",
      }),
      /SSH target is required/
    );
  });

  test("rejects targets that embed `:port` in the host", async () => {
    await assert.rejects(
      browseSshDirectories({
        target: "user@example.invalid:22",
        remotePath: "/srv",
      }),
      /Use the Port field/
    );
  });
});

describe("SSH workspace metadata store", () => {
  test("getSshWorkspaceMetadata returns null when the workspace is unknown", async () => {
    const result = await getSshWorkspaceMetadata("does-not-exist");
    assert.equal(result, null);
  });

  test("getSshWorkspaceMetadata strips the stored password from the public payload", async () => {
    await writeStore([
      makeStoredWorkspace({
        workspaceId: "secret-test",
        target: "alice@bastion",
        user: "alice",
        host: "bastion",
        port: 2222,
        password: "do-not-leak-me",
        keyPath: "/home/alice/.ssh/id_ed25519",
      }),
    ]);

    const metadata = await getSshWorkspaceMetadata("secret-test");

    assert.ok(metadata, "metadata should be returned");
    assert.equal(metadata.target, "alice@bastion");
    assert.equal(metadata.user, "alice");
    assert.equal(metadata.port, 2222);
    assert.equal(metadata.keyPath, "/home/alice/.ssh/id_ed25519");
    assert.equal(
      (metadata as unknown as { password?: string }).password,
      undefined,
      "password must not be present on the public metadata"
    );
  });

  test("getSshWorkspaceMetadata returns null when the store has the wrong schemaVersion", async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(
      SSH_STORE_PATH,
      JSON.stringify({ schemaVersion: 999, workspaces: [] })
    );
    const result = await getSshWorkspaceMetadata("anything");
    assert.equal(result, null);
  });

  test("removeSshWorkspaceMetadata is a no-op when the workspace is not tracked", async () => {
    await writeStore([
      makeStoredWorkspace({ workspaceId: "keep-me" }),
    ]);

    await removeSshWorkspaceMetadata("ghost");

    const after = await readStore();
    assert.equal(after.workspaces.length, 1);
    assert.equal(after.workspaces[0]?.workspaceId, "keep-me");
  });

  test("removeSshWorkspaceMetadata drops only the matching record and preserves the rest", async () => {
    await writeStore([
      makeStoredWorkspace({ workspaceId: "alpha", target: "a@h", host: "h" }),
      makeStoredWorkspace({ workspaceId: "beta", target: "b@h", host: "h" }),
      makeStoredWorkspace({ workspaceId: "gamma", target: "c@h", host: "h" }),
    ]);

    await removeSshWorkspaceMetadata("beta");

    const after = await readStore();
    const ids = after.workspaces.map((w) => w.workspaceId).sort();
    assert.deepEqual(ids, ["alpha", "gamma"]);
  });
});

describe("workspace-delete cleanup", () => {
  test(
    "removeWorkspace + removeSshWorkspaceMetadata together leave no orphan SSH record",
    async () => {
      // Mirror the path executed by the DELETE /api/workspaces/:id route.
      const workspaceRoot = path.join(TEST_ROOT, "ssh-cleanup-target");
      await mkdir(workspaceRoot, { recursive: true });
      const workspace = await ensureWorkspaceRegistered(
        workspaceRoot,
        "ssh-cleanup-target"
      );

      await writeStore([
        makeStoredWorkspace({
          workspaceId: workspace.id,
          target: "deploy@host",
          user: "deploy",
          host: "host",
          remotePath: "/srv/app",
          localRoot: workspaceRoot,
        }),
        makeStoredWorkspace({ workspaceId: "unrelated", target: "x@y", host: "y" }),
      ]);

      await removeWorkspace(workspace.id);
      await removeSshWorkspaceMetadata(workspace.id);

      const after = await readStore();
      assert.equal(after.workspaces.length, 1);
      assert.equal(after.workspaces[0]?.workspaceId, "unrelated");
      assert.equal(await getSshWorkspaceMetadata(workspace.id), null);
    }
  );
});

describe("pullSshWorkspace / pushSshWorkspace error paths", () => {
  test("pullSshWorkspace rejects when the workspace is not SSH-backed", async () => {
    await assert.rejects(
      pullSshWorkspace("not-ssh-backed"),
      /not SSH-backed/
    );
  });

  test("pushSshWorkspace rejects when the workspace is not SSH-backed", async () => {
    await assert.rejects(
      pushSshWorkspace("not-ssh-backed"),
      /not SSH-backed/
    );
  });

  test(
    "pushSshWorkspace rejects when SSH metadata exists but the workspace record is gone",
    async () => {
      // Seeds an orphan: metadata exists, workspace registry has no matching row.
      await writeStore([
        makeStoredWorkspace({
          workspaceId: "orphaned-workspace-id",
          target: "deploy@host",
          host: "host",
          user: "deploy",
        }),
      ]);

      await assert.rejects(
        pushSshWorkspace("orphaned-workspace-id"),
        /Unknown workspace/
      );
    }
  );
});
