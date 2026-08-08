/**
 * Base URL where this Cesium server is reachable from local processes
 * (harness CLIs run on the same machine as the server).
 */
export function localMcpServerBaseUrl(): string {
  const explicit = process.env.OPENCURSOR_SERVER_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const port = Number.parseInt(process.env.PORT ?? "9100", 10) || 9100;
  return `http://127.0.0.1:${port}`;
}

/** Streamable HTTP MCP endpoint for a built-in server (browser, phone). */
export function builtinMcpHttpUrl(workspaceId: string, serverId: string): string {
  return `${localMcpServerBaseUrl()}/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/mcp/servers/${encodeURIComponent(serverId)}/http`;
}
