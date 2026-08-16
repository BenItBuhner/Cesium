import type { CloudMode } from "./cloud/cloud-flags";

export type WorkbenchAccountKind =
  | "local-only"
  | "device"
  | "signed-out"
  | "signed-in";

export type WorkbenchEngineKind =
  | "connecting"
  | "online"
  | "auth_required"
  | "offline";

export type WorkbenchAccess = {
  accountKind: WorkbenchAccountKind;
  displayName: string;
  email: string | null;
  imageUrl: string | null;
  engineKind: WorkbenchEngineKind;
  engineLabel: string;
  engineBaseUrl: string;
  /** Engine is reachable and authenticated — chats/files/terminals can run. */
  agentsLive: boolean;
  /** Using an engine without a cloud account. */
  isGuest: boolean;
  cloudSyncReady: boolean;
};

export type WorkbenchAccessInput = {
  cloudMode: CloudMode;
  cloudStatus: "disabled" | "signed-out" | "loading" | "ready";
  userName: string | null;
  userEmail: string | null;
  userImageUrl: string | null;
  authReady: boolean;
  authEnabled: boolean;
  authAuthenticated: boolean;
  authConnectionError: string | null;
  health: string;
  engineLabel: string;
  engineBaseUrl: string;
};

export function deriveWorkbenchAccess(input: WorkbenchAccessInput): WorkbenchAccess {
  const accountKind: WorkbenchAccountKind =
    input.cloudMode === "disabled"
      ? "local-only"
      : input.cloudMode === "device"
        ? "device"
        : input.cloudStatus === "signed-out"
          ? "signed-out"
          : input.cloudStatus === "ready" || input.userName || input.userEmail
            ? "signed-in"
            : "signed-out";

  const engineKind: WorkbenchEngineKind = !input.authReady
    ? "connecting"
    : input.authConnectionError || input.health === "offline"
      ? "offline"
      : input.health === "auth_required" || (input.authEnabled && !input.authAuthenticated)
        ? "auth_required"
        : input.health === "online" || input.health === "degraded" || input.health === "unknown"
          ? input.authReady &&
            !input.authConnectionError &&
            (!input.authEnabled || input.authAuthenticated)
            ? "online"
            : "connecting"
          : "connecting";

  const agentsLive =
    input.authReady &&
    !input.authConnectionError &&
    (!input.authEnabled || input.authAuthenticated) &&
    input.health !== "offline" &&
    input.health !== "auth_required";

  const signedInName =
    input.userName?.trim() || input.userEmail?.split("@")[0] || "Account";

  const displayName =
    accountKind === "signed-in"
      ? signedInName
      : accountKind === "device"
        ? "This device"
        : accountKind === "local-only"
          ? "Guest"
          : "Sign in";

  return {
    accountKind,
    displayName,
    email: input.userEmail,
    imageUrl: input.userImageUrl,
    engineKind,
    engineLabel: input.engineLabel,
    engineBaseUrl: input.engineBaseUrl,
    agentsLive,
    isGuest: agentsLive && accountKind !== "signed-in",
    cloudSyncReady: input.cloudStatus === "ready",
  };
}
