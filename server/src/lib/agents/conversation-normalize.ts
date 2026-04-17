import { AGENT_BACKENDS } from "./providers.js";
import type { AgentBackendId, AgentConversationRecord } from "./types.js";

const FALLBACK_BACKEND_ID: AgentBackendId = "cursor-acp";

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
  const rawBackendId = record.config.backendId;
  if (typeof rawBackendId === "string" && rawBackendId in AGENT_BACKENDS) {
    return {
      ...record,
      ...normalizedMetadata,
    };
  }
  const fallbackBackend = AGENT_BACKENDS[FALLBACK_BACKEND_ID];
  return {
    ...record,
    ...normalizedMetadata,
    status:
      record.status === "running" || record.status === "awaiting_permission"
        ? "idle"
        : record.status,
    providerSessionId: null,
    configOptions: [],
    pendingPermission: null,
    capabilities: fallbackBackend.capabilities,
    experimental: Boolean(fallbackBackend.experimental),
    config: {
      ...record.config,
      backendId: fallbackBackend.id,
      mode: fallbackBackend.defaultMode,
      modelId: fallbackBackend.defaultModelId,
      modelName: fallbackBackend.defaultModelName,
    },
  };
}
