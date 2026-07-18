import { NativeModules, Platform } from "react-native";

export type PhoneControlConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type PhoneControlStatus = {
  enabled: boolean;
  connectionState: PhoneControlConnectionState;
  lastError?: string;
  serverUrl: string;
  workspaceId: string;
  deviceId: string;
  accessibilityEnabled: boolean;
  assistantSelected: boolean;
  assistantRoleAvailable: boolean;
  hotwordMode: "oem_dependent";
  privateDisplaySupported: boolean;
};

type CesiumPhoneControlModule = {
  setEnabled(
    enabled: boolean,
    serverUrl: string,
    workspaceId: string,
    authToken?: string | null
  ): Promise<PhoneControlStatus>;
  syncConnection(
    serverUrl: string,
    workspaceId: string,
    authToken?: string | null
  ): Promise<PhoneControlStatus>;
  getStatus(): Promise<PhoneControlStatus>;
  openAccessibilitySettings(): Promise<boolean>;
  requestAssistantRole(): Promise<boolean>;
  launchAssistant(): Promise<boolean>;
};

const nativeModule = NativeModules.CesiumPhoneControl as
  | CesiumPhoneControlModule
  | undefined;

const fallbackStatus: PhoneControlStatus = {
  enabled: false,
  connectionState: "disabled",
  serverUrl: "",
  workspaceId: "",
  deviceId: "",
  accessibilityEnabled: false,
  assistantSelected: false,
  assistantRoleAvailable: false,
  hotwordMode: "oem_dependent",
  privateDisplaySupported: false,
};

async function callOrFallback<T>(
  call: (module: CesiumPhoneControlModule) => Promise<T>,
  fallback: T
): Promise<T> {
  if (Platform.OS !== "android" || !nativeModule) return fallback;
  return call(nativeModule);
}

export const CesiumPhoneControl = {
  getStatus: () => callOrFallback((module) => module.getStatus(), fallbackStatus),
  setEnabled: (
    enabled: boolean,
    serverUrl: string,
    workspaceId: string,
    authToken?: string | null
  ) =>
    callOrFallback(
      (module) => module.setEnabled(enabled, serverUrl, workspaceId, authToken),
      fallbackStatus
    ),
  syncConnection: (
    serverUrl: string,
    workspaceId: string,
    authToken?: string | null
  ) =>
    callOrFallback(
      (module) => module.syncConnection(serverUrl, workspaceId, authToken),
      fallbackStatus
    ),
  openAccessibilitySettings: () =>
    callOrFallback((module) => module.openAccessibilitySettings(), false),
  requestAssistantRole: () =>
    callOrFallback((module) => module.requestAssistantRole(), false),
  launchAssistant: () => callOrFallback((module) => module.launchAssistant(), false),
};
