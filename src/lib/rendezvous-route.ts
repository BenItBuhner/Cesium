import { createHash } from "node:crypto";
import type { RendezvousRecord, RendezvousStore } from "./rendezvous-store";

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,4096}$/;
const RECORD_TTL_SECONDS = 90;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function validServerId(serverId: string): boolean {
  return SERVER_ID_PATTERN.test(serverId);
}

function clientRateKey(request: Request, operation: "read" | "write"): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const subject = forwarded || realIp || "unknown";
  return `${operation}:${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
}

function bearerSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }
  const secret = authorization.slice("Bearer ".length).trim();
  return SECRET_PATTERN.test(secret) ? secret : null;
}

export async function handleRendezvousGet(
  store: RendezvousStore,
  request: Request,
  serverId: string,
  now = Date.now()
): Promise<Response> {
  if (!validServerId(serverId)) {
    return json({ error: "Invalid server id." }, 400);
  }
  const allowed = await store.consumeRateLimit(clientRateKey(request, "read"), 180, 60);
  if (!allowed) {
    return json({ error: "Too many rendezvous requests." }, 429);
  }
  const record = await store.get(serverId);
  if (!record || record.expiresAt <= now) {
    return json({ record: null }, 404);
  }
  return json({ record });
}

export async function handleRendezvousPut(
  store: RendezvousStore,
  request: Request,
  serverId: string,
  now = Date.now()
): Promise<Response> {
  if (!validServerId(serverId)) {
    return json({ error: "Invalid server id." }, 400);
  }
  const secret = bearerSecret(request);
  if (!secret) {
    return json({ error: "A valid rendezvous bearer secret is required." }, 401);
  }
  const allowed = await store.consumeRateLimit(clientRateKey(request, "write"), 90, 60);
  if (!allowed) {
    return json({ error: "Too many rendezvous updates." }, 429);
  }

  let payload: { version?: unknown; ciphertext?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (
    payload.version !== 1 ||
    typeof payload.ciphertext !== "string" ||
    !CIPHERTEXT_PATTERN.test(payload.ciphertext)
  ) {
    return json({ error: "Invalid encrypted rendezvous record." }, 400);
  }

  const record: RendezvousRecord = {
    version: 1,
    serverId,
    ciphertext: payload.ciphertext,
    updatedAt: now,
    expiresAt: now + RECORD_TTL_SECONDS * 1000,
  };
  const secretHash = createHash("sha256").update(secret).digest("base64url");
  const result = await store.claimAndPut(
    serverId,
    secretHash,
    record,
    RECORD_TTL_SECONDS
  );
  if (result === "forbidden") {
    return json({ error: "This server identity is already claimed." }, 403);
  }
  return json({ ok: true, record });
}
