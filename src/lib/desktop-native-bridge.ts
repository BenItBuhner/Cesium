"use client";

/**
 * Typed access to the Electron shell's native integration surface
 * (`window.cesiumDesktop.notifications` / `.nativeEvents`), the desktop
 * analog of the Android bridge in `src/lib/mobile-bridge.ts`.
 */

import type { MobileSharePayload } from "@/lib/mobile-bridge";

export type DesktopAgentRunSummary = {
  runKey: string;
  conversationId: string | null;
  workspaceId: string | null;
  title: string;
  detail: string;
  progressLabel: string | null;
  needsInput: boolean;
  active: boolean;
};

export type DesktopNotifyPayload = {
  runKey: string;
  title: string;
  body: string;
  kind: "completion" | "intervention" | "test";
  silent?: boolean;
  conversationId?: string | null;
  workspaceId?: string | null;
};

export type DesktopNativeEvent =
  | {
      kind: "notificationAction";
      actionId: string;
      conversationId?: string | null;
      workspaceId?: string | null;
    }
  | { kind: "shareIntake"; payload: MobileSharePayload }
  | { kind: "deepLink"; url: string };

export type DesktopNativeNotificationsBridge = {
  isSupported(): Promise<boolean>;
  notify(payload: DesktopNotifyPayload): Promise<boolean>;
  syncAgentRuns(input: { runs: DesktopAgentRunSummary[] }): Promise<boolean>;
};

export type DesktopNativeEventsBridge = {
  ready(): Promise<DesktopNativeEvent[]>;
  onEvent(listener: (event: DesktopNativeEvent) => void): () => void;
};

type CesiumDesktopNativeGlobal = Window & {
  cesiumDesktop?: {
    isElectron?: boolean;
    platform?: string;
    notifications?: DesktopNativeNotificationsBridge;
    nativeEvents?: DesktopNativeEventsBridge;
  };
};

export function getDesktopNotificationsBridge(): DesktopNativeNotificationsBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as CesiumDesktopNativeGlobal).cesiumDesktop?.notifications ?? null;
}

export function getDesktopNativeEventsBridge(): DesktopNativeEventsBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as CesiumDesktopNativeGlobal).cesiumDesktop?.nativeEvents ?? null;
}

/** True when the Electron shell exposes the native notification surface. */
export function isDesktopNativeAvailable(): boolean {
  return getDesktopNotificationsBridge() != null;
}

export function getDesktopPlatform(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as CesiumDesktopNativeGlobal).cesiumDesktop?.platform ?? null;
}
