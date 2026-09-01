export type OAuthCompletedDeepLink = {
  sessionId?: string;
  ok: boolean;
  kind?: string;
};

export function parseOAuthCompletedDeepLink(
  url: string
): OAuthCompletedDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = (parsed.host || parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  const path = parsed.pathname.replace(/^\/+/, "").toLowerCase();
  if (parsed.protocol !== "cesium:") {
    return null;
  }
  if (host !== "oauth" && path !== "oauth" && path !== "oauth/done") {
    return null;
  }
  const sessionId =
    parsed.searchParams.get("ticket")?.trim() ||
    parsed.searchParams.get("session")?.trim() ||
    undefined;
  const kind = parsed.searchParams.get("kind")?.trim() || undefined;
  return {
    sessionId,
    ok: parsed.searchParams.get("ok") !== "0",
    kind,
  };
}
