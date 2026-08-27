import { AGENT_BACKENDS } from "./providers.js";
import { withOpenCodeGenerationOption } from "./opencode-generation.js";
import type { AgentBackendId, AgentConversationRecord } from "./types.js";

const FALLBACK_BACKEND_ID: AgentBackendId = "cesium-agent";

/** Stored rows may still reference harness backends removed from `AgentBackendId`. */
const LEGACY_BACKEND_REMAP: Record<string, AgentBackendId> = {
  "claude-adapter": "claude-code-sdk",
  "opencode-acp": "opencode-server",
  "opencode-v2-beta": "opencode-server",
  "codex-adapter": "codex-app-server",
  "gemini-acp": "google-antigravity-cli",
};

export function normalizeConversationRecord(
  record: AgentConversationRecord
): AgentConversationRecord {
  const rawSettledAt =
    typeof record.settledAt === "number" && Number.isFinite(record.settledAt)
      ? record.settledAt
      : null;
  const rawSettledUntil =
    typeof record.settledUntil === "number" && Number.isFinite(record.settledUntil)
      ? record.settledUntil
      : null;
  // Timed settles ("ignore for a day") lazily expire on read: every API path
  // normalizes records, so an elapsed snooze surfaces as unsettled without a
  // background sweeper. Persistence catches up on the next prompt/patch.
  const settleExpired = rawSettledUntil != null && rawSettledUntil <= Date.now();
  const normalizedMetadata = {
    archivedAt:
      typeof record.archivedAt === "number" && Number.isFinite(record.archivedAt)
        ? record.archivedAt
        : null,
    settledAt: settleExpired ? null : rawSettledAt,
    settledUntil: settleExpired ? null : rawSettledUntil,
    lastReadSeq:
      typeof record.lastReadSeq === "number" && Number.isFinite(record.lastReadSeq)
        ? Math.max(0, Math.min(record.lastEventSeq, Math.floor(record.lastReadSeq)))
        : Math.max(0, record.lastEventSeq),
  };

  const backendKey =
    typeof record.config.backendId === "string" ? record.config.backendId.trim() : "";
  const legacyTarget = LEGACY_BACKEND_REMAP[backendKey];

  let baseRecord = record;
  if (legacyTarget) {
    const targetBackend = AGENT_BACKENDS[legacyTarget];
    if (backendKey === "opencode-v2-beta") {
      baseRecord = {
        ...record,
        capabilities: targetBackend.capabilities,
        experimental: Boolean(targetBackend.experimental),
        configOptions: withOpenCodeGenerationOption(record.configOptions ?? [], "v2-beta"),
        config: {
          ...record.config,
          backendId: legacyTarget,
        },
      };
    } else {
      baseRecord = {
        ...record,
        capabilities: targetBackend.capabilities,
        experimental: Boolean(targetBackend.experimental),
        providerSessionId: null,
        configOptions: [],
        pendingPermission: null,
        status:
          record.status === "running" || record.status === "awaiting_permission"
            ? "idle"
            : record.status,
        config: {
          ...record.config,
          backendId: legacyTarget,
          mode: targetBackend.defaultMode,
          modelId: targetBackend.defaultModelId,
          modelName: targetBackend.defaultModelName,
        },
      };
    }
  }

  const rawBackendId = baseRecord.config.backendId;
  if (typeof rawBackendId === "string" && rawBackendId in AGENT_BACKENDS) {
    return {
      ...baseRecord,
      ...normalizedMetadata,
      queuedPrompts: Array.isArray(baseRecord.queuedPrompts) ? baseRecord.queuedPrompts : [],
    };
  }
  const fallbackBackend = AGENT_BACKENDS[FALLBACK_BACKEND_ID];
  return {
    ...baseRecord,
    ...normalizedMetadata,
    queuedPrompts: Array.isArray(baseRecord.queuedPrompts) ? baseRecord.queuedPrompts : [],
    status:
      baseRecord.status === "running" || baseRecord.status === "awaiting_permission"
        ? "idle"
        : baseRecord.status,
    providerSessionId: null,
    configOptions: [],
    pendingPermission: null,
    capabilities: fallbackBackend.capabilities,
    experimental: Boolean(fallbackBackend.experimental),
    config: {
      ...baseRecord.config,
      backendId: fallbackBackend.id,
      mode: fallbackBackend.defaultMode,
      modelId: fallbackBackend.defaultModelId,
      modelName: fallbackBackend.defaultModelName,
    },
  };
}
