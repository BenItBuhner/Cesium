// Moved to @cesium/core (packages/core/src/mcp-server-display.ts). Re-export shim keeps @/lib/mcp-server-display imports stable.
export {
  extractMcpServerIdFromRecords,
  extractMcpServerIdFromTitle,
  extractMcpServerIdFromWorkedTool,
  formatMcpServerDisplayName,
  isMcpWorkedTool,
  normalizeMcpServerId,
  summarizeMcpServerCounts,
  summarizeMcpWorkedTools,
} from "@cesium/core";
