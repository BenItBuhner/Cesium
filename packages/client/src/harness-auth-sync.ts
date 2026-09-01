/**
 * Client side of harness auth sync.
 *
 * Snapshots exported by an engine are sealed here - on the device, with the
 * account's wrapping key - into `cesium-secret.v1` AES-256-GCM envelopes
 * before they are uploaded to the account secret vault. The vault only ever
 * stores ciphertext; only clients holding the account wrapping key (i.e.
 * the user's signed-in devices) can open a snapshot again, and the material
 * is used solely to hand sign-ins to another engine when the user asks.
 */
import {
  harnessAuthCloudKind,
  harnessAuthSealPurpose,
  isHarnessAuthSyncId,
  normalizeHarnessAuthSnapshot,
  parseHarnessAuthCloudKind,
  type HarnessAuthSnapshot,
  type HarnessAuthSyncEngineState,
  type HarnessAuthSyncId,
} from "@cesium/core";
import { clientKeyValueStore, getClientPlatform } from "./platform";
import { openCredential, sealCredential } from "./secret-wrapping-key";

export {
  harnessAuthCloudKind,
  isHarnessAuthSyncId,
  parseHarnessAuthCloudKind,
};
export type { HarnessAuthSnapshot, HarnessAuthSyncEngineState, HarnessAuthSyncId };

/** Seal a plaintext snapshot for cloud upload (purpose-bound per harness). */
export async function sealHarnessAuthSnapshot(
  snapshot: HarnessAuthSnapshot
): Promise<string> {
  return sealCredential(
    JSON.stringify(snapshot),
    harnessAuthSealPurpose(snapshot.syncId)
  );
}

/**
 * Open a sealed cloud payload back into a validated snapshot. Returns
 * `null` when the envelope cannot be opened with the local wrapping key or
 * the decrypted payload fails validation.
 */
export async function openHarnessAuthSnapshot(
  payload: string,
  syncId: HarnessAuthSyncId
): Promise<HarnessAuthSnapshot | null> {
  const opened = await openCredential(payload, harnessAuthSealPurpose(syncId));
  if (!opened) {
    return null;
  }
  try {
    return normalizeHarnessAuthSnapshot(JSON.parse(opened), syncId);
  } catch {
    return null;
  }
}

/** Metadata about a sealed cloud record (safe to show - no secret material). */
export type HarnessAuthCloudRecordMeta = {
  syncId: HarnessAuthSyncId;
  updatedAt: number;
};

/** Extract harness auth records from the bootstrap secret list. */
export function listHarnessAuthCloudRecords(
  secrets: Array<{ kind: string; payload: string; updatedAt: number }>
): Array<HarnessAuthCloudRecordMeta & { payload: string }> {
  const out: Array<HarnessAuthCloudRecordMeta & { payload: string }> = [];
  for (const record of secrets) {
    const syncId = parseHarnessAuthCloudKind(record.kind);
    if (syncId && record.payload) {
      out.push({ syncId, payload: record.payload, updatedAt: record.updatedAt });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Per-device opt-in preferences                                            */
/* ------------------------------------------------------------------------ */

export const HARNESS_AUTH_SYNC_PREFS_STORAGE_KEY = "cesium.harness-auth-sync";
export const HARNESS_AUTH_SYNC_PREFS_EVENT = "cesium:harness-auth-sync";

export type HarnessAuthSyncPrefs = {
  schemaVersion: 1;
  /**
   * Per-harness opt-in. `true` = keep this harness's sign-in synced,
   * `false` = user declined (never offer again), absent = undecided
   * (offers may be shown).
   */
  enabled: Partial<Record<HarnessAuthSyncId, boolean>>;
  updatedAt: number;
};

function emptyPrefs(): HarnessAuthSyncPrefs {
  return { schemaVersion: 1, enabled: {}, updatedAt: 0 };
}

export function readHarnessAuthSyncPrefs(): HarnessAuthSyncPrefs {
  const raw = clientKeyValueStore().getItem(HARNESS_AUTH_SYNC_PREFS_STORAGE_KEY);
  if (!raw) {
    return emptyPrefs();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HarnessAuthSyncPrefs> | null;
    if (!parsed || parsed.schemaVersion !== 1) {
      return emptyPrefs();
    }
    const enabled: Partial<Record<HarnessAuthSyncId, boolean>> = {};
    for (const [key, value] of Object.entries(parsed.enabled ?? {})) {
      if (isHarnessAuthSyncId(key) && typeof value === "boolean") {
        enabled[key] = value;
      }
    }
    return {
      schemaVersion: 1,
      enabled,
      updatedAt:
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
    };
  } catch {
    return emptyPrefs();
  }
}

export function setHarnessAuthSyncEnabled(
  syncId: HarnessAuthSyncId,
  enabled: boolean
): HarnessAuthSyncPrefs {
  const prefs = readHarnessAuthSyncPrefs();
  const next: HarnessAuthSyncPrefs = {
    schemaVersion: 1,
    enabled: { ...prefs.enabled, [syncId]: enabled },
    updatedAt: Date.now(),
  };
  clientKeyValueStore().setItem(
    HARNESS_AUTH_SYNC_PREFS_STORAGE_KEY,
    JSON.stringify(next)
  );
  getClientPlatform().emitEvent(HARNESS_AUTH_SYNC_PREFS_EVENT);
  return next;
}

/** Tri-state opt-in: `true`/`false` once decided, `null` while undecided. */
export function harnessAuthSyncDecision(
  syncId: HarnessAuthSyncId,
  prefs: HarnessAuthSyncPrefs = readHarnessAuthSyncPrefs()
): boolean | null {
  const value = prefs.enabled[syncId];
  return typeof value === "boolean" ? value : null;
}
