import { Hono } from "hono";
import { Agent, fetch as undiciFetch } from "undici";
import { assertBrowserProxyHostAllowed } from "../lib/browser-proxy-allowlist.js";
import { appendDesignModeGuestScript } from "../lib/browser-proxy-design-inject.js";

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

function rewriteLocation(
  location: string,
  upstreamBase: URL,
  requestOrigin: string,
  iframeAuthToken: string | null
): string {
  let locUrl: URL;
  try {
    locUrl = new URL(location, upstreamBase);
  } catch {
    return location;
  }
  const path = buildProxyPathForTarget(locUrl);
  const rewritten = new URL(path, requestOrigin);
  // Preserve the IDE's iframe-auth token across upstream redirects. Without
  // this, a 301 from google.com -> www.google.com lands on our proxy with no
  // credentials and the auth middleware 401s — which is exactly the "idle
  // iframe" symptom we saw from opencursor.techlitnow.com.
  if (iframeAuthToken && !rewritten.searchParams.has("__ocs_access")) {
    rewritten.searchParams.set("__ocs_access", iframeAuthToken);
  }
  return rewritten.toString();
}

function stripFrameBlockingHeaders(headers: Headers): void {
  // Strip every header that would prevent the proxied page from rendering
  // inside our iframe, or that would block our injected guest script from
  // running. We're a developer tool, not a hardened security sandbox — the
  // user already trusts the proxy or they wouldn't be using it.
  //
  // Specifically we MUST drop Content-Security-Policy in full (not just
  // frame-ancestors), because real sites like Bing, Reddit, and most of the
  // Fortune-500 ship a strict `script-src https: 'strict-dynamic' 'nonce-...'`
  // header that blocks both (a) our injected guest script (no nonce) and
  // (b) every one of their OWN scripts once we've rewritten them to our
  // `http://<proxy>/browser/...` origin, because the `https:` source
  // expression doesn't match our scheme. Stripping the full policy lets both
  // groups run.
  headers.delete("x-frame-options");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  // Cross-origin isolation headers prevent our parent IDE origin from
  // reading iframe state (postMessage, etc.). Design-mode + nav sync rely
  // on cross-origin postMessage, so drop them.
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-opener-policy-report-only");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-embedder-policy-report-only");
  headers.delete("cross-origin-resource-policy");
  // Report-Only variants of the same families.
  headers.delete("x-content-security-policy");
  headers.delete("x-webkit-csp");
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
  // Iframe navigation auth rides `?__ocs_access=…` on the proxy URL. Strip it
  // here so it never reaches the upstream site (google.com, etc.) — both to
  // avoid leaking the session token in upstream access logs and to keep the
  // forwarded query identical to what the user actually typed. We use a
  // distinct name instead of `access_token` so we don't trample a legitimate
  // `?access_token=` in the target URL (OAuth callbacks etc.).
  const outerParams = new URLSearchParams(url.search);
  // Snapshot the iframe-auth token before stripping it from the upstream
  // query — we re-attach it to rewritten Location headers further down so
  // the browser stays authenticated across upstream redirects.
  const iframeAuthToken = outerParams.get("__ocs_access");
  outerParams.delete("__ocs_access");
  const forwardedQuery = outerParams.toString();
  const search = forwardedQuery ? `?${forwardedQuery}` : "";
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

  // Behind Cloudflare Tunnel (and any reverse proxy) the incoming request's
  // scheme/host visible to Node is the LOCAL one (e.g. `http://127.0.0.1:9100`),
  // not what the browser sees. Prefer `X-Forwarded-Proto` / `X-Forwarded-Host`
  // so rewritten Location headers + HTML href/src rewrites point at the same
  // public origin the iframe is loaded from — otherwise we emit
  // `http://opencursor.techlitnow.com/...` from an `https://` page and the
  // browser either blocks it as mixed content or hops through HSTS (stripping
  // the auth query).
  const incomingProto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ||
    url.protocol.replace(":", "");
  const incomingHost =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    url.host;
  const requestOrigin = `${incomingProto}://${incomingHost}`;
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
    const rewritten = rewriteLocation(loc, upstream, requestOrigin, iframeAuthToken);
    return new Response(null, {
      status: res.status,
      // Explicit Content-Length: 0 so Node doesn't fall back to
      // Transfer-Encoding: chunked for the empty redirect body — undici
      // (and spec-strict clients) reject responses that combine both or
      // use chunked framing for zero-length bodies.
      headers: new Headers({
        Location: rewritten,
        "content-length": "0",
      }),
    });
  }

  if (res.status >= 300 && res.status < 400) {
    const redirectHeaders = new Headers([...res.headers]);
    // Same framing cleanup as below: upstream already got auto-decompressed
    // by undici, and keeping both content-length + transfer-encoding tips
    // Node's HTTP parser into "HPE_UNEXPECTED_CONTENT_LENGTH".
    redirectHeaders.delete("content-encoding");
    redirectHeaders.delete("content-length");
    redirectHeaders.delete("transfer-encoding");
    return new Response(res.body as BodyInit | null, {
      status: res.status,
      headers: redirectHeaders,
    });
  }

  const outHeaders = new Headers([...res.headers]);
  stripFrameBlockingHeaders(outHeaders);
  // Node's built-in fetch (undici) auto-decompresses the upstream body when
  // the Content-Encoding is gzip/br/deflate, so the bytes we get via
  // res.body / res.arrayBuffer are already plain. Forwarding the original
  // Content-Encoding would mislabel our plain body and the downstream HTTP
  // parser would reject the response. Drop it.
  outHeaders.delete("content-encoding");
  // When we're going to modify + re-serialize the body we must set our OWN
  // Content-Length, and we MUST remove Transfer-Encoding because a response
  // with both headers violates RFC 7230 — Node's undici errors out with
  // HPE_UNEXPECTED_CONTENT_LENGTH / "Content-Length can't be present with
  // Transfer-Encoding" before the smoke test / real browser ever sees the
  // body. Clear both consistently; we repopulate below where appropriate.
  outHeaders.delete("content-length");
  outHeaders.delete("transfer-encoding");

  const ct = outHeaders.get("content-type") ?? "";
  const isHtml = ct.includes("text/html");

  if (!isHtml || !res.body) {
    // Stream the (already-decompressed) upstream body straight through.
    // We've just removed both content-length and transfer-encoding so
    // Node's HTTP layer chooses one framing strategy and sticks to it.
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
  text = appendDesignModeGuestScript(text);
  outHeaders.set("content-length", String(Buffer.byteLength(text, "utf8")));

  return new Response(text, { status: res.status, headers: outHeaders });
});
