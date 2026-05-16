import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rendererUrl = "http://127.0.0.1:5173";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const desktopRoot = resolve(here, "..");

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: false,
    cwd: repoRoot,
    ...options,
  });
}

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Renderer returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Desktop renderer did not start at ${rendererUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

const renderer = spawnCommand("npm", ["run", "dev", "-w", "apps/desktop-renderer"]);

try {
  await waitForRenderer();
  const electron = spawnCommand("electron", ["."], {
    cwd: desktopRoot,
  });
  electron.on("exit", (code) => {
    renderer.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  renderer.kill();
  console.error(error);
  process.exit(1);
}
