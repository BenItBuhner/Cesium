// Moved to @cesium/core (packages/core/src/mcp-server-display.ts). Re-export shim keeps @/lib/mcp-server-display imports stable.
export {
  extractMcpServerIdFromRecords,
  extractMcpServerIdFromTitle,
  extractMcpServerIdFromWorkedTool,
  formatMcpServerDisplayName,
  formatMcpToolDisplayName,
  isMcpWorkedTool,
  normalizeMcpServerId,
  parseMcpCompositeToolName,
  summarizeMcpServerCounts,
  summarizeMcpWorkedTools,
} from "@cesium/core";
