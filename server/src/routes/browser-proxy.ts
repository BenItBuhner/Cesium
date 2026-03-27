import { Hono } from "hono";
import { Agent, fetch as undiciFetch } from "undici";
import { assertBrowserProxyHostAllowed } from "../lib/browser-proxy-allowlist.js";

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Direct TCP/TLS to upstream — avoids Node's global `fetch` routing through
 * `HTTP(S)_PROXY` / `EnvHttpProxyAgent`, which often yields a useless `fetch failed` on Windows.
 */
const upstreamAgent = new Agent({
  connect: {
    timeout: UPSTREAM_TIMEOUT_MS,
  },
});

/** Chrome-like UA so CDNs / edge sites that reject non-browser clients still respond. */
const DEFAULT_UPSTREAM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function formatUpstreamFetchError(e: unknown): string {
  if (e instanceof AggregateError) {
    return e.errors
      .map((x) => (x instanceof Error ? formatUpstreamFetchError(x) : String(x)))
      .join("; ");
  }
  if (e instanceof Error) {
    const parts: string[] = [e.message];
    const cause = e.cause;
    if (cause instanceof Error) {
      parts.push(cause.message);
    } else if (cause != null && String(cause)) {
      parts.push(String(cause));
    }
    return parts.filter(Boolean).join(": ") || "fetch failed";
  }
  return String(e);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Parse host:port from the URL segment. When no port is given, use `defaultPort`
 * (80 for http, 443 for https) — never assume 80 for all schemes or you get
 * `https://host:80/` and TLS fails with "packet length too long".
 */
function parseHostPort(
  segment: string,
  defaultPort: number
): { hostname: string; port: number } {
  const decoded = decodeURIComponent(segment);
  if (decoded.startsWith("[")) {
    const end = decoded.indexOf("]");
    if (end === -1) throw new Error("Invalid IPv6 hostport");
    const hostname = decoded.slice(1, end);
    const rest = decoded.slice(end + 1);
    const portStr = rest.startsWith(":") ? rest.slice(1) : "";
    const port = portStr ? Number.parseInt(portStr, 10) : defaultPort;
    if (Number.isNaN(port)) throw new Error("Invalid port");
    return { hostname, port };
  }
  const idx = decoded.lastIndexOf(":");
  if (idx === -1) {
    return { hostname: decoded, port: defaultPort };
  }
  const hostname = decoded.slice(0, idx);
  const port = Number.parseInt(decoded.slice(idx + 1), 10);
  if (Number.isNaN(port)) throw new Error("Invalid port");
  return { hostname, port };
}

function buildUpstreamUrl(
  scheme: string,
  hostportSegment: string,
  pathname: string,
  search: string
): URL {
  const defaultPort = scheme === "https" ? 443 : 80;
  const { hostname, port } = parseHostPort(hostportSegment, defaultPort);
  const p = port === defaultPort ? "" : `:${port}`;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(`${scheme}://${hostname}${p}${path}${search}`);
}

function buildProxyPathForTarget(target: URL): string {
  const scheme = target.protocol.replace(":", "");
  const hostport = target.host;
  const enc = encodeURIComponent(hostport);
  const path = target.pathname === "" ? "/" : target.pathname;
  const tail =
    path === "/" && !target.search && !target.hash
      ? ""
      : `${path}${target.search}${target.hash}`;
  return `/browser/${scheme}/${enc}${tail === "/" ? "" : tail}`;
}

function rewriteLocation(location: string, upstreamBase: URL, requestOrigin: string): string {
  let locUrl: URL;
  try {
    locUrl = new URL(location, upstreamBase);
  } catch {
    return location;
  }
  const path = buildProxyPathForTarget(locUrl);
  return `${requestOrigin}${path}`;
}

function stripFrameBlockingHeaders(headers: Headers): void {
  headers.delete("x-frame-options");
  const csp = headers.get("content-security-policy");
  headers.delete("content-security-policy");
  if (csp) {
    const relaxed = csp
      .split(";")
      .map((s) => s.trim())
      .filter((d) => !/^frame-ancestors\b/i.test(d) && !/^frame-src\b/i.test(d))
      .join("; ");
    if (relaxed) headers.set("content-security-policy", relaxed);
  }
}

function forwardableHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "host") return;
    out.set(key, value);
  });
  return out;
}

function rewriteHtmlBody(
  html: string,
  upstreamOrigin: string,
  requestOrigin: string
): string {
  const upstream = new URL(upstreamOrigin);
  const abs = upstream.origin;

  const toProxy = (href: string): string => {
    try {
      const resolved = new URL(href, upstream);
      return `${requestOrigin}${buildProxyPathForTarget(resolved)}`;
    } catch {
      return href;
    }
  };

  let out = html;

  // href="..." and src="..." (absolute or same-origin)
  out = out.replace(
    /\b(href|src|action)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attr, quote, url) => {
      const trimmed = url.trim();
      if (
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("#")
      ) {
        return match;
      }
      if (trimmed.startsWith("/browser/")) return match;
      try {
        const resolved = new URL(trimmed, upstream);
        if (resolved.origin !== abs && !trimmed.startsWith("/")) {
          return match;
        }
        return `${attr}=${quote}${toProxy(resolved.href)}${quote}`;
      } catch {
        return match;
      }
    }
  );

  // srcset="url 1x, url2 2x"
  out = out.replace(/\bsrcset\s*=\s*(["'])([^"']*)\1/gi, (match, quote, value) => {
    const parts = value.split(",").map((p: string) => {
      const seg = p.trim().split(/\s+/);
      const url = seg[0];
      if (!url || url.startsWith("data:")) return p.trim();
      try {
        const resolved = new URL(url, upstream);
        const rest = seg.slice(1).join(" ");
        return `${toProxy(resolved.href)}${rest ? ` ${rest}` : ""}`;
      } catch {
        return p.trim();
      }
    });
    return `srcset=${quote}${parts.join(", ")}${quote}`;
  });

  // CSS url(...) in inline styles and <style> — best-effort
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, url) => {
    const t = url.trim();
    if (t.startsWith("data:") || t.startsWith("#")) return m;
    try {
      const resolved = new URL(t, upstream);
      if (resolved.origin !== abs && !t.startsWith("/")) return m;
      return `url(${q}${toProxy(resolved.href)}${q})`;
    } catch {
      return m;
    }
  });

  return out;
}

export const browserProxyRoutes = new Hono();

// Phase 2: add Node `upgrade` handling (e.g. mount a `/browser/ws` route) to tunnel WebSocket
// frames to upstream dev servers so HMR works; plain HTTP preview stays on the catch-all below.

browserProxyRoutes.get("/__ws_stub", (c) =>
  c.json({
    message:
      "WebSocket proxy for HMR is not implemented yet. Use HTTP-only preview or add /browser/ws in a follow-up.",
    phase: 2,
  })
);

browserProxyRoutes.all("/*", async (c) => {
  const url = new URL(c.req.url);
  let pathname = url.pathname;
  if (!pathname.startsWith("/browser")) {
    pathname = `/browser${pathname.startsWith("/") ? "" : "/"}${pathname.replace(/^\//, "")}`;
  }
  const search = url.search;
  const prefix = "/browser/";
  if (!pathname.startsWith(prefix)) {
    return c.json({ error: "Bad browser proxy path" }, 400);
  }

  const rest = pathname.slice(prefix.length);
  const segments = rest.split("/").filter(Boolean);
  if (segments.length < 2) {
    return c.json({ error: "Expected /browser/{http|https}/{host:port}/..." }, 400);
  }

  const scheme = segments[0];
  if (scheme !== "http" && scheme !== "https") {
    return c.json({ error: "Only http and https are supported" }, 400);
  }

  const hostportSeg = segments[1];
  const pathRest = segments.slice(2).join("/");
  const upstreamPath = pathRest ? `/${pathRest}` : "/";

  let upstream: URL;
  try {
    upstream = buildUpstreamUrl(scheme, hostportSeg, upstreamPath, search);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Invalid target URL" },
      400
    );
  }

  try {
    await assertBrowserProxyHostAllowed(upstream.hostname);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Host not allowed";
    const needsHint =
      /disallowed|not allowed|Could not resolve/i.test(msg) && msg.length < 500;
    return c.json(
      {
        error: msg,
        ...(needsHint
          ? {
              hint: "If this should be blocked: set BROWSER_PROXY_ALLOW_PUBLIC=0 to restrict the proxy to private/local hosts only.",
            }
          : {}),
      },
      403
    );
  }

  const requestOrigin = `${url.protocol}//${url.host}`;
  const upstreamBase = new URL(`${upstream.origin}/`);

  const headers = forwardableHeaders(c.req.raw.headers);
  headers.set("host", upstream.host);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_UPSTREAM_UA);
  }
  if (!headers.has("accept")) {
    headers.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
  }

  const init: RequestInit = {
    method: c.req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = await c.req.arrayBuffer();
  }

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(upstream, {
      ...init,
      dispatcher: upstreamAgent,
    } as Parameters<typeof undiciFetch>[1]);
  } catch (e) {
    const detail = formatUpstreamFetchError(e);
    console.error("[browser-proxy] upstream fetch failed:", upstream.href, detail);
    return c.json(
      {
        error: detail,
        upstream: upstream.href,
      },
      502
    );
  }

  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    const loc = res.headers.get("location")!;
    const nextUrl = new URL(loc, upstream);
    try {
      await assertBrowserProxyHostAllowed(nextUrl.hostname);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Redirect host not allowed";
      return c.json(
        {
          error: msg,
          hint: "If this should be blocked: set BROWSER_PROXY_ALLOW_PUBLIC=0 for strict local-only proxying.",
        },
        403
      );
    }
    const rewritten = rewriteLocation(loc, upstream, requestOrigin);
    return new Response(null, {
      status: res.status,
      headers: new Headers({ Location: rewritten }),
    });
  }

  if (res.status >= 300 && res.status < 400) {
    return new Response(res.body as BodyInit | null, {
      status: res.status,
      headers: new Headers([...res.headers]),
    });
  }

  const outHeaders = new Headers([...res.headers]);
  stripFrameBlockingHeaders(outHeaders);
  outHeaders.delete("content-length");
  outHeaders.delete("content-encoding");

  const ct = outHeaders.get("content-type") ?? "";
  const isHtml = ct.includes("text/html");

  if (!isHtml || !res.body) {
    return new Response(res.body as BodyInit | null, {
      status: res.status,
      headers: outHeaders,
    });
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return c.json({ error: "Response too large" }, 413);
  }

  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  text = rewriteHtmlBody(text, upstreamBase.origin, requestOrigin);
  outHeaders.set("content-length", String(Buffer.byteLength(text, "utf8")));

  return new Response(text, { status: res.status, headers: outHeaders });
});
