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

const MAX_SERVER_NICKNAME_LENGTH = 80;

/**
 * The appearance after the user renames a server to `name` in the device
 * picker, or null when nothing changes. The rename is the nickname, so it
 * outranks the engine's name; clearing it, or typing the name the server
 * shows without one (`unrenamedLabel`), removes it.
 */
export function renameServerAppearance(
  appearance: ServerRailAppearance,
  name: string,
  unrenamedLabel: string
): ServerRailAppearance | null {
  const trimmed = name.trim().slice(0, MAX_SERVER_NICKNAME_LENGTH).trim();
  const nickname = trimmed && trimmed !== unrenamedLabel ? trimmed : undefined;
  if (nickname === (appearance.nickname?.trim() || undefined)) {
    return null;
  }
  const next = { icon: appearance.icon, color: appearance.color };
  return nickname ? { ...next, nickname } : next;
}

/**
 * A rename the user gave the server wins, then the name the engine reports
 * for itself, then the connection label it was saved under.
 */
export function getServerDisplayLabel(
  server: { id: string; label: string; baseUrl: string },
  appearance?: Pick<ServerRailAppearance, "nickname">,
  engineName?: string | null
): string {
  if (isLocalDeviceServer(server)) {
    return LOCAL_DEVICE_SERVER_LABEL;
  }
  const nickname = appearance?.nickname?.trim();
  return nickname || engineName?.trim() || server.label;
}
