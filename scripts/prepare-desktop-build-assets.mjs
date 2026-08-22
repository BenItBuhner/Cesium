import { copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stages the gitignored `apps/desktop/build/` assets electron-builder needs
 * (window/tray icon, NSIS license text) from committed sources, so packaging
 * works on a fresh checkout — including CI runners. Existing files are kept:
 * a developer can drop in hand-tuned icons and they win.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repoRoot, "apps", "desktop", "build");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function stage(source, target) {
  if (await exists(target)) {
    console.log(`Keeping existing ${path.relative(repoRoot, target)}`);
    return;
  }
  if (!(await exists(source))) {
    throw new Error(`Missing source asset: ${path.relative(repoRoot, source)}`);
  }
  await copyFile(source, target);
  console.log(
    `Staged ${path.relative(repoRoot, target)} from ${path.relative(repoRoot, source)}`
  );
}

await mkdir(buildDir, { recursive: true });
// 512px PNG doubles as the electron-builder macOS/Linux icon source
// (electron-builder converts it to .icns when packaging for mac).
await stage(
  path.join(repoRoot, "public", "icons", "icon-512.png"),
  path.join(buildDir, "icon.png")
);
await stage(path.join(repoRoot, "public", "favicon.ico"), path.join(buildDir, "icon.ico"));
await stage(path.join(repoRoot, "LICENSE"), path.join(buildDir, "terms.txt"));
console.log("Desktop build assets ready.");
