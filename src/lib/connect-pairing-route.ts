import { createHash } from "node:crypto";
import { MemoryRateLimiter } from "./rendezvous-store";

/**
 * Engine-facing facade for the one-link pairing flow (`/api/connect/*`).
 *
 * The engine only knows the web app origin (the same one it publishes
 * rendezvous records to), so it talks to these routes; the routes forward to
 * the Convex `pairings` functions. The engine's poll secret is hashed here -
 * Convex only ever stores and compares the hash.
 */

export const PAIRING_CODE_PATTERN = /^[a-z0-9]{20,64}$/;
const POLL_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const FINGERPRINT_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;

export type PairingCreateInput = {
  code: string;
  pollSecretHash: string;
  serverId: string;
  fingerprint: string;
  label: string;
  publicUrl: string;
  ttlMs?: number;
};

export type PairingStatusResult = {
  status: "pending" | "approved" | "expired" | "unknown";
  expiresAt: number | null;
  approvedBy: { email: string | null; name: string | null } | null;
};

export interface PairingCloud {
  create(input: PairingCreateInput): Promise<{ ok: true; expiresAt: number }>;
  status(input: { code: string; pollSecretHash: string; now: number }): Promise<PairingStatusResult>;
}

const limiter = new MemoryRateLimiter();

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function clientRateKey(request: Request, operation: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const subject = forwarded || realIp || "unknown";
  return `${operation}:${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
}

export function hashPollSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function bearerPollSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }
  const secret = authorization.slice("Bearer ".length).trim();
  return POLL_SECRET_PATTERN.test(secret) ? secret : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Convex wraps thrown errors as "[Request ID: ...] Server Error\nUncaught Error: <message>".
    const match = error.message.match(/Uncaught Error: ([^\n]+)/);
    return match?.[1]?.trim() || error.message;
  }
  return String(error);
}

/**
 * `POST /api/connect/pairings` - engine registers a pending pairing.
 * Body: `{ code, pollSecret, serverId, fingerprint, label, publicUrl, ttlMs? }`.
 */
export async function handlePairingCreate(
  cloud: PairingCloud,
  request: Request
): Promise<Response> {
  if (!limiter.consume(clientRateKey(request, "pairing-create"), 30, 60)) {
    return json({ error: "Too many pairing requests." }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  const pollSecret = typeof body.pollSecret === "string" ? body.pollSecret.trim() : "";
  const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const publicUrl = typeof body.publicUrl === "string" ? body.publicUrl.trim() : "";
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return json({ error: "Invalid pairing code." }, 400);
  }
  if (!POLL_SECRET_PATTERN.test(pollSecret)) {
    return json({ error: "Invalid poll secret." }, 400);
  }
  if (!SERVER_ID_PATTERN.test(serverId)) {
    return json({ error: "Invalid server id." }, 400);
  }
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    return json({ error: "Invalid engine fingerprint." }, 400);
  }
  if (!publicUrl) {
    return json({ error: "Engine public URL is required." }, 400);
  }
  try {
    const result = await cloud.create({
      code,
      pollSecretHash: hashPollSecret(pollSecret),
      serverId,
      fingerprint,
      label,
      publicUrl,
      ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
    });
    return json({ ok: true, code, expiresAt: result.expiresAt }, 201);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

/**
 * `GET /api/connect/pairings/<code>` with `Authorization: Bearer <pollSecret>`
 * - engine polls whether (and by whom) the pairing was approved.
 */
export async function handlePairingStatus(
  cloud: PairingCloud,
  request: Request,
  rawCode: string,
  now = Date.now()
): Promise<Response> {
  if (!limiter.consume(clientRateKey(request, "pairing-status"), 240, 60)) {
    return json({ error: "Too many pairing status requests." }, 429);
  }
  const code = rawCode.trim().toLowerCase();
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return json({ error: "Invalid pairing code." }, 400);
  }
  const pollSecret = bearerPollSecret(request);
  if (!pollSecret) {
    return json({ error: "A valid pairing poll secret is required." }, 401);
  }
  try {
    const result = await cloud.status({
      code,
      pollSecretHash: hashPollSecret(pollSecret),
      now,
    });
    return json(result, result.status === "unknown" ? 404 : 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 502);
  }
}
