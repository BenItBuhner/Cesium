import type { ProjectAgentDelivery } from "@cesium/core/projects";
import type {
  ChildCreateInput,
  ChildCreateResult,
  ChildObservation,
  ChildRef,
  ChildTurnDigest,
  ChildUpdatePatch,
} from "./child-host.js";

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

export async function peerRequest<T>(
  peer: PeerConnection,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${peer.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${peer.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
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
  return payload as T;
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

  async delete(ref: ChildRef): Promise<void> {
    await peerRequest(this.peer, "DELETE", childPath(ref));
  }
}
