import { NativeModules, Platform } from "react-native";

export type AndroidPhoneControlCapabilities = {
  appLaunch: boolean;
  appList: boolean;
  screenSnapshot: boolean;
  screenCapture: boolean;
  gestures: boolean;
  textInput: boolean;
  globalActions: boolean;
  settings: boolean;
  secondaryDisplay: boolean;
  assistant: boolean;
  accessibilityEnabled: boolean;
  assistantRoleHeld: boolean;
  thirdPartyAppsOnSecondaryDisplay: false;
  hardwareWakeWord: false;
};

export type AndroidPhoneControlStatus = {
  deviceId: string;
  controlEnabled: boolean;
  configured: boolean;
  serverUrl: string;
  workspaceId: string;
  capabilities: AndroidPhoneControlCapabilities;
  secondaryDisplay: {
    active: boolean;
    displayId: number | null;
    width: number;
    height: number;
    title: string;
    body: string;
    visibleToUser: false;
    thirdPartyAppsSupported: false;
    platformLimit: string;
  };
  wakeWord: {
    supported: false;
    reason: string;
  };
};

export type AndroidPhoneControlConfig = {
  enabled?: boolean;
  serverUrl?: string | null;
  workspaceId?: string | null;
  authToken?: string | null;
  backendId?: string | null;
  mode?: string | null;
  modelId?: string | null;
  modelName?: string | null;
};

type CesiumPhoneControlNativeModule = {
  getStatus(): Promise<string>;
  configure(json: string): Promise<string>;
  setEnabled(enabled: boolean): Promise<string>;
  openAccessibilitySettings(): Promise<boolean>;
  requestAssistantRole(): Promise<boolean>;
  openAssistantSettings(): Promise<boolean>;
  invokeAssistant(): Promise<boolean>;
  executeCommand(json: string): Promise<string>;
};

const nativeModule = NativeModules.CesiumPhoneControl as
  | CesiumPhoneControlNativeModule
  | undefined;

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function requireModule(): CesiumPhoneControlNativeModule {
  if (Platform.OS !== "android" || !nativeModule) {
    throw new Error("Cesium phone control is only available in the Android application.");
  }
  return nativeModule;
}

export const CesiumPhoneControl = {
  available: Platform.OS === "android" && Boolean(nativeModule),

  async getStatus(): Promise<AndroidPhoneControlStatus | null> {
    if (!this.available) return null;
    return parse<AndroidPhoneControlStatus>(await requireModule().getStatus());
  },

  async configure(
    config: AndroidPhoneControlConfig
  ): Promise<AndroidPhoneControlStatus | null> {
    if (!this.available) return null;
    return parse<AndroidPhoneControlStatus>(
      await requireModule().configure(JSON.stringify(config))
    );
  },

  async setEnabled(enabled: boolean): Promise<AndroidPhoneControlStatus | null> {
    if (!this.available) return null;
    return parse<AndroidPhoneControlStatus>(
      await requireModule().setEnabled(enabled)
    );
  },

  async openAccessibilitySettings(): Promise<void> {
    await requireModule().openAccessibilitySettings();
  },

  async requestAssistantRole(): Promise<void> {
    await requireModule().requestAssistantRole();
  },

  async openAssistantSettings(): Promise<void> {
    await requireModule().openAssistantSettings();
  },

  async invokeAssistant(): Promise<void> {
    await requireModule().invokeAssistant();
  },

  async executeCommand(
    command: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return parse<Record<string, unknown>>(
      await requireModule().executeCommand(JSON.stringify(command))
    );
  },
};
