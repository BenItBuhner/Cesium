/**
 * Engine side of harness auth sync: exporting and importing the credential
 * material that keeps agent harnesses signed in on this host.
 *
 * Export reads the vendor CLI credential files (or Cesium Agent provider
 * keys) and returns them to the authenticated client, which seals them into
 * an AES-256-GCM `cesium-secret.v1` envelope before uploading to the
 * account vault. Import is the reverse: the client opens the envelope
 * locally and posts the plaintext snapshot here, and this module writes the
 * files back - restricted to the exact allowlisted credential paths, with
 * 0600/0700 modes on POSIX.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_AUTH_MAX_FILE_CHARS,
  HARNESS_AUTH_MAX_FILES,
  HARNESS_AUTH_SYNC_IDS,
  HARNESS_AUTH_SYNC_LABELS,
  isHarnessAuthSyncId,
  normalizeHarnessAuthSnapshot,
  type HarnessAuthSnapshot,
  type HarnessAuthSnapshotFile,
  type HarnessAuthSyncEngineState,
  type HarnessAuthSyncId,
} from "@cesium/core";
import {
  detectHarnessCli,
  harnessHomeDirCandidates,
  type HarnessCliId,
} from "./agents/harness-runtime.js";
import {
  harnessCliAuthBackendIdsForCli,
  harnessCliCredentialRelPaths,
  refreshHarnessCliAuthState,
} from "./harness-cli-auth.js";

export { isHarnessAuthSyncId };
export type { HarnessAuthSnapshot, HarnessAuthSyncEngineState, HarnessAuthSyncId };

/** Sync ids that map onto a vendor harness CLI (everything but Cesium Agent). */
type CliSyncId = Exclude<HarnessAuthSyncId, "cesium-agent">;

const CLI_SYNC_IDS: Record<CliSyncId, HarnessCliId> = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
  devin: "devin",
  "google-antigravity": "google-antigravity",
};

function isCliSyncId(syncId: HarnessAuthSyncId): syncId is CliSyncId {
  return syncId !== "cesium-agent";
}

/**
 * Raw byte budget per credential file. Binary payloads are base64-encoded
 * (4/3 expansion), so the raw cap keeps encoded content under the shared
 * `HARNESS_AUTH_MAX_FILE_CHARS` snapshot limit.
 */
const MAX_RAW_FILE_BYTES = Math.floor((HARNESS_AUTH_MAX_FILE_CHARS * 3) / 4);

/**
 * Detection paths that are host configuration rather than credentials
 * (e.g. `~/.codex/config.toml`). They prove a sign-in happened but must not
 * be copied between machines, so they are excluded from export AND from the
 * import write allowlist.
 */
const NON_SYNCABLE_RELPATHS = new Set([".codex/config.toml"]);

/** Credential paths that are safe to move between hosts for a harness CLI. */
function syncableCredentialRelPaths(cliId: HarnessCliId): string[][] {
  return harnessCliCredentialRelPaths(cliId).filter(
    (segments) => !NON_SYNCABLE_RELPATHS.has(segments.join("/"))
  );
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

/** First existing credential file for `segments`, scanning homes in order. */
function findCredentialFile(segments: string[]): string | null {
  for (const home of harnessHomeDirCandidates()) {
    const candidate = path.join(home, ...segments);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Unreadable path - skip.
    }
  }
  return null;
}

function readCredentialFile(
  segments: string[]
): HarnessAuthSnapshotFile | null {
  const filePath = findCredentialFile(segments);
  if (!filePath) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  if (buffer.length === 0 || buffer.length > MAX_RAW_FILE_BYTES) {
    return null;
  }
  const relPath = segments.join("/");
  if (isProbablyBinary(buffer)) {
    return { relPath, content: buffer.toString("base64"), encoding: "base64" };
  }
  return { relPath, content: buffer.toString("utf8"), encoding: "utf8" };
}

function cliHasCredentials(cliId: HarnessCliId): boolean {
  return syncableCredentialRelPaths(cliId).some(
    (segments) => findCredentialFile(segments) != null
  );
}

async function cesiumAgentProviderKeys(): Promise<
  Array<{
    providerId: string;
    label?: string;
    apiKind: string;
    apiKey: string;
    baseUrl?: string;
  }>
> {
  const { getCesiumAgentSettings } = await import("./cesium-agent-settings.js");
  const settings = await getCesiumAgentSettings();
  return settings.providerKeys.map((key) => ({
    providerId: key.providerId,
    label: key.label,
    apiKind: key.apiKind,
    apiKey: key.apiKey,
    ...(key.baseUrl ? { baseUrl: key.baseUrl } : {}),
  }));
}

/** Per-harness sync readiness for this engine host (no secret material). */
export async function listHarnessAuthSyncStates(): Promise<
  HarnessAuthSyncEngineState[]
> {
  const states: HarnessAuthSyncEngineState[] = [];
  for (const syncId of HARNESS_AUTH_SYNC_IDS) {
    if (isCliSyncId(syncId)) {
      const cliId = CLI_SYNC_IDS[syncId];
      const installed = detectHarnessCli(cliId) != null;
      const hasCredentials = cliHasCredentials(cliId);
      states.push({
        syncId,
        label: HARNESS_AUTH_SYNC_LABELS[syncId],
        installed,
        signedIn: hasCredentials,
        exportable: hasCredentials,
      });
      continue;
    }
    const keys = await cesiumAgentProviderKeys().catch(() => []);
    states.push({
      syncId,
      label: HARNESS_AUTH_SYNC_LABELS[syncId],
      installed: true,
      signedIn: keys.length > 0,
      exportable: keys.length > 0,
    });
  }
  return states;
}

/**
 * Capture this host's credential material for one harness. Returns `null`
 * when nothing is available to export.
 */
export async function exportHarnessAuthSnapshotForSync(
  syncId: HarnessAuthSyncId
): Promise<HarnessAuthSnapshot | null> {
  const sourceLabel = os.hostname() || undefined;
  if (!isCliSyncId(syncId)) {
    const keys = await cesiumAgentProviderKeys();
    if (keys.length === 0) {
      return null;
    }
    return normalizeHarnessAuthSnapshot({
      version: 1,
      syncId,
      kind: "provider-keys",
      providerKeysJson: JSON.stringify(keys),
      capturedAt: Date.now(),
      ...(sourceLabel ? { sourceLabel } : {}),
    });
  }
  const cliId = CLI_SYNC_IDS[syncId];
  const files: HarnessAuthSnapshotFile[] = [];
  for (const segments of syncableCredentialRelPaths(cliId)) {
    if (files.length >= HARNESS_AUTH_MAX_FILES) {
      break;
    }
    const file = readCredentialFile(segments);
    if (file) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    return null;
  }
  return normalizeHarnessAuthSnapshot({
    version: 1,
    syncId,
    kind: "cli-files",
    files,
    capturedAt: Date.now(),
    ...(sourceLabel ? { sourceLabel } : {}),
  });
}

function primaryHomeDir(): string {
  const home = harnessHomeDirCandidates()[0];
  if (!home) {
    throw new Error("No home directory available for credential import.");
  }
  return home;
}

function writeCredentialFile(home: string, file: HarnessAuthSnapshotFile): void {
  const segments = file.relPath.split("/");
  const target = path.join(home, ...segments);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data =
    file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8");
  writeFileSync(target, data, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(target, 0o600);
    } catch {
      // Best effort - the file was still written with a restrictive umask.
    }
  }
}

export type HarnessAuthImportResult = {
  applied: number;
  errors: string[];
};

function isCesiumProviderKind(
  value: unknown
): value is import("./cesium-agent-settings.js").CesiumProviderKind {
  return (
    value === "openai-chat-completions" ||
    value === "openai-responses" ||
    value === "openai-realtime" ||
    value === "anthropic" ||
    value === "google-genai" ||
    value === "openai-compatible"
  );
}

async function importCesiumProviderKeys(
  snapshot: HarnessAuthSnapshot
): Promise<HarnessAuthImportResult> {
  const { upsertCesiumProviderKey } = await import("./cesium-agent-settings.js");
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.providerKeysJson ?? "");
  } catch {
    throw new Error("Provider key payload is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Provider key payload is empty.");
  }
  const result: HarnessAuthImportResult = { applied: 0, errors: [] };
  for (const raw of parsed.slice(0, 50)) {
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const providerId =
      typeof record?.providerId === "string" ? record.providerId.trim() : "";
    const apiKey = typeof record?.apiKey === "string" ? record.apiKey.trim() : "";
    const apiKind = record?.apiKind;
    if (!providerId || !apiKey || !isCesiumProviderKind(apiKind)) {
      result.errors.push("Skipped a malformed provider key entry.");
      continue;
    }
    try {
      await upsertCesiumProviderKey({
        providerId,
        apiKind,
        apiKey,
        ...(typeof record?.label === "string" && record.label.trim()
          ? { label: record.label.trim() }
          : {}),
        ...(typeof record?.baseUrl === "string" && record.baseUrl.trim()
          ? { baseUrl: record.baseUrl.trim() }
          : {}),
      });
      result.applied += 1;
    } catch (error) {
      result.errors.push(
        `${providerId}: ${error instanceof Error ? error.message : "import failed"}`
      );
    }
  }
  return result;
}

/**
 * Apply a snapshot to this host. CLI credential files are only ever written
 * to the exact allowlisted home-relative paths for the harness; anything
 * else in the payload is rejected outright.
 */
export async function importHarnessAuthSnapshotForSync(
  syncId: HarnessAuthSyncId,
  rawSnapshot: unknown
): Promise<HarnessAuthImportResult> {
  const snapshot = normalizeHarnessAuthSnapshot(rawSnapshot, syncId);
  if (!snapshot) {
    throw new Error("Invalid or oversized harness auth snapshot.");
  }
  if (snapshot.kind === "provider-keys") {
    return await importCesiumProviderKeys(snapshot);
  }
  const cliId = CLI_SYNC_IDS[snapshot.syncId as CliSyncId];
  const allowed = new Set(
    syncableCredentialRelPaths(cliId).map((segments) => segments.join("/"))
  );
  const files = snapshot.files ?? [];
  for (const file of files) {
    if (!allowed.has(file.relPath)) {
      throw new Error(
        `Refusing to write non-allowlisted credential path: ${file.relPath}`
      );
    }
  }
  const home = primaryHomeDir();
  const result: HarnessAuthImportResult = { applied: 0, errors: [] };
  for (const file of files) {
    try {
      writeCredentialFile(home, file);
      result.applied += 1;
    } catch (error) {
      result.errors.push(
        `${file.relPath}: ${error instanceof Error ? error.message : "write failed"}`
      );
    }
  }
  if (result.applied > 0) {
    // Refresh cached sign-in state so Settings reflects the import at once.
    for (const backendId of harnessCliAuthBackendIdsForCli(cliId)) {
      void refreshHarnessCliAuthState(backendId).catch(() => undefined);
    }
  }
  return result;
}
