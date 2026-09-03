/**
 * Cross-device sync of agent harness sign-ins ("harness auth sync").
 *
 * A snapshot captures the credential material one harness needs to be signed
 * in on an engine host: either the vendor CLI's credential files (Codex,
 * Claude, Cursor, Grok, OpenCode, Devin, Google's Antigravity ACP server) or the Cesium Agent
 * provider API keys. Snapshots are sealed client-side into
 * `cesium-secret.v1` AES-256-GCM envelopes (see `secret-envelope.ts`) before
 * they ever leave the device, and stored in the account secret vault under
 * `harness.auth.<syncId>` kinds. Cloud storage only ever sees ciphertext;
 * the material is used solely to hand sign-ins to the user's other devices
 * when they explicitly ask for it.
 */

export const HARNESS_AUTH_SYNC_IDS = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "grok",
  "devin",
  "google-antigravity-acp",
  "cesium-agent",
] as const;

export type HarnessAuthSyncId = (typeof HARNESS_AUTH_SYNC_IDS)[number];

export const HARNESS_AUTH_SYNC_LABELS: Record<HarnessAuthSyncId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  devin: "Devin",
  "google-antigravity-acp": "Google Antigravity",
  "cesium-agent": "Cesium Agent API keys",
};

export function isHarnessAuthSyncId(value: unknown): value is HarnessAuthSyncId {
  return (
    typeof value === "string" &&
    (HARNESS_AUTH_SYNC_IDS as readonly string[]).includes(value)
  );
}

/** Cloud secret vault kind prefix; full kind is `harness.auth.<syncId>`. */
export const HARNESS_AUTH_CLOUD_KIND_PREFIX = "harness.auth.";

export function harnessAuthCloudKind(syncId: HarnessAuthSyncId): string {
  return `${HARNESS_AUTH_CLOUD_KIND_PREFIX}${syncId}`;
}

export function parseHarnessAuthCloudKind(kind: string): HarnessAuthSyncId | null {
  if (!kind.startsWith(HARNESS_AUTH_CLOUD_KIND_PREFIX)) {
    return null;
  }
  const syncId = kind.slice(HARNESS_AUTH_CLOUD_KIND_PREFIX.length);
  return isHarnessAuthSyncId(syncId) ? syncId : null;
}

/** AES-GCM AAD purpose binding: a sealed snapshot only opens for its harness. */
export function harnessAuthSealPurpose(syncId: HarnessAuthSyncId): string {
  return `harness.auth.${syncId}`;
}

/**
 * Agent backend ids that share a syncable sign-in, keyed by the sync unit.
 * Transports of the same vendor CLI (e.g. both Codex backends) map to one
 * sync id because they share credential files on disk.
 */
const BACKEND_SYNC_IDS: Record<string, HarnessAuthSyncId> = {
  "codex-app-server": "codex",
  "codex-acp": "codex",
  "claude-code-sdk": "claude",
  "cursor-acp": "cursor",
  "opencode-server": "opencode",
  "grok-build": "grok",
  "devin-acp": "devin",
  "google-antigravity-acp": "google-antigravity-acp",
  "cesium-agent": "cesium-agent",
};

/** The sync unit for an agent backend, or `null` when it has none. */
export function harnessAuthSyncIdForBackend(
  backendId: string
): HarnessAuthSyncId | null {
  return BACKEND_SYNC_IDS[backendId] ?? null;
}

/** Per-file plaintext cap. Codex `auth.json` carries JWTs (~10 KB); 64 KB is generous. */
export const HARNESS_AUTH_MAX_FILE_CHARS = 64_000;
/** Max credential files per snapshot (allowlisted paths only; specs list ≤ 3). */
export const HARNESS_AUTH_MAX_FILES = 8;
/** Cap on the serialized snapshot JSON before sealing. */
export const HARNESS_AUTH_MAX_SNAPSHOT_CHARS = 120_000;

export type HarnessAuthSnapshotFile = {
  /** Home-relative POSIX path, e.g. `.codex/auth.json`. Never absolute. */
  relPath: string;
  /** File contents; base64 when `encoding` is `base64`, else UTF-8 text. */
  content: string;
  encoding: "utf8" | "base64";
};

export type HarnessAuthSnapshot = {
  version: 1;
  syncId: HarnessAuthSyncId;
  /** `cli-files` = vendor CLI credential files; `provider-keys` = Cesium Agent keys. */
  kind: "cli-files" | "provider-keys";
  files?: HarnessAuthSnapshotFile[];
  /** Opaque provider-key JSON (engine validates shape on import). */
  providerKeysJson?: string;
  capturedAt: number;
  /** Human label of the machine that captured the snapshot (hostname). */
  sourceLabel?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * True when `relPath` is a safe home-relative path: non-empty POSIX
 * segments, no traversal, no absolute/drive/backslash forms.
 */
export function isSafeHarnessAuthRelPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 256) {
    return false;
  }
  if (relPath.includes("\\") || relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath)) {
    return false;
  }
  const segments = relPath.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function normalizeSnapshotFile(raw: unknown): HarnessAuthSnapshotFile | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const relPath = record.relPath;
  const content = record.content;
  const encoding = record.encoding === "base64" ? "base64" : "utf8";
  if (typeof relPath !== "string" || !isSafeHarnessAuthRelPath(relPath)) {
    return null;
  }
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.length > HARNESS_AUTH_MAX_FILE_CHARS
  ) {
    return null;
  }
  return { relPath, content, encoding };
}

/**
 * Validate an untrusted snapshot payload (e.g. freshly opened from a cloud
 * envelope, or posted to an engine import endpoint). Returns `null` when the
 * payload is malformed, oversized, or inconsistent with its `syncId`.
 */
export function normalizeHarnessAuthSnapshot(
  raw: unknown,
  expectedSyncId?: HarnessAuthSyncId
): HarnessAuthSnapshot | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1 || !isHarnessAuthSyncId(record.syncId)) {
    return null;
  }
  if (expectedSyncId && record.syncId !== expectedSyncId) {
    return null;
  }
  const capturedAt =
    typeof record.capturedAt === "number" && Number.isFinite(record.capturedAt)
      ? record.capturedAt
      : 0;
  const sourceLabel =
    typeof record.sourceLabel === "string" && record.sourceLabel.trim()
      ? record.sourceLabel.trim().slice(0, 120)
      : undefined;

  if (record.kind === "provider-keys") {
    if (record.syncId !== "cesium-agent") {
      return null;
    }
    const providerKeysJson = record.providerKeysJson;
    if (
      typeof providerKeysJson !== "string" ||
      providerKeysJson.length === 0 ||
      providerKeysJson.length > HARNESS_AUTH_MAX_SNAPSHOT_CHARS
    ) {
      return null;
    }
    return {
      version: 1,
      syncId: record.syncId,
      kind: "provider-keys",
      providerKeysJson,
      capturedAt,
      ...(sourceLabel ? { sourceLabel } : {}),
    };
  }

  if (record.kind !== "cli-files" || record.syncId === "cesium-agent") {
    return null;
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    return null;
  }
  if (record.files.length > HARNESS_AUTH_MAX_FILES) {
    return null;
  }
  const files: HarnessAuthSnapshotFile[] = [];
  const seen = new Set<string>();
  for (const rawFile of record.files) {
    const file = normalizeSnapshotFile(rawFile);
    if (!file || seen.has(file.relPath)) {
      return null;
    }
    seen.add(file.relPath);
    files.push(file);
  }
  const snapshot: HarnessAuthSnapshot = {
    version: 1,
    syncId: record.syncId,
    kind: "cli-files",
    files,
    capturedAt,
    ...(sourceLabel ? { sourceLabel } : {}),
  };
  if (JSON.stringify(snapshot).length > HARNESS_AUTH_MAX_SNAPSHOT_CHARS) {
    return null;
  }
  return snapshot;
}

/** Public per-harness sync status an engine reports (no secret material). */
export type HarnessAuthSyncEngineState = {
  syncId: HarnessAuthSyncId;
  label: string;
  /** CLI (or Cesium Agent settings) present on the engine host. */
  installed: boolean;
  /** Credential material present on the engine host (file/key detected). */
  signedIn: boolean;
  /** Engine can currently produce a snapshot for this harness. */
  exportable: boolean;
};
