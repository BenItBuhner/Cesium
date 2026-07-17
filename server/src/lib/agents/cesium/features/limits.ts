import type { CesiumHarnessLimits, CesiumHarnessSettings, CesiumSubagentsVersion } from "./types.js";

/** Timed `wait` tool hard cap (24 hours) — mirrors Cesium prompt defaults. */
export const DEFAULT_WAIT_MAX_SECONDS = 24 * 60 * 60;

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

export const DEFAULT_SUBAGENTS_VERSION: CesiumSubagentsVersion = 1;

export function defaultHarnessLimits(): CesiumHarnessLimits {
  return {
    waitMaxSeconds: DEFAULT_WAIT_MAX_SECONDS,
    waitAgentDefaultTimeoutMs: DEFAULT_WAIT_AGENT_DEFAULT_TIMEOUT_MS,
    waitAgentMinTimeoutMs: DEFAULT_WAIT_AGENT_MIN_TIMEOUT_MS,
    waitAgentMaxTimeoutMs: DEFAULT_WAIT_AGENT_MAX_TIMEOUT_MS,
    maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
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

  let waitAgentMinTimeoutMs = clampInt(
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
  let waitAgentDefaultTimeoutMs = clampInt(
    asNumber(record.waitAgentDefaultTimeoutMs) ?? defaults.waitAgentDefaultTimeoutMs,
    waitAgentMinTimeoutMs,
    waitAgentMaxTimeoutMs
  );

  return {
    waitMaxSeconds,
    waitAgentDefaultTimeoutMs,
    waitAgentMinTimeoutMs,
    waitAgentMaxTimeoutMs,
    maxConcurrentSubagents: clampInt(
      asNumber(record.maxConcurrentSubagents) ?? defaults.maxConcurrentSubagents,
      1,
      64
    ),
  };
}

export function normalizeHarnessSettings(raw: unknown): CesiumHarnessSettings {
  const defaults = defaultHarnessSettings();
  const record = asRecord(raw);
  if (!record) return defaults;
  const features = asRecord(record.features);
  const subagents = asRecord(features?.subagents);
  return {
    features: {
      subagents: {
        version: normalizeSubagentsVersion(
          subagents?.version ?? features?.subagents ?? defaults.features.subagents.version
        ),
      },
    },
    limits: normalizeHarnessLimits(record.limits),
  };
}

export function mergeHarnessSettings(
  current: CesiumHarnessSettings,
  patch: {
    features?: { subagents?: { version?: CesiumSubagentsVersion | number | string } };
    limits?: Partial<CesiumHarnessLimits>;
  }
): CesiumHarnessSettings {
  return normalizeHarnessSettings({
    features: {
      subagents: {
        version: patch.features?.subagents?.version ?? current.features.subagents.version,
      },
    },
    limits: {
      ...current.limits,
      ...(patch.limits ?? {}),
    },
  });
}

/** Resolve and validate a wait_agent timeout against configured limits. */
export function resolveWaitAgentTimeoutMs(
  requested: number | undefined,
  limits: CesiumHarnessLimits
): number {
  if (requested == null || !Number.isFinite(requested)) {
    return limits.waitAgentDefaultTimeoutMs;
  }
  const ms = Math.floor(requested);
  if (ms < limits.waitAgentMinTimeoutMs) {
    throw new Error(
      `wait_agent.timeout_ms must be at least ${limits.waitAgentMinTimeoutMs} (configured minimum).`
    );
  }
  if (ms > limits.waitAgentMaxTimeoutMs) {
    throw new Error(
      `wait_agent.timeout_ms must be at most ${limits.waitAgentMaxTimeoutMs} (configured maximum, default 30 minutes).`
    );
  }
  return ms;
}
