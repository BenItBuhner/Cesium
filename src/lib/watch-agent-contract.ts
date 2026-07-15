// Moved to @cesium/core (packages/core/src/watch-agent-contract.ts). Re-export shim keeps @/lib/watch-agent-contract imports stable.
export {
  availableWatchActions,
  toWatchAgentProjection,
  toWatchSyncEnvelope,
} from "@cesium/core";
export type {
  WatchAgentAction,
  WatchAgentActionRequest,
  WatchAgentProjection,
  WatchAgentSyncEnvelope,
  WatchAgentUsageSnapshot,
  WatchConnectionSource,
} from "@cesium/core";
