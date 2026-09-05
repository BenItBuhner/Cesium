import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDataDir = await mkdtemp(path.join(os.tmpdir(), "cesium-fswatch-data-"));
const tempWorkspaceRoot = await mkdtemp(path.join(os.tmpdir(), "cesium-fswatch-root-"));
process.env.OPENCURSOR_DATA_DIR = tempDataDir;
process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT = "1";
delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;

const { ensureWorkspaceRegistered } = await import("../src/lib/workspace-registry.ts");
const { attachFsSocket } = await import("../src/ws/filewatcher.ts");
type RuntimeSocket = import("../src/ws/runtime-socket.ts").RuntimeSocket;

type FsFrame = { type: string; path?: string; seq?: number };

function createFakeSocket(): { socket: RuntimeSocket; frames: FsFrame[]; close: () => void } {
  const frames: FsFrame[] = [];
  const closeHandlers: Array<() => void> = [];
  let open = true;
  const socket: RuntimeSocket = {
    get isOpen() {
      return open;
    },
    send(data) {
      frames.push(JSON.parse(String(data)) as FsFrame);
    },
    close() {
      open = false;
      for (const handler of closeHandlers) handler();
    },
    onMessage() {},
    onClose(handler) {
      closeHandlers.push(handler);
    },
    onError() {},
  };
  return { socket, frames, close: () => socket.close() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

after(async () => {
  await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  await rm(tempWorkspaceRoot, { recursive: true, force: true }).catch(() => {});
});

test("workspace watcher emits root-level changes and stays quiet inside dimmed folders", async () => {
  await mkdir(path.join(tempWorkspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(tempWorkspaceRoot, "packages", "lib", "node_modules", "dep"), {
    recursive: true,
  });
  const workspace = await ensureWorkspaceRegistered(tempWorkspaceRoot, "watch");
  const { socket, frames, close } = createFakeSocket();
  await attachFsSocket(socket, workspace.id, 0);
  await waitFor(() => frames.some((frame) => frame.type === "ready"));
  assert.ok(frames.some((frame) => frame.type === "workspace_snapshot"));
  // `ready` marks the room, not chokidar's initial scan; a file written while
  // the scan is still running is (correctly) swallowed by ignoreInitial.
  await new Promise((resolve) => setTimeout(resolve, 750));

  // The watcher used to ignore its own root (relative path "" was treated as
  // ignored), so no event ever fired. A real root-level change must arrive.
  await writeFile(path.join(tempWorkspaceRoot, "src", "hello.ts"), "export const x = 1;\n");
  await waitFor(() => frames.some((frame) => frame.type === "add" && frame.path === "src/hello.ts"));
  assert.ok(
    frames.some((frame) => frame.type === "add" && frame.path === "src/hello.ts"),
    `expected an add event for src/hello.ts, got ${JSON.stringify(frames)}`
  );

  // Nested dimmed folders are leaves for the explorer and search; the watcher
  // must not track (or announce) anything inside them.
  await writeFile(
    path.join(tempWorkspaceRoot, "packages", "lib", "node_modules", "dep", "index.js"),
    "module.exports = 1;\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    frames.some((frame) => typeof frame.path === "string" && frame.path.includes("node_modules")),
    false,
    `unexpected event inside node_modules: ${JSON.stringify(frames)}`
  );

  close();
});
