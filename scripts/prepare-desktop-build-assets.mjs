import { copyFile, mkdir, access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_PNG_SIZES, assertValidDesktopIco } from "./desktop-icons.mjs";

/**
 * Stages the gitignored `apps/desktop/build/` assets electron-builder needs
 * (window/tray icon, NSIS installer icon, Linux icon pyramid) from committed
 * `public/desktop/` sources. Files are overwritten on every run so a leftover
 * Electron ICO cannot stick. Set CESIUM_KEEP_DESKTOP_BUILD_ASSETS=1 to keep
 * hand-tuned files already in build/.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repoRoot, "apps", "desktop", "build");
const keepExisting = process.env.CESIUM_KEEP_DESKTOP_BUILD_ASSETS === "1";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function stage(source, target) {
  if (keepExisting && (await exists(target))) {
    console.log(`Keeping existing ${path.relative(repoRoot, target)}`);
    return;
  }
  if (!(await exists(source))) {
    throw new Error(`Missing source asset: ${path.relative(repoRoot, source)}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(
    `Staged ${path.relative(repoRoot, target)} from ${path.relative(repoRoot, source)}`
  );
}

const desktopDir = path.join(repoRoot, "public", "desktop");
await mkdir(buildDir, { recursive: true });
await mkdir(path.join(buildDir, "icons"), { recursive: true });

await stage(path.join(desktopDir, "icon.png"), path.join(buildDir, "icon.png"));
await stage(path.join(desktopDir, "icon.ico"), path.join(buildDir, "icon.ico"));
await stage(path.join(desktopDir, "icon.ico"), path.join(buildDir, "installerIcon.ico"));

for (const size of LINUX_PNG_SIZES) {
  await stage(
    path.join(desktopDir, `${size}x${size}.png`),
    path.join(buildDir, "icons", `${size}x${size}.png`)
  );
}

const ico = await readFile(path.join(buildDir, "icon.ico"));
assertValidDesktopIco(ico, "apps/desktop/build/icon.ico");
console.log("Desktop build assets ready.");
