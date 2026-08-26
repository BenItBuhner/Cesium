import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_INSTALLER = path.resolve(CLI_ROOT, "../../scripts/install-cesium-server.sh");

export function cesiumHome() {
  return process.env.CESIUM_HOME?.trim() || path.join(homedir(), ".cesium");
}

export function managerPath(home = cesiumHome()) {
  return path.join(home, "bin", "cesium-server");
}

export function envFilePath(home = cesiumHome()) {
  return path.join(home, "server.env");
}

export function bundledInstallerPath() {
  const override = process.env.CESIUM_INSTALLER?.trim();
  if (override) {
    return override;
  }
  if (existsSync(REPO_INSTALLER)) {
    return REPO_INSTALLER;
  }
  return null;
}

export function resolveExistingSource(value) {
  return path.resolve(value);
}
