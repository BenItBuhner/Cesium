import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function dirHasEntries(targetDir) {
  try {
    return readdirSync(targetDir).length > 0;
  } catch {
    return false;
  }
}

function hasProfileData(targetDir) {
  return (
    existsSync(join(targetDir, "profile", "global-settings.json")) ||
    dirHasEntries(join(targetDir, "profile"))
  );
}

function globalSettingsPath(dataDir) {
  return join(dataDir, "profile", "global-settings.json");
}

function profileRichness(dataDir) {
  const settingsPath = globalSettingsPath(dataDir);
  if (!existsSync(settingsPath)) {
    return 0;
  }
  const stats = statSync(settingsPath);
  return stats.size * 1_000_000 + stats.mtimeMs;
}

function migrateDataDir(sourceDir, targetDir) {
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    renameSync(sourceDir, targetDir);
    return;
  } catch {
    // Fall back to copy when rename is blocked by sync tooling or permissions.
  }
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
}

function mergeLegacyDesktopData(legacyDesktopDir, canonicalDir) {
  if (!hasProfileData(legacyDesktopDir)) {
    return;
  }
  if (!hasProfileData(canonicalDir)) {
    migrateDataDir(legacyDesktopDir, canonicalDir);
    return;
  }

  const legacyScore = profileRichness(legacyDesktopDir);
  const canonicalScore = profileRichness(canonicalDir);
  if (legacyScore <= canonicalScore) {
    return;
  }

  mkdirSync(canonicalDir, { recursive: true });
  cpSync(legacyDesktopDir, canonicalDir, { recursive: true, force: true });
}

/**
 * Packaged desktop must use the same persisted profile directory as the dev
 * server (`%LOCALAPPDATA%\\Cesium\\data` on Windows). Older builds wrote to
 * `%APPDATA%\\…\\server-data`, which forked settings like theme/design mode.
 */
export function resolvePackagedDesktopDataDir(userDataPath) {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const canonicalDir = localAppData
    ? resolve(localAppData, "Cesium", "data")
    : resolve(userDataPath, "server-data");
  const legacyDesktopDir = resolve(userDataPath, "server-data");

  if (legacyDesktopDir !== canonicalDir) {
    mergeLegacyDesktopData(legacyDesktopDir, canonicalDir);
  }

  return canonicalDir;
}
