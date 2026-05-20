const STORAGE_KEY = "opencursor.last-workspace-by-server";

type LastWorkspaceByServer = Record<string, string>;

function readMap(): LastWorkspaceByServer {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const result: LastWorkspaceByServer = {};
    for (const [serverId, workspaceId] of Object.entries(parsed)) {
      if (typeof serverId === "string" && typeof workspaceId === "string" && workspaceId.trim()) {
        result[serverId] = workspaceId;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeMap(map: LastWorkspaceByServer): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function rememberLastWorkspaceForServer(serverId: string, workspaceId: string): void {
  if (!serverId.trim() || !workspaceId.trim()) {
    return;
  }
  const map = readMap();
  map[serverId] = workspaceId;
  writeMap(map);
}

export function getLastWorkspaceForServer(serverId: string): string | null {
  return readMap()[serverId] ?? null;
}
