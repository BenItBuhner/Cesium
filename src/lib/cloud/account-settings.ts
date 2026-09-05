import {
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "@cesium/client";

/**
 * Account settings document: the cloud-synced projection of the global
 * settings. Everything a user would expect to follow them between devices
 * lives here - theme, rail layout, keyboard shortcuts, feature flags, and the
 * composer defaults (last-used harness / mode / model per harness).
 *
 * Two slices stay engine-scoped and are never uploaded:
 * - `models.byBackend` is merged against each engine's live model catalog and
 *   has its own diff endpoint; pushing another engine's catalog would only be
 *   discarded by the PUT route anyway.
 * - `agents.rememberedPermissions` are keyed by workspace id (engine-local)
 *   and written by agent sessions through dedicated routes.
 */
export const ACCOUNT_SETTINGS_DOC_VERSION = 2 as const;

export type AccountSyncedSettings = Omit<GlobalSettingsState, "models" | "agents"> & {
  agents: Omit<GlobalSettingsState["agents"], "rememberedPermissions">;
};

export type AccountSettingsDocument = {
  version: typeof ACCOUNT_SETTINGS_DOC_VERSION;
  settings: AccountSyncedSettings;
};

export type CloudAccountSettingsRecord = {
  payload: string;
  updatedAt: number;
};

export function pickAccountSyncedSettings(settings: GlobalSettingsState): AccountSyncedSettings {
  const rest: Partial<GlobalSettingsState> = { ...settings };
  delete rest.models;
  const syncedAgents: Partial<GlobalSettingsState["agents"]> = { ...settings.agents };
  delete syncedAgents.rememberedPermissions;
  return {
    ...(rest as Omit<GlobalSettingsState, "models" | "agents">),
    agents: syncedAgents as AccountSyncedSettings["agents"],
  };
}

/** Deterministic JSON (sorted keys) so equal settings hash equal on every device. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Signature of the account-synced projection of `settings`. */
export function accountSettingsSignature(settings: GlobalSettingsState): string {
  return stableStringify(pickAccountSyncedSettings(settings));
}

export function serializeAccountSettingsDocument(settings: GlobalSettingsState): string {
  const document: AccountSettingsDocument = {
    version: ACCOUNT_SETTINGS_DOC_VERSION,
    settings: pickAccountSyncedSettings(settings),
  };
  return stableStringify(document);
}

/**
 * Parse a cloud payload. Anything that is not a v2 document (the pre-account
 * localStorage blob a stale client may still upload, garbage, `null`) reads as
 * "no account settings yet", so the next push replaces it.
 */
export function parseAccountSettingsDocument(
  payload: string | null | undefined
): AccountSyncedSettings | null {
  if (!payload) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as { version?: unknown; settings?: unknown };
  if (record.version !== ACCOUNT_SETTINGS_DOC_VERSION) {
    return null;
  }
  if (!record.settings || typeof record.settings !== "object") {
    return null;
  }
  const normalized = normalizeLoadedGlobalSettings({
    ...(record.settings as Record<string, unknown>),
    schemaVersion: 1,
  });
  return pickAccountSyncedSettings(normalized);
}

/**
 * Overlay the account document onto the local settings. Engine-scoped slices
 * (`models`, `agents.rememberedPermissions`) always come from `current`.
 */
export function applyAccountSyncedSettings(
  current: GlobalSettingsState,
  synced: AccountSyncedSettings
): GlobalSettingsState {
  const next = normalizeLoadedGlobalSettings({
    ...synced,
    schemaVersion: 1,
    models: current.models,
    agents: {
      ...synced.agents,
      rememberedPermissions: current.agents.rememberedPermissions,
    },
  });
  return accountSettingsSignature(next) === accountSettingsSignature(current) ? current : next;
}

/** Last successful reconciliation with the account document (per user). */
export type AccountSettingsSyncMarker = {
  /** `accountSettingsSignature` of the settings that were in sync. */
  signature: string;
  /** `updatedAt` of the cloud row those settings correspond to. */
  cloudUpdatedAt: number;
};

export type AccountSettingsSyncDecision =
  | { action: "wait" }
  | { action: "noop" }
  | { action: "push" }
  | { action: "apply"; settings: AccountSyncedSettings };

/**
 * Pure reconciliation step between the local settings and the account document.
 *
 * - The account is the source of truth; the local copy comes from whichever
 *   engine this device currently uses for settings, and engines are followers.
 *   Loading settings from an engine (boot fetch, refetch, switching the
 *   settings server) is therefore never treated as a user edit.
 * - Only explicit edits on this device (`localEditsPending`) push upward. If
 *   the account also changed since the last reconciliation, the more recent
 *   side wins (`cloud.updatedAt` vs. the first pending local edit).
 * - Pushing requires settings hydrated from an engine so factory defaults or
 *   an offline cache never overwrite the account. Applying only requires the
 *   cloud document, so a fresh device looks like home before it connects an
 *   engine.
 */
export function resolveAccountSettingsSync(input: {
  /** `undefined` while the cloud query is still loading; `null` when the user has no document. */
  cloud: CloudAccountSettingsRecord | null | undefined;
  local: GlobalSettingsState;
  hydrated: boolean;
  marker: AccountSettingsSyncMarker | null;
  localEditsPending: boolean;
  /** Epoch ms of the first local edit since the last reconciliation. */
  localDirtySince: number | null;
}): AccountSettingsSyncDecision {
  const { cloud, local, hydrated, marker, localEditsPending, localDirtySince } = input;
  if (cloud === undefined) {
    return { action: "wait" };
  }
  const localSignature = accountSettingsSignature(local);
  const cloudSettings = cloud ? parseAccountSettingsDocument(cloud.payload) : null;

  if (!cloudSettings) {
    // No usable account document yet: seed it from this device once it holds
    // real (hydrated) settings. Without hydration there is nothing worth
    // uploading, and nothing to apply either.
    return hydrated ? { action: "push" } : { action: "noop" };
  }

  const cloudSignature = stableStringify(cloudSettings);
  if (cloudSignature === localSignature) {
    return { action: "noop" };
  }

  const cloudChangedSinceMarker = !marker || marker.cloudUpdatedAt !== cloud!.updatedAt;
  if (localEditsPending && hydrated) {
    if (!cloudChangedSinceMarker) {
      return { action: "push" };
    }
    // Both sides moved: last writer wins.
    if (localDirtySince !== null && localDirtySince > cloud!.updatedAt) {
      return { action: "push" };
    }
  }
  return { action: "apply", settings: cloudSettings };
}
