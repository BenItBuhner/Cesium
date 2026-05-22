import { isLoopbackServerBaseUrl } from "@/lib/configured-server-base-url";
import type { ServerRailAppearance } from "@/lib/global-settings";
import { FOLDER_COLOR_OPTIONS } from "@/lib/workspace-rail-appearance";

export const LOCAL_DEVICE_SERVER_LABEL = "This device";

export function isLocalDeviceServer(server: {
  id: string;
  baseUrl: string;
  label?: string;
}): boolean {
  if (server.id === "desktop-sidecar") {
    return true;
  }
  return (
    server.label?.trim() === LOCAL_DEVICE_SERVER_LABEL &&
    isLoopbackServerBaseUrl(server.baseUrl)
  );
}

export function pickStableServerColor(serverId: string): string {
  let hash = 0;
  for (let index = 0; index < serverId.length; index += 1) {
    hash = (hash * 31 + serverId.charCodeAt(index)) >>> 0;
  }
  return FOLDER_COLOR_OPTIONS[hash % FOLDER_COLOR_OPTIONS.length];
}

export function getServerRailAppearance(
  appearances: Record<string, ServerRailAppearance>,
  serverId: string,
  index: number
): ServerRailAppearance {
  const saved = appearances[serverId];
  if (saved) {
    return {
      icon: saved.icon || "Globe",
      color: saved.color ?? pickStableServerColor(serverId),
      nickname: saved.nickname?.trim() || undefined,
    };
  }
  return {
    icon: "Globe",
    color: FOLDER_COLOR_OPTIONS[index % FOLDER_COLOR_OPTIONS.length],
  };
}

export function getServerDisplayLabel(
  server: { id: string; label: string; baseUrl: string },
  appearance?: Pick<ServerRailAppearance, "nickname">
): string {
  if (isLocalDeviceServer(server)) {
    return LOCAL_DEVICE_SERVER_LABEL;
  }
  const nickname = appearance?.nickname?.trim();
  return nickname || server.label;
}
