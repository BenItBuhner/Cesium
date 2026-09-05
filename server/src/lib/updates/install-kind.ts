import fs from "node:fs";
import path from "node:path";
import type { CesiumInstallKind } from "@cesium/contracts";
import { resolveRepoRootFromProcessCwd } from "../persistence.js";

const VALID_KINDS: CesiumInstallKind[] = [
  "isolated-server",
  "termux-server",
  "desktop-electron",
  "source",
  "unknown",
];

export type InstallKindEnv = Record<string, string | undefined>;

function isTermuxEnvironment(env: InstallKindEnv): boolean {
  if (env.TERMUX_VERSION?.trim()) return true;
  const prefix = env.PREFIX?.trim() ?? "";
  return prefix.startsWith("/data/data/com.termux");
}

/**
 * Detect how this server instance was installed. The kind decides which
 * self-update strategy `/api/updates/apply` is allowed to run:
 *
 * - `desktop-electron` - sidecar spawned by the Cesium desktop app
 *   (`OPENCURSOR_DESKTOP_BACKEND=1`). Updates ship as new installers.
 * - `isolated-server` / `termux-server` - provisioned by
 *   `scripts/install-cesium-server.sh` (marked by `CESIUM_HOME` from
 *   `server.env`); self-update re-runs the installer via the manager CLI.
 * - `source` - running from a git checkout; self-update fast-forwards the
 *   working tree.
 */
export function detectInstallKind(
  env: InstallKindEnv = process.env,
  repoRoot: string = resolveRepoRootFromProcessCwd()
): CesiumInstallKind {
  const override = env.CESIUM_INSTALL_KIND?.trim() as CesiumInstallKind | undefined;
  if (override && VALID_KINDS.includes(override)) {
    return override;
  }
  if (env.OPENCURSOR_DESKTOP_BACKEND === "1") {
    return "desktop-electron";
  }
  if (env.CESIUM_HOME?.trim()) {
    return isTermuxEnvironment(env) ? "termux-server" : "isolated-server";
  }
  try {
    if (fs.existsSync(path.join(repoRoot, ".git"))) {
      return "source";
    }
  } catch {
    // fall through to unknown
  }
  return "unknown";
}
