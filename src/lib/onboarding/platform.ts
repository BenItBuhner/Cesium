"use client";

import { isCesiumDesktopApp } from "@cesium/client";

/**
 * Platform-adaptive setup profiles.
 *
 * The same wizard renders on every platform; the profile decides which steps
 * exist and how the "connect a server" concern is presented:
 * - web: the client is just a window — connecting an engine is step one.
 * - desktop (Electron): the engine ships embedded and already points at
 *   localhost, so server connection is exempt from the flow and offered only
 *   as an optional footnote for attaching remote machines.
 * - mobile: same posture as web (remote engines are the whole point).
 */
export type SetupStepId = "connect-server" | "agents" | "import" | "first-chat";

export type SetupPlatform = "web" | "desktop" | "mobile";

export type PlatformSetupProfile = {
  platform: SetupPlatform;
  steps: SetupStepId[];
  /** Whether connecting a server is a wizard step or an optional footnote. */
  serverConnection: "step" | "footnote";
};

type CesiumMobileGlobals = {
  __CESIUM_MOBILE_SERVER__?: unknown;
  cesiumMobile?: unknown;
};

function isMobileShell(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const globals = window as Window & CesiumMobileGlobals;
  return Boolean(globals.__CESIUM_MOBILE_SERVER__ || globals.cesiumMobile);
}

export const SETUP_STEP_LABELS: Record<SetupStepId, string> = {
  "connect-server": "Connect your first server",
  agents: "Set up your agents",
  import: "Import previous work",
  "first-chat": "Start your first chat",
};

/** Agents, import, and first chat talk to the engine. They stay locked until one is attached. */
export function setupStepRequiresEngine(step: SetupStepId): boolean {
  return step !== "connect-server";
}

export function visibleSetupSteps(
  profile: PlatformSetupProfile,
  engineConnected: boolean
): SetupStepId[] {
  if (profile.serverConnection === "footnote" || engineConnected) {
    return profile.steps;
  }
  return profile.steps.filter((step) => !setupStepRequiresEngine(step));
}

export function isSetupStepLocked(
  step: SetupStepId,
  input: { profile: PlatformSetupProfile; engineConnected: boolean }
): boolean {
  if (!setupStepRequiresEngine(step)) {
    return false;
  }
  if (input.profile.serverConnection === "footnote") {
    return false;
  }
  return !input.engineConnected;
}

export function getPlatformSetupProfile(): PlatformSetupProfile {
  if (isCesiumDesktopApp()) {
    return {
      platform: "desktop",
      steps: ["agents", "import", "first-chat"],
      serverConnection: "footnote",
    };
  }
  if (isMobileShell()) {
    return {
      platform: "mobile",
      steps: ["connect-server", "agents", "import", "first-chat"],
      serverConnection: "step",
    };
  }
  return {
    platform: "web",
    steps: ["connect-server", "agents", "import", "first-chat"],
    serverConnection: "step",
  };
}
