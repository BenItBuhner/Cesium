import { DEFAULT_PRODUCTION_SITE_URL } from "@/lib/site-url";

export const NATIVE_CLERK_HANDOFF_PARAM = "native_handoff";
export const NATIVE_CLERK_HANDOFF_PATH = "/auth/native-return";
export const NATIVE_CLERK_HANDOFF_KIND = "clerk";
export const WEB_CLERK_REDIRECT_PATH = "/setup?resume=1";
export const NATIVE_CLERK_HANDOFF_TOKEN_TTL_SECONDS = 300;

export type SearchParamsLike =
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function firstParam(
  searchParams: SearchParamsLike,
  key: string
): string | null {
  if (!searchParams) {
    return null;
  }
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key);
  }
  const raw = searchParams[key];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return raw ?? null;
}

export function isNativeClerkHandoffSearch(searchParams: SearchParamsLike): boolean {
  const value = firstParam(searchParams, NATIVE_CLERK_HANDOFF_PARAM);
  return value === "1" || value === "true";
}

export function clerkAuthRedirectPath(searchParams: SearchParamsLike): string {
  return isNativeClerkHandoffSearch(searchParams)
    ? NATIVE_CLERK_HANDOFF_PATH
    : WEB_CLERK_REDIRECT_PATH;
}

export function nativeClerkHandoffUrl(origin = DEFAULT_PRODUCTION_SITE_URL): string {
  return `${origin.replace(/\/+$/, "")}${NATIVE_CLERK_HANDOFF_PATH}`;
}

export function withNativeClerkHandoffQuery(
  url: string,
  origin = DEFAULT_PRODUCTION_SITE_URL
): string {
  const parsed = new URL(url, origin);
  parsed.searchParams.set(NATIVE_CLERK_HANDOFF_PARAM, "1");
  parsed.searchParams.set("redirect_url", nativeClerkHandoffUrl(origin));
  return parsed.toString();
}

export function isClerkAuthPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/sign-up" ||
    pathname.startsWith("/sign-up/")
  );
}

/**
 * Packaged apps open hosted /sign-in and /sign-up in the system browser.
 * If that URL is missing the handoff flag, the user signs in on the website
 * and never returns. Stamp the query onto known auth paths.
 */
export function ensureNativeClerkHandoffOnAuthUrl(
  url: string,
  origin = DEFAULT_PRODUCTION_SITE_URL
): string {
  if (!url) {
    return url;
  }
  try {
    const parsed = new URL(url, origin);
    if (!isClerkAuthPath(parsed.pathname)) {
      return url;
    }
    if (isNativeClerkHandoffSearch(parsed.searchParams)) {
      return parsed.toString();
    }
    return withNativeClerkHandoffQuery(parsed.toString(), origin);
  } catch {
    return url;
  }
}

export function readClerkHandoffTicket(input: {
  sessionId?: string | null;
  ticket?: string | null;
  kind?: string | null;
  ok?: boolean;
}): string | null {
  if (input.ok === false) {
    return null;
  }
  if (input.kind !== NATIVE_CLERK_HANDOFF_KIND) {
    return null;
  }
  const ticket = (input.ticket ?? input.sessionId)?.trim();
  return ticket ? ticket : null;
}

export type ClerkTicketClient = {
  create: (params: { strategy: "ticket"; ticket: string }) => Promise<{
    status?: string | null;
    createdSessionId?: string | null;
  }>;
};

export function buildClerkHandoffDeepLink(ticket: string): string {
  const params = new URLSearchParams();
  params.set("session", ticket.trim());
  params.set("ok", "1");
  params.set("kind", NATIVE_CLERK_HANDOFF_KIND);
  return `cesium://oauth/done?${params.toString()}`;
}

export function buildAndroidClerkHandoffIntent(ticket: string): string {
  const params = new URLSearchParams();
  params.set("session", ticket.trim());
  params.set("ok", "1");
  params.set("kind", NATIVE_CLERK_HANDOFF_KIND);
  return `intent://oauth/done?${params.toString()}#Intent;scheme=cesium;package=com.cesium.mobile;end`;
}

export async function activateClerkSessionFromTicket(
  input: {
    signIn: ClerkTicketClient;
    setActive: (params: { session: string }) => Promise<unknown>;
  },
  ticket: string
): Promise<string> {
  const trimmed = ticket.trim();
  if (!trimmed) {
    throw new Error("Missing Clerk sign-in ticket.");
  }
  const result = await input.signIn.create({
    strategy: "ticket",
    ticket: trimmed,
  });
  const sessionId = result.createdSessionId?.trim();
  if (!sessionId) {
    throw new Error("Clerk ticket did not create a session.");
  }
  await input.setActive({ session: sessionId });
  return sessionId;
}
