import type {
  BrowserEngineEvent,
  BrowserEngineSession,
  BrowserViewportBounds,
} from "@/lib/browser-engine";

export type DesktopBrowserCommand =
  | { op: "goto"; url: string }
  | { op: "reload" | "stop" | "back" | "forward" | "focus" }
  | { op: "copy" | "paste" | "cut" | "selectAll" | "undo" | "redo" };

export type DesktopBrowserBridge = {
  isAvailable?: () => boolean | Promise<boolean>;
  createSession: (input: {
    tabId: string;
    url: string;
  }) => Promise<BrowserEngineSession & { url?: string | null }>;
  destroySession: (sessionId: string) => Promise<void>;
  setBounds: (sessionId: string, bounds: BrowserViewportBounds | null) => Promise<void>;
  setDevtoolsBounds?: (
    sessionId: string,
    bounds: BrowserViewportBounds | null
  ) => Promise<void>;
  setDevtoolsOpen: (sessionId: string, open: boolean) => Promise<void>;
  command: (
    sessionId: string,
    command: DesktopBrowserCommand
  ) => Promise<BrowserEngineEvent | null>;
  cdpCommand?: (sessionId: string, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  capturePage?: (
    sessionId: string
  ) => Promise<{ imageDataUrl?: string | null; url?: string | null; error?: string } | null>;
  dispatchInput?: (
    sessionId: string,
    input:
      | { type: "mouse"; action: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "middle" | "right" }
      | { type: "key"; action: "down" | "up" | "press" | "type"; key: string }
  ) => Promise<boolean>;
  setEmulation?: (
    sessionId: string,
    metrics: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
  ) => Promise<boolean>;
  onEvent: (
    listener: (event: BrowserEngineEvent & { sessionId: string }) => void
  ) => () => void;
};

type DesktopBrowserGlobal = Window & {
  cesiumDesktop?: {
    browser?: DesktopBrowserBridge;
  };
};

export function getDesktopBrowserBridge(): DesktopBrowserBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = (window as DesktopBrowserGlobal).cesiumDesktop?.browser;
  if (!bridge) {
    return null;
  }
  if (bridge.isAvailable && !bridge.isAvailable()) {
    return null;
  }
  return bridge;
}

