import type { ProjectAgentDelivery } from "@cesium/core/projects";
import { PEER_INSTALL_WAIT_MS } from "../../browser-debug/chromium-install.js";
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

/** Which of the caller's context mirrors changed after its cursor. */
export type PeerContextChanges = {
  /** The peer's change feed; a new id (the peer restarted) means "sync everything". */
  feed: string;
  cursor: number;
  projects: string[];
  /** The caller's cursor is unknown to the peer: sync every Project. */
  reset: boolean;
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

/** A browser check's create can first wait out the peer's Chromium download. */
export function createChildTimeoutMs(body: Pick<PeerCreateChildBody, "helperBrief">): number {
  return body.helperBrief?.kind === "browser" ? PEER_INSTALL_WAIT_MS + DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

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
/** How much longer than its wait a request for context changes may take before it counts as unanswered. */
const CONTEXT_CHANGES_SLACK_MS = 15_000;

async function peerFetch(
  peer: PeerConnection,
  method: string,
  pathname: string,
  init: { body?: BodyInit; contentType?: string; accept: string; signal?: AbortSignal },
  timeoutMs: number
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
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
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<T> {
  const response = await peerFetch(
    peer,
    method,
    pathname,
    {
      accept: "application/json",
      ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: "application/json" }),
      ...(signal ? { signal } : {}),
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
    return peerRequest<ChildCreateResult>(
      this.peer,
      "POST",
      "/api/projects/peer/children",
      body,
      createChildTimeoutMs(body)
    );
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

  async reply(ref: ChildRef): Promise<string | null> {
    const result = await peerRequest<{ reply: string | null }>(this.peer, "GET", childPath(ref, "/reply"));
    return result.reply;
  }

  async changedFiles(ref: ChildRef, baseSha: string | null): Promise<string[] | null> {
    const query = baseSha ? `?base=${encodeURIComponent(baseSha)}` : "";
    const result = await peerRequest<{ files: string[] | null }>(this.peer, "GET", childPath(ref, `/changes${query}`));
    return result.files;
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

  /** With `ifMatch` (the hash the home listed, or "absent"), the peer refuses with 409 if its file changed since. */
  async writeContextFile(
    projectId: string,
    filePath: string,
    bytes: Uint8Array,
    mtimeMs: number,
    ifMatch?: string
  ): Promise<void> {
    const match = ifMatch ? `&ifMatch=${encodeURIComponent(ifMatch)}` : "";
    await peerFetch(
      this.peer,
      "PUT",
      contextPath(projectId, `/file?path=${encodeURIComponent(filePath)}&mtime=${Math.round(mtimeMs)}${match}`),
      { body: new Uint8Array(bytes), contentType: "application/octet-stream", accept: "application/json" },
      TRANSFER_TIMEOUT_MS
    );
  }

  async deleteContextFile(projectId: string, filePath: string, ifMatch?: string): Promise<void> {
    const match = ifMatch ? `&ifMatch=${encodeURIComponent(ifMatch)}` : "";
    await peerRequest(this.peer, "DELETE", contextPath(projectId, `/file?path=${encodeURIComponent(filePath)}${match}`));
  }

  async deleteContextMirror(projectId: string): Promise<void> {
    await peerRequest(this.peer, "DELETE", contextPath(projectId, ""));
  }

  /**
   * Waits up to `waitMs` for a change to this token's context mirrors after
   * `cursor`; the peer answers as soon as one of its agents writes there.
   */
  contextChanges(
    input: { feed: string | null; cursor: number; waitMs: number },
    signal?: AbortSignal
  ): Promise<PeerContextChanges> {
    const query = new URLSearchParams({ cursor: String(input.cursor), wait: String(input.waitMs) });
    if (input.feed) {
      query.set("feed", input.feed);
    }
    return peerRequest<PeerContextChanges>(
      this.peer,
      "GET",
      `/api/projects/peer/context-changes?${query}`,
      undefined,
      input.waitMs + CONTEXT_CHANGES_SLACK_MS,
      signal
    );
  }
}
