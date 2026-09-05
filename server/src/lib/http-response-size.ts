import type { MiddlewareHandler } from "hono";

/**
 * Attach `Content-Length` to string-bodied API responses.
 *
 * Hono's `c.json()` / `c.text()` build their Response from an in-memory string
 * but never set Content-Length, so the `compress()` middleware's size
 * threshold could not apply: every tiny response (health probes, 13-byte 404s,
 * toggle acks) was piped through a gzip CompressionStream and sent chunked -
 * measurable per-request CPU for zero bandwidth gain on localhost. Reading the
 * already-materialized body once and re-attaching it with its byte length lets
 * the compressor skip small payloads and gives clients a real Content-Length.
 *
 * Only mounted on the app's own JSON/text APIs: streaming bodies (`x-ndjson`)
 * are excluded by content type, and proxied upstream responses (`/browser`,
 * `/browser-debug`) are not routed through here at all.
 */
const BUFFERABLE_CONTENT_TYPE = /^\s*(?:application\/json|text\/plain)(?:[;\s]|$)/i;

export const attachContentLength: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (
    !res.body ||
    res.headers.has("Content-Length") ||
    res.headers.has("Transfer-Encoding") ||
    !BUFFERABLE_CONTENT_TYPE.test(res.headers.get("Content-Type") ?? "")
  ) {
    return;
  }
  const bytes = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set("Content-Length", String(bytes.byteLength));
  c.res = new Response(bytes, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};
