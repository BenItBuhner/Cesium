import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const source = resolve(repoRoot, "apps/desktop-renderer/dist");
const target = resolve(import.meta.dirname, "../android/app/src/main/assets/workbench");

async function ensureBuiltSource() {
  try {
    if ((await stat(source)).isDirectory()) return;
  } catch {
    // Fall through to the actionable error.
  }
  throw new Error(
    `Missing Vite workbench bundle at ${source}. Run ` +
      `"npm run build --workspace @cesium/desktop-renderer" first.`
  );
}

await ensureBuiltSource();
await rm(target, { force: true, recursive: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Copied Cesium web workbench to ${target}`);
