import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_HOME_ENGINE_ID,
  projectEngineName,
  type ProjectEngineSummary,
} from "@cesium/core/projects";
import { getEngineInstanceId } from "../engine-instance.js";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { openSecretSync, sealSecretSync } from "../secret-envelope-node.js";
import { getSecretWrappingKeySync } from "../secret-wrapping-key.js";
import { ProjectError } from "./errors.js";
import { getProjectsRootDir } from "./paths.js";
import {
  PeerClient,
  PeerRequestError,
  normalizePeerBaseUrl,
  type PeerConnection,
  type PeerInfo,
} from "./peer-client.js";

/**
 * Peer engines this engine can place Project agents on. Each entry holds a
 * token minted on the peer, sealed with this engine's secret wrapping key.
 */

const TOKEN_SEAL_PURPOSE = "projects.peer-engine-token";
const VERIFY_TIMEOUT_MS = 10_000;

type PeerEngineRecord = {
  id: string;
  label: string;
  baseUrl: string;
  sealedToken: string;
  instanceId: string;
  tokenId: string;
  addedAt: number;
};

type EngineFile = { engines: PeerEngineRecord[] };

export type PeerEngine = PeerEngineRecord & { connection: PeerConnection };

type LiveStatus = { online: boolean; error: string | null; lastSeenAt: number | null };

let cache: PeerEngineRecord[] | null = null;
let lock: Promise<unknown> = Promise.resolve();
const liveStatus = new Map<string, LiveStatus>();

function enginesPath(): string {
  return path.join(getProjectsRootDir(), "engines.json");
}

async function load(): Promise<PeerEngineRecord[]> {
  if (cache) {
    return cache;
  }
  const file = await readJsonFile<Partial<EngineFile>>(enginesPath(), {});
  cache = Array.isArray(file.engines)
    ? file.engines.filter(
        (entry): entry is PeerEngineRecord =>
          Boolean(entry) &&
          typeof entry.id === "string" &&
          typeof entry.baseUrl === "string" &&
          typeof entry.sealedToken === "string"
      )
    : [];
  return cache;
}

async function save(engines: PeerEngineRecord[]): Promise<void> {
  cache = engines;
  await writeJsonFile(enginesPath(), { engines } satisfies EngineFile);
  await fs.chmod(enginesPath(), 0o600).catch(() => undefined);
}

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const next = lock.catch(() => undefined).then(task);
  lock = next;
  return next;
}

function hydrate(record: PeerEngineRecord): PeerEngine {
  const token = openSecretSync(record.sealedToken, getSecretWrappingKeySync(), TOKEN_SEAL_PURPOSE);
  return {
    ...record,
    connection: { baseUrl: record.baseUrl, token: token ?? "", label: record.label },
  };
}

export async function listPeerEngines(): Promise<PeerEngine[]> {
  return (await load()).map(hydrate);
}

export async function getPeerEngine(engineId: string): Promise<PeerEngine | null> {
  const record = (await load()).find((entry) => entry.id === engineId);
  return record ? hydrate(record) : null;
}

/** Records the outcome of a call to a peer so summaries can show it without a network hop. */
export function notePeerEngineContact(engineId: string, error: unknown): void {
  const previous = liveStatus.get(engineId);
  if (error == null) {
    liveStatus.set(engineId, { online: true, error: null, lastSeenAt: Date.now() });
    return;
  }
  if (error instanceof PeerRequestError && error.status !== 0 && error.code !== "peer_token_invalid") {
    // The peer answered; only this call failed.
    liveStatus.set(engineId, { online: true, error: null, lastSeenAt: Date.now() });
    return;
  }
  liveStatus.set(engineId, {
    online: false,
    error: error instanceof Error ? error.message : String(error),
    lastSeenAt: previous?.lastSeenAt ?? null,
  });
}

/** False only after a failed contact; engines not tried yet count as reachable. */
export function isPeerEngineReachable(engineId: string): boolean {
  return liveStatus.get(engineId)?.online ?? true;
}

/** Runs `task` against a registered peer and records whether it answered. */
export async function callPeerEngine<T>(
  engineId: string,
  task: (client: PeerClient) => Promise<T>
): Promise<T> {
  const engine = await getPeerEngine(engineId);
  if (!engine) {
    throw new ProjectError(`Engine "${engineId}" is not connected to this engine.`, 400, "engine_not_found");
  }
  if (!engine.connection.token) {
    throw new ProjectError(
      `The stored token for engine "${engine.label}" cannot be read (was the secret key changed?). Pair the engine again.`,
      502,
      "peer_token_unreadable"
    );
  }
  try {
    const result = await task(new PeerClient(engine.connection));
    notePeerEngineContact(engineId, null);
    return result;
  } catch (error) {
    notePeerEngineContact(engineId, error);
    throw error;
  }
}

export function homeEngineLabel(): string {
  return process.env.CESIUM_ENGINE_LABEL?.trim() || os.hostname() || "This engine";
}

export function homeEngineSummary(): ProjectEngineSummary {
  return {
    id: PROJECT_HOME_ENGINE_ID,
    label: homeEngineLabel(),
    kind: "home",
    baseUrl: null,
    online: true,
    error: null,
    instanceId: getEngineInstanceId(),
    lastSeenAt: Date.now(),
  };
}

/** This engine first, then every registered peer with its last known status. */
export async function listEngineSummaries(): Promise<ProjectEngineSummary[]> {
  return [homeEngineSummary(), ...(await load()).map(peerEngineSummary)];
}

/**
 * Resolves an engine reference to an engine id: an id, a case-insensitive
 * label, or the "Label (id)" form `projectEngineName` uses for shared labels.
 */
export async function resolveEngineRef(ref: string | null | undefined): Promise<string> {
  const wanted = ref?.trim() ?? "";
  if (!wanted || wanted === PROJECT_HOME_ENGINE_ID) {
    return PROJECT_HOME_ENGINE_ID;
  }
  const idInName = wanted.match(/\(([^()]+)\)$/)?.[1]?.trim();
  if (idInName === PROJECT_HOME_ENGINE_ID) {
    return PROJECT_HOME_ENGINE_ID;
  }
  const lowered = wanted.toLowerCase();
  const engines = await load();
  const match =
    engines.find((entry) => entry.id === wanted || entry.id === idInName) ??
    engines.find((entry) => entry.label.toLowerCase() === lowered);
  if (match) {
    return match.id;
  }
  if (homeEngineLabel().toLowerCase() === lowered) {
    return PROJECT_HOME_ENGINE_ID;
  }
  const summaries = await listEngineSummaries();
  const known = summaries.map((engine) => projectEngineName(engine.id, summaries));
  throw new ProjectError(`Unknown engine "${wanted}". Engines: ${known.join(", ")}.`, 400, "engine_not_found");
}

/** `projectEngineName` against this engine's current registry. */
export async function engineNameFor(engineId: string): Promise<string> {
  return projectEngineName(engineId, await listEngineSummaries());
}

export function peerEngineSummary(engine: PeerEngineRecord): ProjectEngineSummary {
  const status = liveStatus.get(engine.id);
  return {
    id: engine.id,
    label: engine.label,
    kind: "peer",
    baseUrl: engine.baseUrl,
    online: status?.online ?? true,
    error: status?.error ?? null,
    instanceId: engine.instanceId,
    lastSeenAt: status?.lastSeenAt ?? null,
  };
}

/**
 * Verifies the token against the peer and stores it. Registering the same
 * peer instance again replaces its URL, label and token (re-pairing).
 */
export async function registerPeerEngine(input: {
  baseUrl: string;
  token: string;
  label?: string | null;
}): Promise<{ engine: ProjectEngineSummary; info: PeerInfo }> {
  const baseUrl = normalizePeerBaseUrl(input.baseUrl ?? "");
  if (!baseUrl) {
    throw new ProjectError("Engine URL must be an http(s) URL without credentials, e.g. http://laptop:9100.");
  }
  const token = input.token?.trim() ?? "";
  if (!token) {
    throw new ProjectError("A peer token minted on that engine is required.");
  }
  const provisionalLabel = input.label?.trim() || new URL(baseUrl).host;
  let info: PeerInfo;
  try {
    info = await new PeerClient({ baseUrl, token, label: provisionalLabel }).info(VERIFY_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof PeerRequestError && error.status === 401) {
      throw new ProjectError(
        `That engine rejected the token. Mint a new one on it and try again.`,
        400,
        "peer_token_invalid"
      );
    }
    if (error instanceof PeerRequestError && error.status === 404) {
      throw new ProjectError(
        `${baseUrl} does not serve the Projects peer API. Update that engine and try again.`,
        400,
        "peer_unsupported"
      );
    }
    throw new ProjectError(
      error instanceof Error ? error.message : String(error),
      400,
      "peer_unreachable"
    );
  }
  if (info.instanceId === getEngineInstanceId()) {
    throw new ProjectError("That URL points at this engine; it is already the home engine.");
  }
  const label = (input.label?.trim() || info.label || provisionalLabel).slice(0, 80);
  const sealedToken = sealSecretSync(token, getSecretWrappingKeySync(), TOKEN_SEAL_PURPOSE);
  const record = await withLock(async () => {
    const engines = await load();
    const existing = engines.find((entry) => entry.instanceId === info.instanceId);
    const next: PeerEngineRecord = {
      id: existing?.id ?? `eng_${randomBytes(4).toString("hex")}`,
      label,
      baseUrl,
      sealedToken,
      instanceId: info.instanceId,
      tokenId: info.tokenId,
      addedAt: existing?.addedAt ?? Date.now(),
    };
    await save(
      existing
        ? engines.map((entry) => (entry.id === existing.id ? next : entry))
        : [...engines, next]
    );
    return next;
  });
  notePeerEngineContact(record.id, null);
  return { engine: peerEngineSummary(record), info };
}

export function removePeerEngine(engineId: string): Promise<boolean> {
  return withLock(async () => {
    const engines = await load();
    const remaining = engines.filter((entry) => entry.id !== engineId);
    if (remaining.length === engines.length) {
      return false;
    }
    await save(remaining);
    liveStatus.delete(engineId);
    return true;
  });
}
