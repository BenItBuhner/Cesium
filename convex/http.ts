import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,4096}$/;
const MAX_BATCH_SIZE = 250;
const RECORD_TTL_SECONDS = 15 * 60;

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

function serverIdFromPath(request: Request): string | null {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const serverId = segments.at(-1) ?? "";
  return SERVER_ID_PATTERN.test(serverId) ? serverId : null;
}

function bearerSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }
  const secret = authorization.slice("Bearer ".length).trim();
  return SECRET_PATTERN.test(secret) ? secret : null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

const options = httpAction(async () => new Response(null, { status: 204, headers: corsHeaders() }));

const getRecord = httpAction(async (ctx, request) => {
  const serverId = serverIdFromPath(request);
  if (!serverId) {
    return json({ error: "Invalid server id." }, 400);
  }
  const record = await ctx.runQuery(api.rendezvous.get, {
    serverId,
    now: Date.now(),
  });
  return record ? json({ record }) : json({ record: null }, 404);
});

const getBatch = httpAction(async (ctx, request) => {
  let body: { serverIds?: unknown };
  try {
    body = (await request.json()) as { serverIds?: unknown };
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (
    !Array.isArray(body.serverIds) ||
    body.serverIds.length > MAX_BATCH_SIZE ||
    body.serverIds.some((serverId) => typeof serverId !== "string")
  ) {
    return json({ error: `serverIds must contain at most ${MAX_BATCH_SIZE} strings.` }, 400);
  }
  const serverIds = [...new Set(body.serverIds as string[])];
  const records = await ctx.runQuery(api.rendezvous.getBatch, {
    serverIds,
    now: Date.now(),
  });
  return json({ records });
});

const putRecord = httpAction(async (ctx, request) => {
  const serverId = serverIdFromPath(request);
  if (!serverId) {
    return json({ error: "Invalid server id." }, 400);
  }
  const secret = bearerSecret(request);
  if (!secret) {
    return json({ error: "A valid rendezvous bearer secret is required." }, 401);
  }
  let body: { version?: unknown; ciphertext?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (
    body.version !== 1 ||
    typeof body.ciphertext !== "string" ||
    !CIPHERTEXT_PATTERN.test(body.ciphertext)
  ) {
    return json({ error: "Invalid encrypted rendezvous record." }, 400);
  }
  const result = await ctx.runMutation(api.rendezvous.claimAndPut, {
    serverId,
    secretHash: await sha256Base64Url(secret),
    ciphertext: body.ciphertext,
    ttlSeconds: RECORD_TTL_SECONDS,
  });
  if (result.result === "forbidden") {
    return json({ error: "This server identity is already claimed." }, 403);
  }
  return json({ ok: true, record: result.record });
});

const http = httpRouter();
http.route({ pathPrefix: "/rendezvous/", method: "GET", handler: getRecord });
http.route({ pathPrefix: "/rendezvous/", method: "PUT", handler: putRecord });
http.route({ pathPrefix: "/rendezvous/", method: "OPTIONS", handler: options });
http.route({ path: "/rendezvous/batch", method: "POST", handler: getBatch });
http.route({ path: "/rendezvous/batch", method: "OPTIONS", handler: options });

export default http;
