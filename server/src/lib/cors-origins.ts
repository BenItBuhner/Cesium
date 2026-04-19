/**
 * RFC1918 / loopback browser origins for homelab deployments. When the API is
 * reached at a private LAN address but the Next.js UI is opened from another
 * workstation (different 192.168.x.x host), `ALLOWED_ORIGINS` is easy to get
 * wrong — the browser then blocks credentialed fetches with a generic
 * "Failed to fetch" and workspace bootstrap never completes.
 */

function ipv4Parts(hostname: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return null;
  return [a, b, c, d];
}

export function isRfc1918Ipv4Host(hostname: string): boolean {
  const p = ipv4Parts(hostname);
  if (!p) return false;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** `Origin` header value from a browser on HTTP(S), e.g. http://192.168.1.5:3000 */
export function isPrivateLanBrowserOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    return isRfc1918Ipv4Host(host);
  } catch {
    return false;
  }
}

/**
 * True when any configured browser origin is on RFC1918 (but not loopback-only).
 * Used when `HOST=0.0.0.0` makes `PUBLIC_HOST` fall back to `localhost`, which
 * would otherwise disable LAN relaxation even though `ALLOWED_ORIGINS` lists a
 * 192.168.x.x Next URL.
 */
function anyAllowedOriginIsPrivateLan(origins: string[]): boolean {
  for (const o of origins) {
    try {
      const host = new URL(o).hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        continue;
      }
      if (isRfc1918Ipv4Host(host)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * When the deployment is clearly homelab (RFC1918 `PUBLIC_HOST` and/or an RFC1918
 * entry in `ALLOWED_ORIGINS`), allow credentialed CORS from any private-LAN
 * browser `Origin` unless `OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS=0`.
 */
export function shouldRelaxPrivateLanCors(
  publicHost: string,
  allowedOrigins: string[] = []
): boolean {
  const explicitDeny =
    process.env.OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS?.trim() === "0";
  if (explicitDeny) return false;
  const force =
    process.env.OPENCURSOR_ALLOW_PRIVATE_LAN_ORIGINS?.trim() === "1";
  if (force) return true;
  if (isRfc1918Ipv4Host(publicHost)) return true;
  return anyAllowedOriginIsPrivateLan(allowedOrigins);
}
