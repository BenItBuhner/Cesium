/**
 * Pure decision logic for what the auth boundary should render.
 *
 * The workbench (AuthGate children) must never be unmounted by a *transient*
 * signal — a timed-out auth probe, a rendezvous base-URL re-resolve, or a
 * 30-second health poll misclassifying the server. Unmounting the tree throws
 * away every piece of in-memory UI state (composer text, scroll positions,
 * open panels), which users experience as the app "randomly reloading".
 *
 * The only thing allowed to take a mounted workbench away is a
 * server-confirmed sign-out: an actual `/api/auth/status` (or login/logout)
 * response saying auth is enabled and this client is not authenticated.
 * Network failures are connectivity problems, not auth answers, and the
 * workspace layer already owns disconnect/reconnect UX with toasts.
 */

export type AuthPresentation = "workbench" | "splash" | "gate";

export type AuthPresentationInput = {
  /** Auth status resolution finished at least once for this server. */
  ready: boolean;
  /** Server-side auth is enabled (best known value). */
  enabled: boolean;
  /** This client currently holds an authenticated session (best known value). */
  authenticated: boolean;
  /** Last auth status attempt failed at the network level (timeout, DNS, offline). */
  connectionError: boolean;
  /** The periodic health probe classified the active server as requiring auth. */
  activeServerRequiresAuth: boolean;
  /**
   * The most recent *server response* said: auth enabled, not authenticated.
   * Only a real HTTP answer may set this — never a fetch failure.
   */
  serverConfirmedSignedOut: boolean;
  /** The workbench has already been shown for the currently active server. */
  workbenchLatched: boolean;
};

export function resolveAuthPresentation(
  input: AuthPresentationInput
): AuthPresentation {
  // A confirmed sign-out always wins: session expired or the user logged out.
  if (input.serverConfirmedSignedOut && !input.authenticated) {
    return "gate";
  }

  // Once shown, stay shown. Transient blips (connection errors, flapping
  // health probes, re-checks flipping `ready`) must not blank a live session.
  if (input.workbenchLatched) {
    return "workbench";
  }

  if (!input.ready) {
    return "splash";
  }

  if (input.authenticated) {
    return "workbench";
  }

  // No-auth servers: reachable and nothing demands credentials.
  if (
    !input.enabled &&
    !input.activeServerRequiresAuth &&
    !input.connectionError
  ) {
    return "workbench";
  }

  return "gate";
}
