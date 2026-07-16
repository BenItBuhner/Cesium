import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "cesium-standalone-chats-"));
process.env.OPENCURSOR_DATA_DIR = tempDataDir;
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";

const { createStandaloneChatWorkspace, isStandaloneChatWorkspace, removeStandaloneChatWorkspace } =
  await import("../src/lib/standalone-chats.ts");
const { getWorkspaceById, listWorkspaces } = await import("../src/lib/workspace-registry.ts");

describe("standalone chat workspaces", () => {
  after(async () => {
    await rm(tempDataDir, { recursive: true, force: true });
  });

  test("creates a temp-dir workspace marked standalone-chat", async () => {
    const workspace = await createStandaloneChatWorkspace("Scratch");
    assert.equal(workspace.kind, "standalone-chat");
    assert.equal(workspace.name, "Scratch");
    assert.ok(workspace.root.includes(`${path.sep}standalone-chats${path.sep}`));
    assert.equal(isStandaloneChatWorkspace(workspace), true);

    const listed = await listWorkspaces();
    assert.ok(listed.some((item) => item.id === workspace.id && item.kind === "standalone-chat"));

    const fetched = await getWorkspaceById(workspace.id);
    assert.ok(fetched);
    assert.equal(fetched?.kind, "standalone-chat");

    await removeStandaloneChatWorkspace(workspace.id);
    assert.equal(await getWorkspaceById(workspace.id), null);
  });
});
