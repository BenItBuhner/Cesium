import { AGENT_BACKENDS } from "./providers.js";
import type { AgentBackendId, AgentConversationRecord } from "./types.js";

const FALLBACK_BACKEND_ID: AgentBackendId = "cesium-agent";

/** Stored rows may still reference harness backends removed from `AgentBackendId`. */
const LEGACY_BACKEND_REMAP: Record<string, AgentBackendId> = {
  "claude-adapter": "claude-code-sdk",
  "cursor-acp": "cursor-sdk",
  "opencode-acp": "opencode-server",
  "codex-adapter": "codex-app-server",
};

export function normalizeConversationRecord(
  record: AgentConversationRecord
): AgentConversationRecord {
  const normalizedMetadata = {
    archivedAt:
      typeof record.archivedAt === "number" && Number.isFinite(record.archivedAt)
        ? record.archivedAt
        : null,
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
