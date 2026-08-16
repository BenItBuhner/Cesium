import fs from "node:fs";
import path from "node:path";
import { resolveRepoRootFromProcessCwd } from "../persistence.js";

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

let cachedVersion: string | null = null;

/**
 * Version of the running server build. Resolution order:
 * 1. `CESIUM_APP_VERSION` env (packaged builds where package.json is absent)
 * 2. `server/package.json` (`cesium-server`)
 * 3. repo-root `package.json` (`cesium`)
 */
export function resolveCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  const fromEnv = process.env.CESIUM_APP_VERSION?.trim();
  if (fromEnv) {
    cachedVersion = fromEnv;
    return cachedVersion;
  }
  const repoRoot = resolveRepoRootFromProcessCwd();
  const candidates = [
    path.join(repoRoot, "server", "package.json"),
    path.join(repoRoot, "package.json"),
  ];
  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version) {
      cachedVersion = version;
      return cachedVersion;
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/** Test hook: drop the memoized version so env overrides can be re-read. */
export function resetCurrentVersionCacheForTests(): void {
  cachedVersion = null;
}
