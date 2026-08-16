import path from "node:path";
import type {
  CesiumInstallKind,
  CesiumUpdateChannelId,
  CesiumUpdateGitStatus,
  CesiumUpdateNpmStatus,
  CesiumUpdateRelease,
  CesiumUpdateSelfUpdateMethod,
  CesiumUpdateSettings,
  CesiumUpdateStatusPayload,
} from "@cesium/contracts";
import { CESIUM_PROTOCOL_VERSION } from "@cesium/contracts";
import {
  DATA_DIR,
  readJsonFile,
  resolveRepoRootFromProcessCwd,
  writeJsonFile,
} from "../persistence.js";
import { resolveCurrentVersion } from "./app-version.js";
import { detectInstallKind } from "./install-kind.js";
import {
  fetchGithubReleases,
  fetchGitUpdateStatus,
  fetchNpmLatestVersion,
  isNpmUpdateAvailable,
  resolveGithubRepo,
  resolveGithubToken,
  resolveNpmPackage,
} from "./feeds.js";
import { isNewerVersion } from "./semver.js";

const STATE_FILE = path.join(DATA_DIR, "profile", "update-state.json");
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_CHECK_STARTUP_DELAY_MS = 15_000;

export const DEFAULT_UPDATE_SETTINGS: CesiumUpdateSettings = {
  autoCheck: true,
  includePrereleases: false,
  dismissedVersion: null,
};

type PersistedUpdateState = {
  schemaVersion: 1;
  settings: CesiumUpdateSettings;
  lastCheckedAt: number | null;
  channels: Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>>;
  githubError: string | null;
  npm: CesiumUpdateNpmStatus | null;
  git: CesiumUpdateGitStatus | null;
};

const DEFAULT_STATE: PersistedUpdateState = {
  schemaVersion: 1,
  settings: DEFAULT_UPDATE_SETTINGS,
  lastCheckedAt: null,
  channels: {},
  githubError: null,
  npm: null,
  git: null,
};

let cachedState: PersistedUpdateState | null = null;
let applyInFlight = false;
let checkInFlight: Promise<PersistedUpdateState> | null = null;
let autoCheckTimer: ReturnType<typeof setInterval> | null = null;

async function loadState(): Promise<PersistedUpdateState> {
  if (cachedState) return cachedState;
  const raw = await readJsonFile<Partial<PersistedUpdateState>>(STATE_FILE, {});
  cachedState = {
    ...DEFAULT_STATE,
    ...raw,
    settings: { ...DEFAULT_UPDATE_SETTINGS, ...(raw.settings ?? {}) },
  };
  return cachedState;
}

async function saveState(state: PersistedUpdateState): Promise<void> {
  cachedState = state;
  await writeJsonFile(STATE_FILE, state);
}

export function isUpdateApplyInFlight(): boolean {
  return applyInFlight;
}

export function setUpdateApplyInFlight(value: boolean): void {
  applyInFlight = value;
}

/** Which release channel this installation should treat as its own. */
export function primaryChannelForInstallKind(
  kind: CesiumInstallKind
): CesiumUpdateChannelId {
  switch (kind) {
    case "desktop-electron":
      return "desktop";
    default:
      return "server";
  }
}

/**
 * Channel fallback: dedicated per-surface tags (`server-v*`, `desktop-v*`)
 * win, but a unified `v*` app release covers every surface that has no
 * dedicated tag yet.
 */
export function resolveLatestForChannel(
  channels: Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>>,
  primary: CesiumUpdateChannelId
): CesiumUpdateRelease | null {
  const dedicated = channels[primary] ?? null;
  if (primary === "app" || primary === "mobile") return dedicated;
  const unified = channels.app ?? null;
  if (!dedicated) return unified;
  if (!unified) return dedicated;
  return isNewerVersion(unified.version, dedicated.version) ? unified : dedicated;
}

export function resolveSelfUpdateSupport(kind: CesiumInstallKind): {
  supported: boolean;
  method: CesiumUpdateSelfUpdateMethod | null;
  reason: string | null;
} {
  switch (kind) {
    case "isolated-server":
    case "termux-server":
      return { supported: true, method: "cesium-server-cli", reason: null };
    case "source":
      return { supported: true, method: "git-pull", reason: null };
    case "desktop-electron":
      return {
        supported: false,
        method: null,
        reason:
          "The desktop app updates by installing a new build — download it from the release below.",
      };
    default:
      return {
        supported: false,
        method: null,
        reason: "This installation type has no automated update path.",
      };
  }
}

async function runNetworkCheck(): Promise<PersistedUpdateState> {
  const previous = await loadState();
  const settings = previous.settings;
  const repo = resolveGithubRepo();
  const github = await fetchGithubReleases({
    repo,
    token: resolveGithubToken(),
    includePrereleases: settings.includePrereleases,
  });

  let npm: CesiumUpdateNpmStatus | null = null;
  const npmPackage = resolveNpmPackage();
  if (npmPackage) {
    const currentVersion = resolveCurrentVersion();
    const result = await fetchNpmLatestVersion({ packageName: npmPackage });
    npm = {
      packageName: npmPackage,
      currentVersion,
      latestVersion: result.latestVersion,
      updateAvailable: isNpmUpdateAvailable(result.latestVersion, currentVersion),
      error: result.error,
    };
  }

  const installKind = detectInstallKind();
  let git: CesiumUpdateGitStatus | null = null;
  if (
    installKind === "source" ||
    installKind === "isolated-server" ||
    installKind === "termux-server"
  ) {
    git = await fetchGitUpdateStatus(resolveRepoRootFromProcessCwd());
  }

  const next: PersistedUpdateState = {
    ...previous,
    lastCheckedAt: Date.now(),
    channels: github.channels,
    githubError: github.error,
    npm,
    git,
  };
  await saveState(next);
  return next;
}

/** Run one update check, deduplicating concurrent callers onto one fetch. */
export async function checkForUpdates(): Promise<CesiumUpdateStatusPayload> {
  if (!checkInFlight) {
    checkInFlight = runNetworkCheck().finally(() => {
      checkInFlight = null;
    });
  }
  const state = await checkInFlight;
  return buildStatusPayload(state);
}

export async function getUpdateStatus(): Promise<CesiumUpdateStatusPayload> {
  const state = await loadState();
  return buildStatusPayload(state);
}

export async function updateUpdateSettings(
  patch: Partial<CesiumUpdateSettings>
): Promise<CesiumUpdateStatusPayload> {
  const state = await loadState();
  const prereleaseFlagChanged =
    patch.includePrereleases !== undefined &&
    patch.includePrereleases !== state.settings.includePrereleases;
  const next: PersistedUpdateState = {
    ...state,
    settings: {
      autoCheck: patch.autoCheck ?? state.settings.autoCheck,
      includePrereleases: patch.includePrereleases ?? state.settings.includePrereleases,
      dismissedVersion:
        patch.dismissedVersion !== undefined
          ? patch.dismissedVersion
          : state.settings.dismissedVersion,
    },
  };
  await saveState(next);
  // Prerelease visibility changes what the cached channels should contain.
  if (prereleaseFlagChanged) {
    return checkForUpdates();
  }
  return buildStatusPayload(next);
}

function buildStatusPayload(state: PersistedUpdateState): CesiumUpdateStatusPayload {
  const installKind = detectInstallKind();
  const currentVersion = resolveCurrentVersion();
  const primaryChannel = primaryChannelForInstallKind(installKind);
  const latest = resolveLatestForChannel(state.channels, primaryChannel);
  const releaseUpdateAvailable = Boolean(
    latest &&
      isNewerVersion(latest.version, currentVersion) &&
      latest.version !== state.settings.dismissedVersion
  );
  const gitUpdateAvailable = Boolean(state.git?.updateAvailable);
  // A dismissed version silences every feed that reports it, npm included.
  const npmUpdateAvailable = Boolean(
    state.npm?.updateAvailable &&
      state.npm.latestVersion !== state.settings.dismissedVersion
  );
  return {
    currentVersion,
    protocolVersion: CESIUM_PROTOCOL_VERSION,
    installKind,
    githubRepo: resolveGithubRepo(),
    githubError: state.githubError,
    primaryChannel,
    updateAvailable: releaseUpdateAvailable || gitUpdateAvailable || npmUpdateAvailable,
    latest,
    channels: state.channels,
    npm: state.npm,
    git: state.git,
    selfUpdate: resolveSelfUpdateSupport(installKind),
    settings: state.settings,
    lastCheckedAt: state.lastCheckedAt,
    applying: applyInFlight,
  };
}

/**
 * Periodic background check. Started from `startCesiumBackgroundServices`;
 * every run re-reads the persisted `autoCheck` flag so toggling it off in
 * Settings stops network traffic without a restart.
 */
export function startUpdateAutoCheck(): void {
  if (autoCheckTimer || process.env.NODE_ENV === "test") {
    return;
  }
  const runIfEnabled = async () => {
    try {
      const state = await loadState();
      if (!state.settings.autoCheck) return;
      await checkForUpdates();
    } catch (error) {
      console.warn("[updates] background check failed:", error);
    }
  };
  setTimeout(() => void runIfEnabled(), AUTO_CHECK_STARTUP_DELAY_MS).unref?.();
  autoCheckTimer = setInterval(() => void runIfEnabled(), AUTO_CHECK_INTERVAL_MS);
  autoCheckTimer.unref?.();
}

/** Test hook: forget cached state so a fresh OPENCURSOR_DATA_DIR is honored. */
export function resetUpdateStateCacheForTests(): void {
  cachedState = null;
  applyInFlight = false;
  checkInFlight = null;
}
