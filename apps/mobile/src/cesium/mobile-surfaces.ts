import type {
  PlatformCapabilities,
  PlatformKind,
  SurfaceCapability,
} from "@cesium/core/platform-surfaces";

export const nativeSurfaceCapabilities = {
  terminal: false,
  "code-editor": false,
  "browser-preview": true,
  "resizable-layout": false,
  "native-notifications": true,
  "background-execution": false,
  "file-system": false,
  "agent-runtime": false,
} satisfies Record<SurfaceCapability, boolean>;

export function getNativePlatformCapabilities(
  platform: Extract<PlatformKind, "ios" | "android" | "ipad">
): PlatformCapabilities {
  return {
    platform,
    capabilities: nativeSurfaceCapabilities,
  };
}
