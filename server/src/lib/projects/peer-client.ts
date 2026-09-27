import type { ProjectAgentDelivery } from "@cesium/core/projects";
import type {
  ChildCreateInput,
  ChildCreateResult,
  ChildObservation,
  ChildRef,
  ChildTurnDigest,
  ChildUpdatePatch,
} from "./child-host.js";
import type { ContextManifestEntry } from "./context-sync.js";

/** Wire shapes of the peer API (`/api/projects/peer/*`). */

export type PeerHarnessInfo = {
  id: string;
  label: string;
  available: boolean;
  defaultModelId: string;
};

export type PeerWorkspaceInfo = { id: string; name: string; root: string };

export type PeerInfo = {
  instanceId: string;
  label: string;
  tokenId: string;
  harnesses: PeerHarnessInfo[];
  workspaces: PeerWorkspaceInfo[];
};

export type PeerCreateChildBody = Omit<ChildCreateInput, "peerTokenId" | "placement"> & {
  placement: Exclude<ChildCreateInput["placement"], { kind: "root" }>;
};

export class PeerRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the peer could not be reached. */
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "PeerRequestError";
  }
}

export type PeerConnection = { baseUrl: string; token: string; label: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/** Canonical `http(s)://host[:port][/prefix]` with no trailing slash, or null. */
export function normalizePeerBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function childPath(ref: ChildRef, suffix = ""): string {
  return `/api/projects/peer/children/${encodeURIComponent(ref.workspaceId)}/${encodeURIComponent(ref.conversationId)}${suffix}`;
}

const TRANSFER_TIMEOUT_MS = 120_000;

async function peerFetch(
  peer: PeerConnection,
  method: string,
  pathname: string,
  init: { body?: BodyInit; contentType?: string; accept: string },
  timeoutMs: number
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${peer.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${peer.token}`,
        accept: init.accept,
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new PeerRequestError(`Engine "${peer.label}" is unreachable (${reason}).`, 0, "peer_unreachable");
  }
  if (!response.ok) {
    const text = await response.text();
    let record: Record<string, unknown> = {};
    try {
      const parsed = text ? (JSON.parse(text) as unknown) : null;
      record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      record = {};
    }
    const message =
      typeof record.error === "string" && record.error.trim()
        ? record.error
        : `HTTP ${response.status}`;
    const code =
      typeof record.code === "string" && record.code
        ? record.code
        : response.status === 401
          ? "peer_token_invalid"
          : "peer_error";
    throw new PeerRequestError(`Engine "${peer.label}": ${message}`, response.status, code);
  }
  return response;
}

export async function peerRequest<T>(
  peer: PeerConnection,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const response = await peerFetch(
    peer,
    method,
    pathname,
    {
      accept: "application/json",
      ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: "application/json" }),
    },
    timeoutMs
  );
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    return null as T;
  }
}

function contextPath(projectId: string, suffix: string): string {
  return `/api/projects/peer/context/${encodeURIComponent(projectId)}${suffix}`;
}

/** Typed calls against one peer engine. */
export class PeerClient {
  constructor(private readonly peer: PeerConnection) {}

  info(timeoutMs?: number): Promise<PeerInfo> {
    return peerRequest<PeerInfo>(this.peer, "GET", "/api/projects/peer/info", undefined, timeoutMs);
  }

  async registerWorkspace(root: string): Promise<PeerWorkspaceInfo> {
    const result = await peerRequest<{ workspace: PeerWorkspaceInfo }>(
      this.peer,
      "POST",
      "/api/projects/peer/workspaces",
      { root }
    );
    return result.workspace;
  }

  createChild(body: PeerCreateChildBody): Promise<ChildCreateResult> {
    return peerRequest<ChildCreateResult>(this.peer, "POST", "/api/projects/peer/children", body);
  }

  observe(ref: ChildRef): Promise<ChildObservation> {
    return peerRequest<ChildObservation>(this.peer, "GET", childPath(ref));
  }

  digest(ref: ChildRef, afterSeq: number, throughSeq: number): Promise<ChildTurnDigest> {
    return peerRequest<ChildTurnDigest>(
      this.peer,
      "GET",
      childPath(ref, `/digest?after=${afterSeq}&through=${throughSeq}`)
    );
  }

  async transcript(ref: ChildRef, turns: number): Promise<string> {
    const result = await peerRequest<{ transcript: string }>(
      this.peer,
      "GET",
      childPath(ref, `/transcript?turns=${turns}`)
    );
    return result.transcript;
  }

  async message(
    ref: ChildRef,
    text: string,
    delivery: "steer" | "queue"
  ): Promise<ProjectAgentDelivery> {
    const result = await peerRequest<{ delivery: ProjectAgentDelivery }>(
      this.peer,
      "POST",
      childPath(ref, "/messages"),
      { text, delivery }
    );
    return result.delivery;
  }

  async stop(ref: ChildRef): Promise<void> {
    await peerRequest(this.peer, "POST", childPath(ref, "/stop"), {});
  }

  async update(ref: ChildRef, patch: ChildUpdatePatch): Promise<void> {
    await peerRequest(this.peer, "PATCH", childPath(ref), patch);
  }

  async delete(ref: ChildRef, keepWorkspace = false): Promise<void> {
    await peerRequest(this.peer, "DELETE", childPath(ref, keepWorkspace ? "?keepWorkspace=1" : ""));
  }

  /** The peer's mirror of a Project context: every file with its hash. */
  async contextManifest(projectId: string): Promise<ContextManifestEntry[]> {
    const result = await peerRequest<{ files: ContextManifestEntry[] }>(
      this.peer,
      "GET",
      contextPath(projectId, "/manifest"),
      undefined,
      TRANSFER_TIMEOUT_MS
    );
    return result.files;
  }

  async readContextFile(projectId: string, filePath: string): Promise<Buffer> {
    const response = await peerFetch(
      this.peer,
      "GET",
      contextPath(projectId, `/file?path=${encodeURIComponent(filePath)}`),
      { accept: "application/octet-stream" },
      TRANSFER_TIMEOUT_MS
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async writeContextFile(projectId: string, filePath: string, bytes: Uint8Array, mtimeMs: number): Promise<void> {
    await peerFetch(
      this.peer,
      "PUT",
      contextPath(projectId, `/file?path=${encodeURIComponent(filePath)}&mtime=${Math.round(mtimeMs)}`),
      { body: new Uint8Array(bytes), contentType: "application/octet-stream", accept: "application/json" },
      TRANSFER_TIMEOUT_MS
    );
  }

  async deleteContextFile(projectId: string, filePath: string): Promise<void> {
    await peerRequest(this.peer, "DELETE", contextPath(projectId, `/file?path=${encodeURIComponent(filePath)}`));
  }

  async deleteContextMirror(projectId: string): Promise<void> {
    await peerRequest(this.peer, "DELETE", contextPath(projectId, ""));
  }
}
