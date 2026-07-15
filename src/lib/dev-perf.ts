// Moved to @cesium/client (packages/client/src/dev-perf.ts). Re-export shim keeps existing imports stable.
export {
  devPerfEnabled,
  markConversationSwitchStart,
  markConversationSwitchVisible,
  measureDev,
  measureDevAsync,
  recordPerfSample,
} from "@cesium/client";
export type {
  PerfSample,
} from "@cesium/client";
