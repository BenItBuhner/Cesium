import type { BrowserEngineKind } from "@/lib/browser-engine";

export type BrowserControlGroup = "left" | "right";

export type BrowserControlCapability =
  | "tabLifecycle"
  | "navigation"
  | "lock"
  | "screenshot"
  | "snapshot"
  | "contentSearch"
  | "jsEvaluate"
  | "mouseInput"
  | "keyboardInput"
  | "viewportEmulation"
  | "events";

export type BrowserControlCapabilities = Record<BrowserControlCapability, boolean>;

export type BrowserControlViewportPreset =
  | "watch"
  | "mobile"
  | "tablet"
  | "laptop"
  | "desktop"
  | "custom";

export type BrowserControlViewport = {
  preset: BrowserControlViewportPreset;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
};

export type BrowserControlLockState = {
  locked: boolean;
  lockVersion: number;
  lockedByConversationId?: string | null;
  lockReason?: string | null;
  lockedAt?: number | null;
  userUnlockedAt?: number | null;
  userAlteredAt?: number | null;
};

export type BrowserControlTab = {
  tabId: string;
  workspaceId: string;
  group: BrowserControlGroup;
  title: string;
  targetUrl: string;
  currentUrl?: string | null;
  engine: BrowserEngineKind;
  debugSessionId?: string | null;
  nativeSessionId?: string | null;
  active: boolean;
  focused: boolean;
  capabilities: BrowserControlCapabilities;
  viewport: BrowserControlViewport;
  lockState: BrowserControlLockState;
  createdAt: number;
  updatedAt: number;
};

export type BrowserControlSession = {
  controlSessionId: string;
  tabId: string;
  workspaceId: string;
  debugSessionId?: string | null;
  nativeSessionId?: string | null;
  currentUrl?: string | null;
  viewport: BrowserControlViewport;
  lockState: BrowserControlLockState;
  lastEventCursor: number;
  lastAgentActionAt?: number | null;
};

export type BrowserControlEvent =
  | {
      seq: number;
      ts: number;
      type: "lock" | "unlock" | "user_intervention" | "agent_action";
      tabId: string;
      detail?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "console";
      tabId: string;
      level: "log" | "info" | "warning" | "error" | "debug";
      text: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "network";
      tabId: string;
      url: string;
      method?: string;
      status?: number;
      statusText?: string;
      resourceType?: string;
    };

export type BrowserControlSnapshot = {
  tab: BrowserControlTab;
  title?: string | null;
  url?: string | null;
  visibleText: string;
  html?: string;
  accessibilityText?: string;
  elementRefs: Array<{
    ref: string;
    tag: string;
    text?: string;
    role?: string;
    selector?: string;
    rect?: { x: number; y: number; width: number; height: number };
  }>;
  truncated?: boolean;
};

export type BrowserControlInput =
  | {
      type: "mouse";
      action: "move" | "down" | "up" | "click";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      visualLabel?: string;
    }
  | { type: "wheel"; deltaX?: number; deltaY?: number }
  | { type: "key"; action: "down" | "up" | "press" | "type"; key: string };

export const BROWSER_CONTROL_VIEWPORT_PRESETS: Record<
  Exclude<BrowserControlViewportPreset, "custom">,
  BrowserControlViewport
> = {
  watch: { preset: "watch", width: 390, height: 390, deviceScaleFactor: 2, mobile: true, touch: true },
  mobile: { preset: "mobile", width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
  tablet: { preset: "tablet", width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  laptop: { preset: "laptop", width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  desktop: { preset: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
};

export const DEFAULT_BROWSER_CONTROL_VIEWPORT: BrowserControlViewport =
  BROWSER_CONTROL_VIEWPORT_PRESETS.desktop;
