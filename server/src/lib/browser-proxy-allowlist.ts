import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import net from "node:net";
import { publicAccessManager } from "./public-access-manager.js";

/**
 * Public internet upstreams (e.g. https://google.com) resolve to routable IPs. By default we **allow** those
 * so the in-IDE browser works without extra config. Set `BROWSER_PROXY_ALLOW_PUBLIC=0` to enforce a strict
 * private/LAN-only allowlist (recommended if the API server is reachable from untrusted networks).
 */
function allowPublicInternet(): boolean {
  if (publicAccessManager.isEnabledSync()) return false;
  const explicit = process.env.BROWSER_PROXY_ALLOW_PUBLIC?.trim();
  if (explicit === "0" || explicit === "false") return false;
  return true;
}

/** Optional: comma-separated extra hostnames to allow (still resolved and checked unless public mode). */
const EXTRA_HOSTS = (process.env.BROWSER_PROXY_EXTRA_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isIpv4(s: string): boolean {
  return net.isIPv4(s);
}

function isIpv6(s: string): boolean {
  return net.isIPv6(s);
}

/** RFC1918, loopback, link-local (IPv4), private IPv6 / ULA / link-local. */
export function isAllowedIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1") return true;

  if (isIpv4(ip)) {
    const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    return false;
  }

  if (isIpv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    // fe80::/10 link-local
    if (lower.startsWith("fe80:")) return true;
    // fc00::/7 unique local
    const h = lower.replace(/^:+/, "");
    const first = h.slice(0, 4);
    if (first.startsWith("fc") || first.startsWith("fd")) return true;
    return false;
  }

  return false;
}

export async function assertBrowserProxyHostAllowed(hostname: string): Promise<void> {
  if (allowPublicInternet()) return;

  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return;
  if (EXTRA_HOSTS.includes(h)) {
    return;
  }

  if (isIpv4(hostname) || isIpv6(hostname)) {
    if (!isAllowedIp(hostname)) {
      throw new Error(`Target address not allowed: ${hostname}`);
    }
    return;
  }

  let records: LookupAddress[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }

  if (records.length === 0) {
    throw new Error(`No addresses for host: ${hostname}`);
  }

  for (const { address } of records) {
    if (!isAllowedIp(address)) {
      throw new Error(`Host resolves to a disallowed address: ${hostname} -> ${address}`);
    }
  }
}
