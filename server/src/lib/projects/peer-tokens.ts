import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectPeerTokenSummary } from "@cesium/core/projects";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { getProjectsRootDir } from "./paths.js";

/**
 * Tokens minted on this engine that let another engine (a Project's home)
 * create and drive Project agents here. Only hashes are stored.
 */

export const PEER_TOKEN_PREFIX = "cpk_";
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

type PeerTokenRecord = ProjectPeerTokenSummary & { hash: string };
type PeerTokenFile = { tokens: PeerTokenRecord[] };

let cache: PeerTokenRecord[] | null = null;
let lock: Promise<unknown> = Promise.resolve();

function peerTokensPath(): string {
  return path.join(getProjectsRootDir(), "peer-tokens.json");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function load(): Promise<PeerTokenRecord[]> {
  if (cache) {
    return cache;
  }
  const file = await readJsonFile<Partial<PeerTokenFile>>(peerTokensPath(), {});
  cache = Array.isArray(file.tokens)
    ? file.tokens.filter(
        (entry): entry is PeerTokenRecord =>
          Boolean(entry) &&
          typeof entry.id === "string" &&
          typeof entry.hash === "string" &&
          typeof entry.label === "string"
      )
    : [];
  return cache;
}

async function save(tokens: PeerTokenRecord[]): Promise<void> {
  cache = tokens;
  await writeJsonFile(peerTokensPath(), { tokens } satisfies PeerTokenFile);
  await fs.chmod(peerTokensPath(), 0o600).catch(() => undefined);
}

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const next = lock.catch(() => undefined).then(task);
  lock = next;
  return next;
}

function summarize(record: PeerTokenRecord): ProjectPeerTokenSummary {
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/** Returns the new token's secret exactly once; only its hash is kept. */
export function mintPeerToken(
  label: string
): Promise<{ token: ProjectPeerTokenSummary; secret: string }> {
  return withLock(async () => {
    const secret = `${PEER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: PeerTokenRecord = {
      id: `ptk_${randomBytes(4).toString("hex")}`,
      label: label.trim().slice(0, 80) || "Project engine",
      createdAt: Date.now(),
      lastUsedAt: null,
      hash: hashToken(secret).toString("hex"),
    };
    await save([...(await load()), record]);
    return { token: summarize(record), secret };
  });
}

export async function listPeerTokens(): Promise<ProjectPeerTokenSummary[]> {
  return (await load()).map(summarize);
}

export function revokePeerToken(id: string): Promise<boolean> {
  return withLock(async () => {
    const tokens = await load();
    const remaining = tokens.filter((entry) => entry.id !== id);
    if (remaining.length === tokens.length) {
      return false;
    }
    await save(remaining);
    return true;
  });
}

/** Resolves the token record for a presented secret, or null. */
export async function verifyPeerToken(secret: string): Promise<ProjectPeerTokenSummary | null> {
  if (!secret.startsWith(PEER_TOKEN_PREFIX)) {
    return null;
  }
  const presented = hashToken(secret);
  const match = (await load()).find((entry) => {
    const stored = Buffer.from(entry.hash, "hex");
    return stored.length === presented.length && timingSafeEqual(stored, presented);
  });
  if (!match) {
    return null;
  }
  const now = Date.now();
  if (match.lastUsedAt == null || now - match.lastUsedAt > LAST_USED_WRITE_INTERVAL_MS) {
    void withLock(async () => {
      const tokens = await load();
      const index = tokens.findIndex((entry) => entry.id === match.id);
      if (index === -1) {
        return;
      }
      const next = [...tokens];
      next[index] = { ...tokens[index]!, lastUsedAt: now };
      await save(next);
    }).catch(() => undefined);
  }
  return summarize(match);
}
