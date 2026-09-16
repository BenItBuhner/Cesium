import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PublicAccessError, publicAccessManager } from "./public-access-manager.js";

/**
 * Engine side of the one-link "attach to account" flow.
 *
 * `cesium-server connect` asks this manager for a pairing: a short-lived,
 * unguessable code that the engine registers with the account site (the same
 * web origin it publishes rendezvous records to) and prints as
 * `https://<web>/connect/<code>`. A signed-in browser opening that link
 * presents the code back to the engine (`POST /api/pairing/claim`) and, once,
 * receives the engine credential plus the rendezvous locator - so the
 * password never travels through the cloud or the URL. The manager then
 * learns the outcome from the claim itself and from polling the cloud record.
 */

export type EnginePairingStatus = "pending" | "claimed" | "attached" | "expired" | "cancelled";

export type EnginePairingAccount = { email: string | null; name: string | null };

export type EnginePairingView = {
  code: string;
  connectUrl: string;
  fingerprint: string;
  label: string;
  publicUrl: string;
  webAppOrigin: string;
  status: EnginePairingStatus;
  createdAt: number;
  expiresAt: number;
  claimedAt: number | null;
  attachedAt: number | null;
  /** Account the approving browser reported (informational, unverified). */
  claimedBy: EnginePairingAccount | null;
  /** Account the cloud recorded as the approver (authoritative). */
  attachedBy: EnginePairingAccount | null;
};

export type EnginePairingClaimResult = {
  serverId: string;
  label: string;
  fingerprint: string;
  publicUrl: string;
  rendezvous: {
    version: 1;
    serverId: string;
    secret: string;
    registryBaseUrl: string;
  };
  auth: { username: string; password: string };
};

export type EnginePairingContext = {
  serverId: string;
  rendezvousReadSecret: string;
  webAppOrigin: string;
  publicUrl: string;
  label: string;
};

type PairingRecord = Omit<EnginePairingView, "status"> & {
  pollSecret: string;
  status: EnginePairingStatus;
  lastCloudPollAt: number;
};

type EnginePairingManagerDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  getContext?: () => Promise<EnginePairingContext | null>;
  getCredentials?: () => { username: string; password: string } | null;
  /** Minimum spacing between cloud status polls per pairing. */
  cloudPollIntervalMs?: number;
};

export const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const MIN_PAIRING_TTL_MS = 60_000;
const MAX_PAIRING_TTL_MS = 15 * 60_000;
/** Lowercase base32 without the ambiguous i/l/o/0/1 - reads fine off a screen. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 26;
export const PAIRING_CODE_PATTERN = /^[a-z0-9]{20,64}$/;

/**
 * Stable per-install fingerprint shown in the terminal and on the approval
 * page so a user can eyeball that both sides talk about the same engine.
 */
export function engineFingerprint(serverId: string): string {
  const digest = createHash("sha256")
    .update(`cesium-engine-fingerprint\0${serverId}`)
    .digest("hex")
    .toUpperCase();
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

export function buildConnectUrl(webAppOrigin: string, code: string): string {
  return `${webAppOrigin.replace(/\/+$/, "")}/connect/${code}`;
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH * 2);
  let out = "";
  for (let index = 0; out.length < CODE_LENGTH && index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    // Rejection sampling keeps every alphabet character equally likely.
    if (byte < CODE_ALPHABET.length * 8) {
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out.length === CODE_LENGTH ? out : randomCode();
}

function safeCodeEquals(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function normalizeAccount(value: unknown): EnginePairingAccount | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as { email?: unknown; name?: unknown };
  const email = typeof input.email === "string" ? input.email.trim().slice(0, 200) : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
  if (!email && !name) {
    return null;
  }
  return { email: email || null, name: name || null };
}

async function defaultGetContext(): Promise<EnginePairingContext | null> {
  return await publicAccessManager.getPairingContext();
}

function defaultGetCredentials(): { username: string; password: string } | null {
  const username = process.env.OPENCURSOR_AUTH_USERNAME?.trim();
  const password = process.env.OPENCURSOR_AUTH_PASSWORD?.trim();
  return username && password ? { username, password } : null;
}

export class EnginePairingManager {
  private pairings = new Map<string, PairingRecord>();

  constructor(private readonly deps: EnginePairingManagerDeps = {}) {}

  /** Register a fresh pairing (superseding any pending one) and return its link. */
  async start(input: { ttlMs?: number } = {}): Promise<EnginePairingView> {
    const context = await this.getContext();
    if (!context) {
      throw new PublicAccessError(
        "Public access is not running, so there is no reachable URL to attach. Enable public access (or run `cesium-server run`) first.",
        409
      );
    }
    if (!this.getCredentials()) {
      throw new PublicAccessError(
        "Engine authentication is off; an account cannot be attached to an open engine.",
        409
      );
    }
    const now = this.now();
    const ttlMs = Math.min(
      MAX_PAIRING_TTL_MS,
      Math.max(
        MIN_PAIRING_TTL_MS,
        typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
          ? input.ttlMs
          : DEFAULT_PAIRING_TTL_MS
      )
    );
    const code = randomCode();
    const pollSecret = randomBytes(32).toString("base64url");
    const fingerprint = engineFingerprint(context.serverId);
    const endpoint = `${context.webAppOrigin}/api/connect/pairings`;
    let response: Response;
    try {
      response = await this.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          pollSecret,
          serverId: context.serverId,
          fingerprint,
          label: context.label,
          publicUrl: context.publicUrl,
          ttlMs,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new PublicAccessError(
        `Could not reach ${context.webAppOrigin} to register the connect link: ${
          error instanceof Error ? error.message : String(error)
        }`,
        502
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new PublicAccessError(
        typeof payload?.error === "string"
          ? payload.error
          : `Registering the connect link failed (${response.status}).`,
        502
      );
    }
    const payload = (await response.json().catch(() => null)) as { expiresAt?: unknown } | null;
    const expiresAt =
      typeof payload?.expiresAt === "number" && Number.isFinite(payload.expiresAt)
        ? payload.expiresAt
        : now + ttlMs;
    for (const [existingCode, record] of this.pairings) {
      if (record.status === "pending") {
        record.status = "cancelled";
      }
      if (record.expiresAt + MAX_PAIRING_TTL_MS < now) {
        this.pairings.delete(existingCode);
      }
    }
    const record: PairingRecord = {
      code,
      pollSecret,
      connectUrl: buildConnectUrl(context.webAppOrigin, code),
      fingerprint,
      label: context.label,
      publicUrl: context.publicUrl,
      webAppOrigin: context.webAppOrigin,
      status: "pending",
      createdAt: now,
      expiresAt,
      claimedAt: null,
      attachedAt: null,
      claimedBy: null,
      attachedBy: null,
      lastCloudPollAt: 0,
    };
    this.pairings.set(code, record);
    return this.view(record);
  }

  /**
   * The approving browser redeems the code. Exactly one claim succeeds; the
   * response is the only place the engine credential ever leaves this
   * process for the pairing flow.
   */
  async claim(rawCode: unknown, account?: unknown): Promise<EnginePairingClaimResult> {
    const code = typeof rawCode === "string" ? rawCode.trim().toLowerCase() : "";
    if (!PAIRING_CODE_PATTERN.test(code)) {
      throw new PublicAccessError("Invalid connect code.", 400);
    }
    const record = this.find(code);
    const now = this.now();
    if (!record || record.status === "cancelled") {
      throw new PublicAccessError(
        "This connect link is not known to the engine. Run `cesium-server connect` again.",
        404
      );
    }
    if (record.expiresAt <= now) {
      record.status = "expired";
      throw new PublicAccessError(
        "This connect link expired. Run `cesium-server connect` for a fresh one.",
        410
      );
    }
    if (record.status !== "pending") {
      throw new PublicAccessError(
        "This connect link was already used. Run `cesium-server connect` for a fresh one.",
        409
      );
    }
    const context = await this.getContext();
    const credentials = this.getCredentials();
    if (!context || !credentials) {
      throw new PublicAccessError("The engine is no longer exposing a public URL.", 409);
    }
    record.status = "claimed";
    record.claimedAt = now;
    record.claimedBy = normalizeAccount(account);
    return {
      serverId: context.serverId,
      label: context.label,
      fingerprint: record.fingerprint,
      publicUrl: context.publicUrl,
      rendezvous: {
        version: 1,
        serverId: context.serverId,
        secret: context.rendezvousReadSecret,
        registryBaseUrl: context.webAppOrigin,
      },
      auth: credentials,
    };
  }

  /** Local view, refreshed from the cloud record when a decision is still open. */
  async status(rawCode: string): Promise<EnginePairingView> {
    const code = rawCode.trim().toLowerCase();
    const record = PAIRING_CODE_PATTERN.test(code) ? this.pairings.get(code) : undefined;
    if (!record) {
      throw new PublicAccessError("Unknown connect code.", 404);
    }
    const now = this.now();
    if (record.status === "pending" && record.expiresAt <= now) {
      record.status = "expired";
    }
    if (
      (record.status === "pending" || record.status === "claimed") &&
      now - record.lastCloudPollAt >= this.cloudPollIntervalMs
    ) {
      record.lastCloudPollAt = now;
      await this.refreshFromCloud(record);
    }
    return this.view(record);
  }

  cancel(rawCode: string): boolean {
    const code = rawCode.trim().toLowerCase();
    const record = PAIRING_CODE_PATTERN.test(code) ? this.pairings.get(code) : undefined;
    if (!record || record.status === "attached") {
      return false;
    }
    record.status = "cancelled";
    return true;
  }

  resetForTests(): void {
    this.pairings.clear();
  }

  private async refreshFromCloud(record: PairingRecord): Promise<void> {
    try {
      const response = await this.fetch(
        `${record.webAppOrigin}/api/connect/pairings/${encodeURIComponent(record.code)}`,
        {
          headers: { Authorization: `Bearer ${record.pollSecret}` },
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!response.ok) {
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        status?: unknown;
        approvedBy?: unknown;
      } | null;
      if (payload?.status === "approved") {
        record.status = "attached";
        record.attachedAt = record.attachedAt ?? this.now();
        record.attachedBy = normalizeAccount(payload.approvedBy) ?? record.claimedBy;
      } else if (payload?.status === "expired" && record.status === "pending") {
        record.status = "expired";
      }
    } catch {
      // The local claim already tells us the credential was handed over; the
      // cloud confirmation is best-effort and the next poll retries.
    }
  }

  private find(code: string): PairingRecord | undefined {
    for (const [candidate, record] of this.pairings) {
      if (safeCodeEquals(candidate, code)) {
        return record;
      }
    }
    return undefined;
  }

  private view(record: PairingRecord): EnginePairingView {
    return {
      code: record.code,
      connectUrl: record.connectUrl,
      fingerprint: record.fingerprint,
      label: record.label,
      publicUrl: record.publicUrl,
      webAppOrigin: record.webAppOrigin,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      claimedAt: record.claimedAt,
      attachedAt: record.attachedAt,
      claimedBy: record.claimedBy,
      attachedBy: record.attachedBy,
    };
  }

  private get fetch(): typeof fetch {
    return this.deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private getContext(): Promise<EnginePairingContext | null> {
    return (this.deps.getContext ?? defaultGetContext)();
  }

  private getCredentials(): { username: string; password: string } | null {
    return (this.deps.getCredentials ?? defaultGetCredentials)();
  }

  private get cloudPollIntervalMs(): number {
    return this.deps.cloudPollIntervalMs ?? 2_000;
  }
}

export const enginePairingManager = new EnginePairingManager();

export function createEnginePairingManagerForTests(
  deps: EnginePairingManagerDeps
): EnginePairingManager {
  return new EnginePairingManager(deps);
}
