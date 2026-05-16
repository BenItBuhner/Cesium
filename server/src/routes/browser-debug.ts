import { Hono } from "hono";
import type { Context } from "hono";
import { Agent, fetch as undiciFetch } from "undici";
import { buildBrowserProxyPathFromHref } from "../lib/browser-proxy-path.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  ACCESS_TOKEN_QUERY_PARAM,
  IFRAME_ACCESS_TOKEN_QUERY_PARAM,
  SESSION_TOKEN_HEADER,
} from "../lib/auth.js";
import {
  captureRenderedElementScreenshot,
  createDebugSession,
  destroyDebugSession,
  getDebugSession,
} from "../browser-debug/chromium-session.js";

export const browserDebugRoutes = new Hono();

const chromiumAgent = new Agent({ connect: { timeout: 15_000 } });

function requestOrigin(c: { req: { header: (name: string) => string | undefined } }): string {
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ||
    "http";
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    "localhost:9100";
  return `${proto}://${host}`;
}

function requestHost(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    "localhost:9100"
  );
}

function requestAccessToken(c: Context): string | null {
  const headerToken = c.req.header(SESSION_TOKEN_HEADER)?.trim();
  if (headerToken) {
    return headerToken;
  }

  const iframeToken = c.req.query(IFRAME_ACCESS_TOKEN_QUERY_PARAM)?.trim();
  if (iframeToken) {
    return iframeToken;
  }

  const queryToken = c.req.query(ACCESS_TOKEN_QUERY_PARAM)?.trim();
  if (queryToken) {
    return queryToken;
  }

  return null;
}

/**
 * Build the iframe URL that loads Chromium's **local** DevTools frontend
 * (bundled inside the Chromium binary, served at /devtools/devtools_app.html
 * on the remote debugging port) through our session-scoped proxy.
 *
 * `rawFrontendUrl` comes from Chromium's /json/list. Modern Chromium defaults
 * to `https://chrome-devtools-frontend.appspot.com/serve_rev/<rev>/<html>.html?ws=<host>/devtools/page/<id>`;
 * we discard the host/revision bits but keep the html file name so Elements /
 * Worker panels resolve to the correct local entrypoint.
 */
function rewriteDevtoolsFrontendUrl(
  rawFrontendUrl: string,
  sessionId: string,
  targetId: string,
  host: string,
  accessToken: string | null
): string {
  const htmlFile = (() => {
    const match = rawFrontendUrl.match(/([A-Za-z0-9_]+\.html)(?:\?|$)/);
    return match?.[1] ?? "devtools_app.html";
  })();
  const wsPathParams = new URLSearchParams();
  if (accessToken) {
    wsPathParams.set(ACCESS_TOKEN_QUERY_PARAM, accessToken);
  }
  const wsPathQuery = wsPathParams.toString();
  const wsPath = `${host}/ws/browser-debug/${sessionId}/devtools/page/${targetId}${
    wsPathQuery ? `?${wsPathQuery}` : ""
  }`;
  const path = `/browser-debug/${sessionId}/devtools/${htmlFile}`;
  return `${path}?ws=${wsPath}`;
}

browserDebugRoutes.post("/api/browser-debug/sessions", async (c) => {
  try {
    const workspace = await requireWorkspaceFromRequest(c);
    const body = await c.req.json<{
      targetUrl?: string;
      useIframeProxy?: boolean;
    }>();
    const rawTarget = body.targetUrl?.trim();
    if (!rawTarget) {
      return c.json({ error: "Expected targetUrl." }, 400);
    }
    let navigateUrl = rawTarget;
    if (body.useIframeProxy) {
      try {
        const origin = requestOrigin(c);
        navigateUrl = `${origin.replace(/\/+$/, "")}${buildBrowserProxyPathFromHref(rawTarget)}`;
      } catch {
        return c.json({ error: "Invalid targetUrl for proxy navigation." }, 400);
      }
    }
    const session = await createDebugSession(workspace.id, navigateUrl);
    const host = requestHost(c);
    const accessToken = requestAccessToken(c);
    const devtoolsPath = rewriteDevtoolsFrontendUrl(
      session.rawDevtoolsFrontendUrl,
      session.id,
      session.targetId,
      host,
      accessToken
    );
    return c.json(
      {
        sessionId: session.id,
        workspaceId: workspace.id,
        targetId: session.targetId,
        devtoolsPath,
      },
      201
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create debug session.";
    const isPlaywright =
      message.includes("Playwright") ||
      message.includes("playwright") ||
      message.includes("Chromium");
    console.error("[browser-debug] session create failed:", message);
    return c.json({ error: message }, isPlaywright ? 503 : 400);
  }
});

browserDebugRoutes.delete("/api/browser-debug/sessions/:sessionId", async (c) => {
  try {
    const workspace = await requireWorkspaceFromRequest(c);
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "Missing session id." }, 400);
    }
    const rec = getDebugSession(sessionId);
    if (!rec || rec.workspaceId !== workspace.id) {
      return c.json({ error: "Unknown session." }, 404);
    }
    await destroyDebugSession(sessionId);
    return c.body(null, 204);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete session.";
    return c.json({ error: message }, 400);
  }
});

/**
 * Lightweight "is this session still alive?" probe. Browser tabs call this on
 * mount whenever they hold a `debugSessionId` from a prior open, so that a
 * server restart (which wipes in-memory Chromium sessions) can transparently
 * reset the UI instead of leaving a dead iframe.
 */
browserDebugRoutes.get("/api/browser-debug/sessions/:sessionId", async (c) => {
  try {
    const workspace = await requireWorkspaceFromRequest(c);
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "Missing session id." }, 400);
    }
    const rec = getDebugSession(sessionId);
    if (!rec || rec.workspaceId !== workspace.id) {
      return c.json({ error: "Unknown session." }, 404);
    }
    const host = requestHost(c);
    const accessToken = requestAccessToken(c);
    const devtoolsPath = rewriteDevtoolsFrontendUrl(
      rec.rawDevtoolsFrontendUrl,
      rec.id,
      rec.targetId,
      host,
      accessToken
    );
    // Best-effort current URL — used by the client to sync the IDE URL bar
    // with the user's last in-DevTools navigation when they close the console.
    let currentUrl: string | null = null;
    try {
      currentUrl = rec.page.url() || null;
    } catch {
      currentUrl = null;
    }
    return c.json({
      sessionId: rec.id,
      workspaceId: rec.workspaceId,
      targetId: rec.targetId,
      devtoolsPath,
      currentUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check session.";
    return c.json({ error: message }, 400);
  }
});

/**
 * Drive the actual Chromium (via Playwright's `Page`) from the IDE URL bar,
 * back/forward/reload buttons when the DevTools console is open. Without this
 * the browser tab would need to render two iframes (our proxy view + the real
 * page DevTools is inspecting) and the user would see duplicate content. With
 * this, the console iframe becomes the single source of truth for the page,
 * and the IDE chrome stays integrated (URL bar, nav buttons).
 */
browserDebugRoutes.post(
  "/api/browser-debug/sessions/:sessionId/navigate",
  async (c) => {
    try {
      const workspace = await requireWorkspaceFromRequest(c);
      const sessionId = c.req.param("sessionId")?.trim();
      if (!sessionId) {
        return c.json({ error: "Missing session id." }, 400);
      }
      const rec = getDebugSession(sessionId);
      if (!rec || rec.workspaceId !== workspace.id) {
        return c.json({ error: "Unknown session." }, 404);
      }
      const body = await c.req.json<{
        op?: "goto" | "reload" | "back" | "forward";
        url?: string;
      }>();
      const op = body.op;
      if (!op) {
        return c.json({ error: "Missing op." }, 400);
      }
      // `waitUntil: "commit"` gives us a response as soon as the network request
      // is issued, instead of waiting for full load — navigations to heavy
      // sites would otherwise time the endpoint out from the IDE's perspective.
      const navOpts = { waitUntil: "commit" as const, timeout: 15_000 };
      try {
        if (op === "goto") {
          if (!body.url || typeof body.url !== "string") {
            return c.json({ error: "Expected url for goto." }, 400);
          }
          await rec.page.goto(body.url, navOpts);
        } else if (op === "reload") {
          await rec.page.reload(navOpts);
        } else if (op === "back") {
          await rec.page.goBack(navOpts);
        } else if (op === "forward") {
          await rec.page.goForward(navOpts);
        } else {
          return c.json({ error: `Unknown op: ${op}` }, 400);
        }
      } catch {
        // Playwright rejects on aborts, ERR_ABORTED during redirects, etc.
        // The navigation often still succeeds — fall through and report the
        // current URL so the IDE can sync regardless.
      }
      let url: string | null = null;
      try {
        url = rec.page.url() || null;
      } catch {
        url = null;
      }
      return c.json({ url });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to navigate session.";
      return c.json({ error: message }, 400);
    }
  }
);

/**
 * Design-mode fallback screenshot.
 *
 * Used only when the browser-side SVG/foreignObject renderer fails to produce
 * `imageDataUrl`. The client sends the currently loaded proxied page URL plus
 * a DOM child-index path for the clicked element, and we re-render that page in
 * headless Chromium and screenshot the matching element (or the recorded clip
 * rect as a fallback).
 */
browserDebugRoutes.post("/api/browser-debug/rendered-element-screenshot", async (c) => {
  try {
    await requireWorkspaceFromRequest(c);
    const body = await c.req.json<{
      pageUrl?: string;
      pathIndices?: number[];
      rect?: { left: number; top: number; width: number; height: number } | null;
      viewport?: { width: number; height: number } | null;
      scroll?: { x: number; y: number } | null;
    }>();
    const rawUrl = body.pageUrl?.trim();
    if (!rawUrl) {
      return c.json({ error: "Expected pageUrl." }, 400);
    }
    let pageUrl: URL;
    try {
      pageUrl = new URL(rawUrl);
    } catch {
      return c.json({ error: "Invalid pageUrl." }, 400);
    }
    const origin = requestOrigin(c);
    if (pageUrl.origin !== origin || !pageUrl.pathname.startsWith("/browser/")) {
      return c.json(
        { error: "Rendered element screenshots must target the authenticated browser proxy URL." },
        400
      );
    }
    const screenshot = await captureRenderedElementScreenshot({
      pageUrl: pageUrl.toString(),
      viewport: {
        width: body.viewport?.width ?? 1280,
        height: body.viewport?.height ?? 900,
      },
      pathIndices: body.pathIndices ?? [],
      rect: body.rect ?? null,
      scroll: body.scroll ?? null,
    });
    return c.json({ imageDataUrl: screenshot });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to capture rendered element screenshot.";
    return c.json({ error: message }, 400);
  }
});

/**
 * Pure passthrough to Chromium's own DevTools HTTP server.
 * Accepts: GET /browser-debug/:sessionId/<path>  → http://127.0.0.1:<debugPort>/<path>
 */
async function proxyGetToChromium(
  c: Context,
  sessionId: string,
  subPath: string,
  search: string
): Promise<Response> {
  const rec = getDebugSession(sessionId);
  if (!rec) {
    return new Response("Unknown debug session", { status: 404 });
  }
  const upstream = `http://127.0.0.1:${rec.debugPort}${subPath}${search}`;
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(upstream, {
      dispatcher: chromiumAgent,
    } as Parameters<typeof undiciFetch>[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream fetch failed";
    return new Response(`Chromium proxy failed: ${message}`, { status: 502 });
  }

  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (
      k === "content-encoding" ||
      k === "content-length" ||
      k === "connection" ||
      k === "keep-alive" ||
      k === "transfer-encoding"
    ) {
      return;
    }
    outHeaders.set(key, value);
  });

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    c.req.header("host") ||
    "localhost:9100";

  // Rewrite /json/list-style responses so devtoolsFrontendUrl + webSocketDebuggerUrl
  // point at our proxy instead of 127.0.0.1:<chromiumPort> (which the browser can't reach).
  if (contentType.includes("application/json") && subPath.startsWith("/json")) {
    const text = await res.text();
    const rewritten = text
      .replace(/"webSocketDebuggerUrl":"ws:\/\/[^/"]+/g, `"webSocketDebuggerUrl":"ws://${host}/ws/browser-debug/${sessionId}`)
      .replace(/"devtoolsFrontendUrl":"\/devtools/g, `"devtoolsFrontendUrl":"/browser-debug/${sessionId}/devtools`)
      .replace(/ws=[^&"]+/g, (match) => {
        const raw = match.slice(3);
        const pathOnly = raw.replace(/^[^/]+/, "");
        return `ws=${host}/ws/browser-debug/${sessionId}${pathOnly}`;
      });
    outHeaders.set("content-type", contentType);
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  }

  // The DevTools shell HTML (inspector.html / devtools_app.html / worker_app.html)
  // ships a tight CSP that only allows `ws://127.0.0.1:*`. We need to relax it so
  // our proxied `ws://<host>/ws/browser-debug/…` endpoint is reachable, AND so that
  // the frontend's remote font/image fetches don't trip on 'self'-only rules.
  if (contentType.includes("text/html")) {
    const text = await res.text();
    const rewritten = relaxDevtoolsHtml(text);
    outHeaders.set("content-type", contentType);
    outHeaders.delete("content-security-policy");
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  }

  // Strip any CSP on non-HTML responses too — some Chromium assets send one.
  outHeaders.delete("content-security-policy");
  return new Response(res.body as BodyInit | null, {
    status: res.status,
    headers: outHeaders,
  });
}

function relaxDevtoolsHtml(html: string): string {
  // Chromium's bundled DevTools ships a CSP that only allows `ws://127.0.0.1:*`
  // as a connect-src target. Our WS goes through the proxy at `ws://<host>/ws/...`,
  // which is NOT 127.0.0.1:* from the browser's perspective. Replace the meta-CSP
  // with a permissive one so the frontend can reach our bridge + fetch its own assets.
  const permissive =
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
    "connect-src * ws: wss: data: blob:; " +
    "script-src * 'unsafe-inline' 'unsafe-eval' blob:; " +
    "worker-src * blob:; " +
    "style-src * 'unsafe-inline'; " +
    "img-src * data: blob:; " +
    "font-src * data:; " +
    "media-src * data: blob:; " +
    "frame-src * data:;";
  return html.replace(
    /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    `<meta http-equiv="Content-Security-Policy" content="${permissive}">`
  );
}

browserDebugRoutes.get("/browser-debug/:sessionId/devtools/*", async (c) => {
  const sessionId = c.req.param("sessionId");
  const url = new URL(c.req.url);
  const subPath = url.pathname.slice(`/browser-debug/${sessionId}`.length);
  return proxyGetToChromium(c, sessionId, subPath, url.search);
});

browserDebugRoutes.get("/browser-debug/:sessionId/json", async (c) => {
  const sessionId = c.req.param("sessionId");
  const url = new URL(c.req.url);
  return proxyGetToChromium(c, sessionId, "/json", url.search);
});

browserDebugRoutes.get("/browser-debug/:sessionId/json/*", async (c) => {
  const sessionId = c.req.param("sessionId");
  const url = new URL(c.req.url);
  const subPath = url.pathname.slice(`/browser-debug/${sessionId}`.length);
  return proxyGetToChromium(c, sessionId, subPath, url.search);
});

/**
 * Convenience entry point: hitting `/browser-debug/console?sessionId=…` redirects
 * to the actual DevTools frontend path (kept for compatibility with older clients).
 */
browserDebugRoutes.get("/browser-debug/console", (c) => {
  const sessionId = c.req.query("sessionId")?.trim() ?? "";
  const rec = sessionId ? getDebugSession(sessionId) : undefined;
  if (!rec) {
    return c.text("Unknown or expired debug session.", 404);
  }
  const host = requestHost(c);
  const accessToken = requestAccessToken(c);
  const devtoolsPath = rewriteDevtoolsFrontendUrl(
    rec.rawDevtoolsFrontendUrl,
    rec.id,
    rec.targetId,
    host,
    accessToken
  );
  return c.redirect(devtoolsPath, 302);
});
