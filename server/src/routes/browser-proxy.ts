import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { Agent, fetch as undiciFetch } from "undici";
import { assertBrowserProxyHostAllowed } from "../lib/browser-proxy-allowlist.js";

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const HTML_TO_IMAGE_BUNDLE_PATH = require.resolve(
  "html-to-image/dist/html-to-image.js"
);

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

  const designBridgeScript = `
<script>
(() => {
  if (window.__opencursorDesignBridgeInstalled) return;
  window.__opencursorDesignBridgeInstalled = true;
  const htmlToImageUrl = ${JSON.stringify(`${requestOrigin}/browser/assets/html-to-image.js`)};
  let mode = false;
  let hovered = null;
  let overlay = null;
  let dragState = null;
  let htmlToImagePromise = null;
  const selectionColor = "rgba(99, 102, 241, 0.92)";
  const dragColor = "rgba(236, 72, 153, 0.92)";

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement("div");
    overlay.id = "__opencursor-design-overlay";
    overlay.style.position = "fixed";
    overlay.style.pointerEvents = "none";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483646";
    overlay.innerHTML =
      '<div id="__opencursor-hover-box" style="position:absolute;border:2px solid '+selectionColor+';background:rgba(99,102,241,0.12);box-shadow:0 0 0 9999px rgba(15,23,42,0.04);display:none;"></div>' +
      '<svg id="__opencursor-drag-layer" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;"><path id="__opencursor-drag-path" fill="none" stroke="'+dragColor+'" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" style="display:none;"></path></svg>';
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function hoverBox() {
    ensureOverlay();
    return document.getElementById("__opencursor-hover-box");
  }

  function dragPath() {
    ensureOverlay();
    return document.getElementById("__opencursor-drag-path");
  }

  function hideHover() {
    const box = hoverBox();
    if (box) box.style.display = "none";
  }

  function hideDrag() {
    const path = dragPath();
    if (path) {
      path.style.display = "none";
      path.setAttribute("d", "");
    }
  }

  function setHoveredElement(element) {
    hovered = element;
    if (!mode || !element) {
      hideHover();
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      hideHover();
      return;
    }
    const box = hoverBox();
    if (!box) return;
    box.style.display = "block";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  }

  function pathFromPoints(points) {
    if (!points.length) return "";
    return points.map((point, index) => {
      const prefix = index === 0 ? "M" : "L";
      return prefix + point.x.toFixed(1) + " " + point.y.toFixed(1);
    }).join(" ");
  }

  function appendDragPoint(x, y) {
    if (!dragState) return;
    const last = dragState.points[dragState.points.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 2) {
      return;
    }
    dragState.points.push({ x, y });
  }

  function pathDistance(points) {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      const prev = points[index - 1];
      const next = points[index];
      total += Math.hypot(next.x - prev.x, next.y - prev.y);
    }
    return total;
  }

  function cssPath(element) {
    if (!(element instanceof Element)) return undefined;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += "#" + CSS.escape(current.id);
        parts.unshift(selector);
        break;
      }
      const classNames = Array.from(current.classList).slice(0, 2);
      if (classNames.length) {
        selector += "." + classNames.map((name) => CSS.escape(name)).join(".");
      } else if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(
          (candidate) => candidate.tagName === current.tagName
        );
        if (siblings.length > 1) {
          selector += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function labelForElement(element) {
    const tag = element.tagName.toLowerCase();
    const text = (element.getAttribute("aria-label") || element.getAttribute("alt") || element.textContent || "")
      .trim()
      .replace(/\\s+/g, " ")
      .slice(0, 48);
    return text ? tag + " - " + text : tag;
  }

  function collectCssRulesForElement(element) {
    const collected = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        try {
          if (element.matches(rule.selectorText)) {
            collected.push(rule.cssText);
          }
        } catch {
          // ignore invalid selectors for the current element
        }
        if (collected.length >= 18) {
          return collected.join("\\n");
        }
      }
    }
    return collected.join("\\n");
  }

  function collectInlineScriptsForElement(element) {
    const scripts = Array.from(document.querySelectorAll("script"))
      .filter((script) => !script.src && script.textContent && script.textContent.trim().length > 0)
      .map((script) => script.textContent.trim())
      .slice(0, 3);
    if (scripts.length === 0) return undefined;
    return scripts.join("\\n\\n");
  }

  async function ensureHtmlToImage() {
    if (window.htmlToImage) return window.htmlToImage;
    if (!htmlToImagePromise) {
      htmlToImagePromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = htmlToImageUrl;
        script.async = true;
        script.onload = () => resolve(window.htmlToImage);
        script.onerror = () => reject(new Error("Failed to load html-to-image bridge."));
        document.head.appendChild(script);
      });
    }
    return htmlToImagePromise;
  }

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(",");
    const header = parts[0] || "";
    const mimeMatch = /data:([^;]+)/.exec(header);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    const bytes = atob(parts[1] || "");
    const array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      array[i] = bytes.charCodeAt(i);
    }
    return new Blob([array], { type: mimeType });
  }

  async function captureNodeDataUrl(node, options) {
    const lib = await ensureHtmlToImage();
    return lib.toPng(node, Object.assign({ cacheBust: true, skipFonts: true }, options || {}));
  }

  async function captureElementPayload(element) {
    const dataUrl = await captureNodeDataUrl(element, {
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      backgroundColor: "rgba(255,255,255,0)"
    });
    return {
      type: "element-selection",
      label: labelForElement(element),
      selector: cssPath(element),
      targetUrl: window.location.href,
      html: element.outerHTML.slice(0, 12000),
      css: collectCssRulesForElement(element).slice(0, 12000),
      javascript: collectInlineScriptsForElement(element)?.slice(0, 12000),
      imageDataUrl: dataUrl,
    };
  }

  function circleBounds(points) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  }

  async function captureCirclePayload(points) {
    const bounds = circleBounds(points);
    const padding = 16;
    const left = Math.max(0, Math.floor(bounds.minX - padding));
    const top = Math.max(0, Math.floor(bounds.minY - padding));
    const width = Math.max(32, Math.ceil(bounds.maxX - bounds.minX + padding * 2));
    const height = Math.max(32, Math.ceil(bounds.maxY - bounds.minY + padding * 2));
    const root = document.documentElement;
    const dataUrl = await captureNodeDataUrl(root, {
      width: root.clientWidth,
      height: root.clientHeight,
      canvasWidth: root.clientWidth,
      canvasHeight: root.clientHeight,
      pixelRatio: 1,
      style: {
        transform: "translate(" + (-window.scrollX) + "px," + (-window.scrollY) + "px)",
        transformOrigin: "top left",
      },
      filter: (node) => !(node.id && node.id.startsWith("__opencursor-design-overlay")),
    });
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(img, left, top, width, height, 0, 0, width, height);
    context.strokeStyle = dragColor;
    context.lineWidth = 4;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    points.forEach((point, index) => {
      const x = point.x - left;
      const y = point.y - top;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
    return {
      type: "circle-selection",
      label: "Circled region",
      targetUrl: window.location.href,
      imageDataUrl: canvas.toDataURL("image/png"),
    };
  }

  function postPayload(payload) {
    window.parent.postMessage(
      {
        source: "opencursor-browser-design",
        payload,
      },
      "*"
    );
  }

  async function handleClickSelection() {
    if (!hovered) return;
    try {
      postPayload(await captureElementPayload(hovered));
    } catch (error) {
      postPayload({
        type: "selection-error",
        message: error instanceof Error ? error.message : "Failed to capture selected element.",
      });
    }
  }

  async function finishDragSelection() {
    if (!dragState || dragState.points.length < 2) {
      dragState = null;
      hideDrag();
      return false;
    }
    const points = dragState.points.slice();
    dragState = null;
    hideDrag();
    try {
      postPayload(await captureCirclePayload(points));
    } catch (error) {
      postPayload({
        type: "selection-error",
        message: error instanceof Error ? error.message : "Failed to capture circled region.",
      });
    }
    return true;
  }

  function onPointerMove(event) {
    if (!mode) return;
    if (dragState) {
      appendDragPoint(event.clientX, event.clientY);
      const path = dragPath();
      if (path) {
        path.style.display = "block";
        path.setAttribute("d", pathFromPoints(dragState.points));
      }
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const element = target instanceof Element ? target.closest("body *") : null;
    if (!element || element.id === "__opencursor-design-overlay" || element.closest("#__opencursor-design-overlay")) {
      hideHover();
      return;
    }
    setHoveredElement(element);
  }

  function onPointerDown(event) {
    if (!mode) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#__opencursor-design-overlay")) return;
    event.preventDefault();
    event.stopPropagation();
    dragState = {
      points: [{ x: event.clientX, y: event.clientY }],
      startedAt: performance.now(),
      start: { x: event.clientX, y: event.clientY },
    };
  }

  async function onPointerUp(event) {
    if (!mode) return;
    if (!dragState) return;
    event.preventDefault();
    event.stopPropagation();
    appendDragPoint(event.clientX, event.clientY);
    const elapsed = performance.now() - dragState.startedAt;
    const start = dragState.start || dragState.points[0];
    const directDistance = start
      ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
      : 0;
    const totalDistance = pathDistance(dragState.points);
    const hasDragged =
      directDistance >= 12 ||
      totalDistance >= 24 ||
      (elapsed >= 180 && dragState.points.length >= 3);
    if (hasDragged) {
      await finishDragSelection();
      return;
    }
    dragState = null;
    hideDrag();
    await handleClickSelection();
  }

  function teardown() {
    hideHover();
    hideDrag();
    dragState = null;
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "opencursor-browser-parent") return;
    if (data.type === "set-design-mode") {
      mode = Boolean(data.enabled);
      if (!mode) {
        teardown();
      }
    }
  });

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("scroll", () => {
    if (hovered) {
      setHoveredElement(hovered);
    }
  }, true);
})();
</script>`;

  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${designBridgeScript}</body>`);
  } else {
    out += designBridgeScript;
  }

  return out;
}

export const browserProxyRoutes = new Hono();

browserProxyRoutes.get("/assets/html-to-image.js", async (c) => {
  let source = "";
  try {
    source = await fs.readFile(HTML_TO_IMAGE_BUNDLE_PATH, "utf8");
  } catch {
    source = "";
  }
  if (!source) {
    return c.text("html-to-image bundle not available", 500);
  }
  return new Response(source, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
});

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
