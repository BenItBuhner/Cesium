/**
 * Same-origin inference relay for the Browser Machine.
 *
 * Direct browser → provider calls only work when the provider sends CORS
 * headers (OpenRouter, some proxies). Many do not (api.openai.com), so the
 * in-page harness falls back to this stateless relay: the client sends its
 * own Authorization header plus the full upstream URL, and the relay streams
 * the response (including SSE) back. No keys are stored server-side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "x-api-key",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
];

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "0.0.0.0" || lower === "::1") return true;
  if (/^127\./.test(lower) || /^10\./.test(lower) || /^192\.168\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
  if (lower.endsWith(".internal") || lower.endsWith(".local")) return true;
  return false;
}

export async function POST(request: Request): Promise<Response> {
  const upstreamRaw = request.headers.get("x-cesium-upstream-url") ?? "";
  let upstream: URL;
  try {
    upstream = new URL(upstreamRaw);
  } catch {
    return Response.json({ error: "Invalid x-cesium-upstream-url" }, { status: 400 });
  }
  if (upstream.protocol !== "https:" || isBlockedHost(upstream.hostname)) {
    return Response.json(
      { error: "Only public https upstreams are allowed." },
      { status: 403 }
    );
  }
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers,
      body: request.body,
      // @ts-expect-error - duplex is required by Node fetch for streamed bodies.
      duplex: "half",
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        error: `Inference relay failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 }
    );
  }
}
