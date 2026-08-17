import type {
  CesiumInstallKind,
  CesiumUpdateChannelId,
  CesiumUpdateGitStatus,
  CesiumUpdateNpmStatus,
  CesiumUpdateRelease,
  CesiumUpdateReleaseAsset,
  CesiumUpdateSelfUpdateMethod,
  CesiumUpdateSettings,
  CesiumUpdateStatusPayload,
} from "./server-api";

/**
 * Defensive normalization for `/api/updates/*` payloads.
 *
 * The update status flows through a JSON state file on the server
 * (`profile/update-state.json`), so a server build with a different release
 * schema — common on self-updating installs such as the Termux on-device
 * server — can hand the client releases missing `assets` or other fields.
 * Rendering then dies with errors like "Cannot read properties of undefined
 * (reading 'length')". Every field the Updates UI dereferences is coerced to
 * its expected shape here; unusable releases are dropped instead of crashing.
 */

const INSTALL_KINDS: readonly CesiumInstallKind[] = [
  "isolated-server",
  "termux-server",
  "desktop-electron",
  "source",
  "unknown",
];

const CHANNEL_IDS: readonly CesiumUpdateChannelId[] = [
  "app",
  "server",
  "desktop",
  "mobile",
];

const SELF_UPDATE_METHODS: readonly CesiumUpdateSelfUpdateMethod[] = [
  "cesium-server-cli",
  "git-pull",
];

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReleaseAsset(value: unknown): CesiumUpdateReleaseAsset | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const downloadUrl = asString(value.downloadUrl);
  if (!name || !downloadUrl) return null;
  return {
    name,
    size: asFiniteNumber(value.size) ?? 0,
    downloadUrl,
    contentType: asString(value.contentType),
  };
}

export function normalizeUpdateRelease(
  value: unknown,
  fallbackChannel: CesiumUpdateChannelId = "app"
): CesiumUpdateRelease | null {
  if (!isRecord(value)) return null;
  const tag = asString(value.tag);
  const version = asString(value.version);
  if (!tag || !version) return null;
  const channel = CHANNEL_IDS.includes(value.channel as CesiumUpdateChannelId)
    ? (value.channel as CesiumUpdateChannelId)
    : fallbackChannel;
  const rawAssets = Array.isArray(value.assets) ? value.assets : [];
  return {
    channel,
    tag,
    version,
    name: asString(value.name),
    prerelease: asBoolean(value.prerelease, false),
    publishedAt: asString(value.publishedAt),
    htmlUrl: asString(value.htmlUrl),
    notes: asString(value.notes),
    assets: rawAssets
      .map(normalizeReleaseAsset)
      .filter((asset): asset is CesiumUpdateReleaseAsset => asset !== null),
  };
}

function normalizeChannels(
  value: unknown
): Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>> {
  if (!isRecord(value)) return {};
  const channels: Partial<Record<CesiumUpdateChannelId, CesiumUpdateRelease>> = {};
  for (const channelId of CHANNEL_IDS) {
    const release = normalizeUpdateRelease(value[channelId], channelId);
    if (release) {
      channels[channelId] = release;
    }
  }
  return channels;
}

function normalizeNpmStatus(value: unknown): CesiumUpdateNpmStatus | null {
  if (!isRecord(value)) return null;
  const packageName = asString(value.packageName);
  if (!packageName) return null;
  return {
    packageName,
    currentVersion: asString(value.currentVersion) ?? "0.0.0",
    latestVersion: asString(value.latestVersion),
    updateAvailable: asBoolean(value.updateAvailable, false),
    error: asString(value.error),
  };
}

function normalizeGitStatus(value: unknown): CesiumUpdateGitStatus | null {
  if (!isRecord(value)) return null;
  return {
    branch: asString(value.branch),
    commit: asString(value.commit),
    remoteCommit: asString(value.remoteCommit),
    behind: asFiniteNumber(value.behind),
    updateAvailable: asBoolean(value.updateAvailable, false),
    error: asString(value.error),
  };
}

function normalizeUpdateSettings(value: unknown): CesiumUpdateSettings {
  const raw = isRecord(value) ? value : {};
  return {
    autoCheck: asBoolean(raw.autoCheck, true),
    includePrereleases: asBoolean(raw.includePrereleases, false),
    dismissedVersion: asString(raw.dismissedVersion),
  };
}

export function normalizeUpdateStatusPayload(
  value: unknown
): CesiumUpdateStatusPayload {
  const raw = isRecord(value) ? value : {};
  const installKind = INSTALL_KINDS.includes(raw.installKind as CesiumInstallKind)
    ? (raw.installKind as CesiumInstallKind)
    : "unknown";
  const primaryChannel = CHANNEL_IDS.includes(
    raw.primaryChannel as CesiumUpdateChannelId
  )
    ? (raw.primaryChannel as CesiumUpdateChannelId)
    : "server";
  const selfUpdateRaw = isRecord(raw.selfUpdate) ? raw.selfUpdate : {};
  return {
    currentVersion: asString(raw.currentVersion) ?? "0.0.0",
    protocolVersion: asString(raw.protocolVersion) ?? "unknown",
    installKind,
    githubRepo: asString(raw.githubRepo) ?? "",
    githubError: asString(raw.githubError),
    primaryChannel,
    updateAvailable: asBoolean(raw.updateAvailable, false),
    latest: normalizeUpdateRelease(raw.latest, primaryChannel),
    channels: normalizeChannels(raw.channels),
    npm: normalizeNpmStatus(raw.npm),
    git: normalizeGitStatus(raw.git),
    selfUpdate: {
      supported: asBoolean(selfUpdateRaw.supported, false),
      method: SELF_UPDATE_METHODS.includes(
        selfUpdateRaw.method as CesiumUpdateSelfUpdateMethod
      )
        ? (selfUpdateRaw.method as CesiumUpdateSelfUpdateMethod)
        : null,
      reason: asString(selfUpdateRaw.reason),
    },
    settings: normalizeUpdateSettings(raw.settings),
    lastCheckedAt: asFiniteNumber(raw.lastCheckedAt),
    applying: asBoolean(raw.applying, false),
  };
}
