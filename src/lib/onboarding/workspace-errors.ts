import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import type {
  WorkbenchNotificationInput,
  WorkbenchNotificationSeverity,
} from "@/components/notifications/workbench-notification-types";
import type { OnboardingState } from "@/lib/onboarding/state";
import type { PlatformSetupProfile } from "@/lib/onboarding/platform";

const WORKSPACE_ERROR_MESSAGE_MAX_LENGTH = 240;

const MISSING_ENGINE_PATTERNS = [
  /did not respond like a cesium engine/i,
  /failed to fetch/i,
  /networkerror/i,
  /load failed/i,
  /err_connection/i,
  /econnrefused/i,
  /econnreset/i,
  /enotfound/i,
  /socket hang up/i,
  /network request failed/i,
];

export const SETUP_ROUTE = "/setup";
export const FIRST_SERVER_NOTICE_DISMISS_KEY =
  "cesium-onboarding:first-server-notice-dismissed";

/**
 * Toast-safe error text. Error messages can carry entire response bodies
 * (worst case: a full HTML document when the configured server is not a
 * Cesium engine) - markup blobs and multi-kilobyte dumps help nobody in a
 * notification, so fall back to the friendly message and cap the length.
 */
export function compactWorkspaceErrorMessage(
  error: unknown,
  fallback: string
): string {
  const raw =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  if (!raw || raw.startsWith("<")) {
    return fallback;
  }
  return raw.length > WORKSPACE_ERROR_MESSAGE_MAX_LENGTH
    ? `${raw.slice(0, WORKSPACE_ERROR_MESSAGE_MAX_LENGTH)}...`
    : raw;
}

export function isMissingEngineError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return MISSING_ENGINE_PATTERNS.some((pattern) => pattern.test(raw));
}

export function hasCompletedFirstServerStep(state: OnboardingState): boolean {
  return (
    state.completedAt != null || state.completedSteps.includes("connect-server")
  );
}

export function shouldPromptFirstServerConnect(input: {
  state: OnboardingState;
  profile: PlatformSetupProfile;
}): boolean {
  if (input.profile.serverConnection === "footnote") {
    return false;
  }
  return !hasCompletedFirstServerStep(input.state);
}

export type WorkspaceLoadNotice = Pick<
  WorkbenchNotificationInput,
  "kind" | "severity" | "title" | "message" | "compact" | "persistent" | "autoDismissMs"
> & {
  setupActionLabel: string | null;
};

/**
 * First-run / missing-engine bootstrap failures become a setup prompt.
 * Real workspace bugs stay as errors.
 */
export function describeWorkspaceLoadFailure(
  error: unknown,
  input: {
    state: OnboardingState;
    profile: PlatformSetupProfile;
  }
): WorkspaceLoadNotice {
  if (!isMissingEngineError(error)) {
    return {
      kind: WORKBENCH_NOTIFICATION_KIND.workspaceLoadError,
      severity: "error" as WorkbenchNotificationSeverity,
      title: "Workspace error",
      message: compactWorkspaceErrorMessage(error, "Failed to load workspace"),
      compact: true,
      persistent: false,
      autoDismissMs: 10_000,
      setupActionLabel: null,
    };
  }

  if (shouldPromptFirstServerConnect(input)) {
    return {
      kind: WORKBENCH_NOTIFICATION_KIND.connectFirstServer,
      severity: "info",
      title: "Connect your first server!",
      message:
        "Cesium needs an engine to open workspaces. Connect one to finish setup - it syncs to your account.",
      compact: false,
      persistent: true,
      autoDismissMs: undefined,
      setupActionLabel: "Connect server",
    };
  }

  return {
    kind: WORKBENCH_NOTIFICATION_KIND.workspaceLoadError,
    severity: "warning",
    title: input.profile.serverConnection === "footnote"
      ? "Can't reach your local engine"
      : "Can't reach your server",
    message:
      "The workbench couldn't talk to a Cesium engine. Reconnect or pick another server to keep going.",
    compact: false,
    persistent: false,
    autoDismissMs: 14_000,
    setupActionLabel: "Open setup",
  };
}

export function wasFirstServerNoticeDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.sessionStorage.getItem(FIRST_SERVER_NOTICE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFirstServerNoticeDismissed(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(FIRST_SERVER_NOTICE_DISMISS_KEY, "1");
  } catch {
    // Private mode / quota - the toast can return next load.
  }
}
