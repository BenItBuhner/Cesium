export const PHONE_CONTROL_PROTOCOL_VERSION = 1 as const;

export type PhoneControlCapability =
  | "appLaunch"
  | "appList"
  | "screenSnapshot"
  | "screenCapture"
  | "gestures"
  | "textInput"
  | "globalActions"
  | "settings"
  | "secondaryDisplay"
  | "assistant";

export type PhoneControlCapabilities = Record<PhoneControlCapability, boolean> & {
  accessibilityEnabled: boolean;
  assistantRoleHeld: boolean;
  thirdPartyAppsOnSecondaryDisplay: false;
  hardwareWakeWord: false;
};

export type PhoneControlDevice = {
  deviceId: string;
  workspaceId: string;
  name: string;
  platform: "android";
  protocolVersion: typeof PHONE_CONTROL_PROTOCOL_VERSION;
  capabilities: PhoneControlCapabilities;
  connected: boolean;
  registeredAt: number;
  lastSeenAt: number;
  appVersion?: string;
  androidVersion?: string;
  sdkInt?: number;
  model?: string;
};

export type PhoneControlCommandPayload =
  | { type: "get_status" }
  | { type: "list_apps"; query?: string }
  | { type: "list_displays" }
  | {
      type: "launch_app";
      packageName?: string;
      appName?: string;
      deepLink?: string;
      displayId?: number;
    }
  | { type: "snapshot"; maxNodes?: number; displayId?: number }
  | { type: "screenshot"; quality?: number; displayId?: number }
  | { type: "tap"; x?: number; y?: number; text?: string; viewId?: string; displayId?: number }
  | { type: "long_press"; x: number; y: number; durationMs?: number }
  | {
      type: "swipe";
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      durationMs?: number;
    }
  | { type: "type_text"; text: string; targetText?: string; viewId?: string; replace?: boolean }
  | {
      type: "global_action";
      action:
        | "back"
        | "home"
        | "recents"
        | "notifications"
        | "quick_settings"
        | "power_dialog"
        | "lock_screen"
        | "take_screenshot";
    }
  | {
      type: "open_settings";
      page:
        | "accessibility"
        | "assistant"
        | "wifi"
        | "bluetooth"
        | "notifications"
        | "display"
        | "sound"
        | "battery"
        | "location"
        | "security"
        | "application";
      packageName?: string;
    }
  | {
      type: "secondary_display";
      action: "create" | "status" | "update" | "close" | "launch_app";
      width?: number;
      height?: number;
      title?: string;
      body?: string;
      packageName?: string;
      appName?: string;
    };

export type PhoneControlCommand = {
  commandId: string;
  seq: number;
  workspaceId: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  payload: PhoneControlCommandPayload;
};

export type PhoneControlCommandResult = {
  commandId: string;
  seq: number;
  workspaceId: string;
  deviceId: string;
  ok: boolean;
  completedAt: number;
  result?: unknown;
  error?: string;
};

export function defaultPhoneControlCapabilities(): PhoneControlCapabilities {
  return {
    appLaunch: false,
    appList: true,
    screenSnapshot: false,
    screenCapture: false,
    gestures: false,
    textInput: false,
    globalActions: false,
    settings: false,
    secondaryDisplay: false,
    assistant: true,
    accessibilityEnabled: false,
    assistantRoleHeld: false,
    thirdPartyAppsOnSecondaryDisplay: false,
    hardwareWakeWord: false,
  };
}
