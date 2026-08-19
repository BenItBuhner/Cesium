export type OAuthPublicOriginRequest = {
  url: string;
  header: (name: string) => string | undefined;
};

export function resolveOAuthPublicOrigin(
  request: OAuthPublicOriginRequest,
  override?: string
): string {
  const configured =
    override?.trim() ||
    process.env.OPENCURSOR_OAUTH_PUBLIC_ORIGIN?.trim() ||
    process.env.OPENCURSOR_SERVER_PUBLIC_ORIGIN?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const forwardedProto = request.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.header("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
