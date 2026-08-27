import type {
  CesiumHarnessFeatureSelection,
  CesiumHarnessLimits,
  CesiumHarnessSettings,
  CesiumSubagentsVersion,
} from "./types.js";

/** Timed `wait` tool hard cap (24 hours) - mirrors Cesium prompt defaults. */
export const DEFAULT_WAIT_MAX_SECONDS = 24 * 60 * 60;
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 5_000;
export const HARD_MAX_PLUGIN_HOOK_TIMEOUT_MS = 60_000;

/**
 * Codex MultiAgentV2 defaults:
 * - default_wait_timeout_ms = 30_000
 * - min often 10_000 in their schema tests; we allow shorter check-ins (1s)
 * - max in Codex is 3_600_000 (60m); Cesium defaults to 30 minutes per product preference
 */
export const DEFAULT_WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_AGENT_MIN_TIMEOUT_MS = 1_000;
/** Absolute ceiling for wait_agent max config (Codex uses 60 minutes). */
export const HARD_MAX_WAIT_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
/** Product default max for wait_agent (30 minutes). */
export const DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8;
/**
 * Codex `agents.max_depth` parity: root is depth 0, children are depth 1, and
 * spawning past the limit fails. Default 1 = only the root agent may spawn.
 */
export const DEFAULT_SUBAGENTS_MAX_SPAWN_DEPTH = 1;
export const HARD_MAX_SUBAGENTS_SPAWN_DEPTH = 4;

export const DEFAULT_SUBAGENTS_VERSION: CesiumSubagentsVersion = 1;

function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function defaultHarnessLimits(): CesiumHarnessLimits {
  return {
    pluginHookTimeoutMs: DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
    waitMaxSeconds: DEFAULT_WAIT_MAX_SECONDS,
    waitAgentDefaultTimeoutMs: DEFAULT_WAIT_AGENT_DEFAULT_TIMEOUT_MS,
    waitAgentMinTimeoutMs: DEFAULT_WAIT_AGENT_MIN_TIMEOUT_MS,
    waitAgentMaxTimeoutMs: DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS,
    // Env overrides mirror how Codex takes these from config.toml; stored
    // harness Settings still win when explicitly set.
    maxConcurrentSubagents: clampInt(
      envInt("OPENCURSOR_SUBAGENTS_MAX_CONCURRENT") ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      1,
      64
    ),
    maxSpawnDepth: clampInt(
      envInt("OPENCURSOR_SUBAGENTS_MAX_DEPTH") ?? DEFAULT_SUBAGENTS_MAX_SPAWN_DEPTH,
      1,
      HARD_MAX_SUBAGENTS_SPAWN_DEPTH
    ),
  };
}

export function defaultHarnessSettings(): CesiumHarnessSettings {
  return {
    features: {
      subagents: { version: DEFAULT_SUBAGENTS_VERSION },
    },
    limits: defaultHarnessLimits(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizeSubagentsVersion(value: unknown): CesiumSubagentsVersion {
  if (value === 2 || value === "2") return 2;
  return 1;
}

export function normalizeHarnessLimits(raw: unknown): CesiumHarnessLimits {
  const defaults = defaultHarnessLimits();
  const record = asRecord(raw);
  if (!record) return defaults;

  const waitMaxSeconds = clampInt(
    asNumber(record.waitMaxSeconds) ?? defaults.waitMaxSeconds,
    1,
    DEFAULT_WAIT_MAX_SECONDS
  );

  const waitAgentMinTimeoutMs = clampInt(
    asNumber(record.waitAgentMinTimeoutMs) ?? defaults.waitAgentMinTimeoutMs,
    1,
    HARD_MAX_WAIT_AGENT_TIMEOUT_MS
  );
  let waitAgentMaxTimeoutMs = clampInt(
    asNumber(record.waitAgentMaxTimeoutMs) ?? defaults.waitAgentMaxTimeoutMs,
    waitAgentMinTimeoutMs,
    HARD_MAX_WAIT_AGENT_TIMEOUT_MS
  );
  if (waitAgentMaxTimeoutMs < waitAgentMinTimeoutMs) {
    waitAgentMaxTimeoutMs = waitAgentMinTimeoutMs;
  }
  const waitAgentDefaultTimeoutMs = clampInt(
    asNumber(record.waitAgentDefaultTimeoutMs) ?? defaults.waitAgentDefaultTimeoutMs,
    waitAgentMinTimeoutMs,
    waitAgentMaxTimeoutMs
  );

  return {
    pluginHookTimeoutMs: clampInt(
      asNumber(record.pluginHookTimeoutMs) ?? defaults.pluginHookTimeoutMs,
      1,
      HARD_MAX_PLUGIN_HOOK_TIMEOUT_MS
    ),
    waitMaxSeconds,
    waitAgentDefaultTimeoutMs,
    waitAgentMinTimeoutMs,
    waitAgentMaxTimeoutMs,
    maxConcurrentSubagents: clampInt(
      asNumber(record.maxConcurrentSubagents) ?? defaults.maxConcurrentSubagents,
      1,
      64
    ),
    maxSpawnDepth: clampInt(
      asNumber(record.maxSpawnDepth) ?? defaults.maxSpawnDepth,
      1,
      HARD_MAX_SUBAGENTS_SPAWN_DEPTH
    ),
  };
}

export function normalizeHarnessSettings(raw: unknown): CesiumHarnessSettings {
  const defaults = defaultHarnessSettings();
  const record = asRecord(raw);
  if (!record) return defaults;
  const features = asRecord(record.features);
  const subagents = asRecord(features?.subagents);
  const normalizedFeatures: Record<string, CesiumHarnessFeatureSelection> = {};
  if (features) {
    for (const [id, selection] of Object.entries(features)) {
      const selectionRecord = asRecord(selection);
      const version = asVersion(selectionRecord?.version ?? selection);
      if (id.trim() && version != null) {
        normalizedFeatures[id] = {
          version,
          ...(asBoolean(selectionRecord?.enabled) != null
            ? { enabled: asBoolean(selectionRecord?.enabled) }
            : {}),
          ...(asRecord(selectionRecord?.config)
            ? { config: { ...asRecord(selectionRecord?.config)! } }
            : {}),
        };
      }
    }
  }
  return {
    features: {
      ...normalizedFeatures,
      subagents: {
        version: normalizeSubagentsVersion(
          subagents?.version ?? features?.subagents ?? defaults.features.subagents.version
        ),
        ...(asBoolean(subagents?.enabled) != null
          ? { enabled: asBoolean(subagents?.enabled) }
          : {}),
        ...(asRecord(subagents?.config)
          ? { config: { ...asRecord(subagents?.config)! } }
          : {}),
      },
    },
    limits: normalizeHarnessLimits(record.limits),
  };
}

export function mergeHarnessSettings(
  current: CesiumHarnessSettings,
  patch: {
    features?: Record<
      string,
      {
        version?: number | string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      } | undefined
    > & {
      subagents?: {
        version?: CesiumSubagentsVersion | number | string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      };
    };
    limits?: Partial<CesiumHarnessLimits>;
  }
): CesiumHarnessSettings {
  const mergedFeatures = { ...current.features };
  for (const [id, selection] of Object.entries(patch.features ?? {})) {
    if (!selection) continue;
    mergedFeatures[id] = {
      ...(current.features[id] ?? { version: 1 }),
      ...selection,
      ...(selection.config
        ? {
            config: { ...selection.config },
          }
        : {}),
    } as CesiumHarnessFeatureSelection;
  }
  return normalizeHarnessSettings({
    features: {
      ...mergedFeatures,
      subagents: {
        version: patch.features?.subagents?.version ?? current.features.subagents.version,
        enabled:
          patch.features?.subagents?.enabled ??
          current.features.subagents.enabled,
        config:
          patch.features?.subagents?.config
            ? { ...patch.features.subagents.config }
            : current.features.subagents.config,
      },
    },
    limits: {
      ...current.limits,
      ...(patch.limits ?? {}),
    },
  });
}

/**
 * Resolve and validate a wait_agent timeout against configured limits.
 * Codex MultiAgentV2 parity: values below the minimum are clamped up to it,
 * while values above the maximum are rejected.
 */
export function resolveWaitAgentTimeoutMs(
  requested: number | undefined,
  limits: CesiumHarnessLimits
): number {
  if (requested == null || !Number.isFinite(requested)) {
    return limits.waitAgentDefaultTimeoutMs;
  }
  const ms = Math.floor(requested);
  if (ms > limits.waitAgentMaxTimeoutMs) {
    throw new Error(
      `wait_agent.timeout_ms must be at most ${limits.waitAgentMaxTimeoutMs} (configured maximum, default 30 minutes).`
    );
  }
  return Math.max(ms, limits.waitAgentMinTimeoutMs);
}
