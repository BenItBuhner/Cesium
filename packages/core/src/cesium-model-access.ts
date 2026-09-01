/**
 * Cesium Agent per-model access policy (allowlist + user notes) shared by
 * every engine that hosts the Cesium harness: the Bun server and the
 * in-browser machine persist the same shape and must apply identical
 * normalization/merge semantics so Settings behaves the same everywhere.
 */

/** Hard cap for user-authored per-model notes surfaced to agents. */
export const CESIUM_MODEL_DESCRIPTION_MAX_LENGTH = 250;

export type CesiumModelAccessEntry = {
  /** False removes the model from the agent picker and spawn_agent overrides. */
  enabled: boolean;
  /**
   * Short user note (≤ 250 chars) presented alongside the model to the primary
   * agent and every subagent, so agents can pick overrides intelligently.
   */
  description?: string;
};

export type CesiumModelAccessSettings = {
  /** modelId → access policy. Models without an entry stay enabled. */
  entries: Record<string, CesiumModelAccessEntry>;
};

/** Per-entry patch: null deletes an entry, omitted entries are untouched. */
export type CesiumModelAccessPatch = {
  entries?: Record<string, { enabled?: boolean; description?: string | null } | null>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Trim + cap a per-model note; undefined when empty. */
function normalizeModelDescription(raw: unknown): string | undefined {
  const trimmed = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, CESIUM_MODEL_DESCRIPTION_MAX_LENGTH);
}

/**
 * Only meaningful entries persist: enabled-with-no-note is the implicit
 * default, so such rows are dropped to keep the settings file small.
 */
export function normalizeCesiumModelAccess(raw: unknown): CesiumModelAccessSettings {
  const record = asRecord(raw);
  const entriesRecord = asRecord(record?.entries);
  const entries: Record<string, CesiumModelAccessEntry> = {};
  if (entriesRecord) {
    for (const [modelId, value] of Object.entries(entriesRecord)) {
      const key = modelId.trim();
      const entry = asRecord(value);
      if (!key || !entry) {
        continue;
      }
      const enabled = entry.enabled !== false;
      const description = normalizeModelDescription(entry.description);
      if (enabled && !description) {
        continue;
      }
      entries[key] = { enabled, ...(description ? { description } : {}) };
    }
  }
  return { entries };
}

/**
 * Merge a model-access patch into the stored map. Descriptions over the
 * 250-char cap are rejected (not silently truncated) so the settings UI can
 * surface the validation error.
 */
export function mergeCesiumModelAccess(
  current: CesiumModelAccessSettings,
  patch: CesiumModelAccessPatch
): CesiumModelAccessSettings {
  const entries: Record<string, CesiumModelAccessEntry> = { ...current.entries };
  for (const [modelId, value] of Object.entries(patch.entries ?? {})) {
    const key = modelId.trim();
    if (!key) {
      continue;
    }
    if (value === null) {
      delete entries[key];
      continue;
    }
    if (typeof value.description === "string") {
      const trimmed = value.description.trim();
      if (trimmed.length > CESIUM_MODEL_DESCRIPTION_MAX_LENGTH) {
        throw new Error(
          `Model description for ${key} must be at most ${CESIUM_MODEL_DESCRIPTION_MAX_LENGTH} characters (got ${trimmed.length}).`
        );
      }
    }
    const existing = entries[key];
    const enabled = value.enabled ?? existing?.enabled ?? true;
    const description =
      value.description === undefined
        ? existing?.description
        : normalizeModelDescription(value.description);
    if (enabled && !description) {
      delete entries[key];
      continue;
    }
    entries[key] = { enabled, ...(description ? { description } : {}) };
  }
  return { entries };
}

export function isCesiumModelEnabled(
  modelId: string,
  access: CesiumModelAccessSettings
): boolean {
  return access.entries[modelId]?.enabled !== false;
}
