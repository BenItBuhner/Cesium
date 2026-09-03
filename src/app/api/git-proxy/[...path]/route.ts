/**
 * Git smart-HTTP relay for the browser machine.
 *
 * GitHub (and most git hosts) do not send CORS headers on the smart-HTTP
 * endpoints, so a browser cannot `git clone`/`push` directly. This
 * same-origin route relays those requests (isomorphic-git `corsProxy`
 * convention: `/api/git-proxy/<host>/<path>`), restricted to an allowlist of
 * public git hosts and the two git service endpoints. It is stateless and
 * forwards the caller's own Authorization header untouched.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set([
  "github.com",
  "gist.github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
]);

const ALLOWED_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "git-protocol",
  "user-agent",
];

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "www-authenticate"];

function buildUpstreamUrl(pathSegments: string[], search: string): URL | null {
  if (pathSegments.length < 2) return null;
  const [host, ...rest] = pathSegments;
  if (!host || !ALLOWED_HOSTS.has(host.toLowerCase())) return null;
  const upstream = new URL(`https://${host}/${rest.map(encodeURIComponent).join("/")}`);
  // Path segments arrive URL-decoded from Next; re-encoding keeps traversal out.
  upstream.search = search;
  if (!ALLOWED_PATH.test(upstream.pathname)) return null;
  return upstream;
}

async function relay(request: Request, pathSegments: string[]): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstream = buildUpstreamUrl(pathSegments, requestUrl.search);
  if (!upstream) {
    return Response.json(
      { error: "git-proxy: host or path not allowed" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstreamResponse = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
    redirect: "follow",
    // @ts-expect-error - duplex is required by Node fetch for streamed bodies.
    duplex: request.method === "POST" ? "half" : undefined,
  });
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return relay(request, path ?? []);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return relay(request, path ?? []);
}
