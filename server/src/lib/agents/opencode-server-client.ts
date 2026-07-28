export type OpenCodeServerJson = Record<string, unknown>;

export type OpenCodeServerClientOptions = {
  baseUrl: string;
  /**
   * Workspace directory every instance-scoped request is pinned to via the
   * `?directory=` query param (supported by OpenCode servers since v0.6.0).
   * Without it OpenCode resolves the project from the server process cwd,
   * which is wrong whenever the server is shared across workspaces (external
   * `OPENCURSOR_OPENCODE_SERVER_URL` deployments) — chats then run in the
   * server's cwd instead of their own per-chat sandbox directory.
   */
  directory?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
};

export class OpenCodeServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "OpenCodeServerError";
  }
}

function formatOpenCodeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body.slice(0, 500);
    }
    const record = parsed as Record<string, unknown>;
    const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
    const dataMessage =
      data?.message && typeof data.message === "string" ? data.message.trim() : "";
    if (dataMessage) {
      return dataMessage;
    }
    if (Array.isArray(record.error)) {
      const messages = record.error
        .flatMap((entry) => {
          const error = entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)
            : {};
          return typeof error.message === "string" ? [error.message] : [];
        })
        .filter(Boolean);
      if (messages.length > 0) {
        return messages.join("; ");
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  } catch {
    // fall through
  }
  return body.slice(0, 500);
}

function authHeader(username: string | undefined, password: string | undefined): Record<string, string> {
  if (!password) {
    return {};
  }
  return {
    Authorization: `Basic ${Buffer.from(`${username || "opencode"}:${password}`).toString("base64")}`,
  };
}

/**
 * Non-streaming OpenCode HTTP calls are all fast control operations (session
 * CRUD, async prompt start, permission replies). Without a deadline a wedged
 * server leaves the harness waiting forever, so every request gets a default
 * timeout unless the caller explicitly opts out with `timeoutMs: 0`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class OpenCodeServerClient {
  readonly baseUrl: string;
  readonly directory?: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs?: number;

  constructor(options: OpenCodeServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.directory = options.directory?.trim() || undefined;
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Builds the request URL, scoping instance routes to the configured
   * workspace directory. `/global/*` routes are instance-independent and must
   * stay unscoped.
   */
  url(pathName: string): string {
    const url = new URL(`${this.baseUrl}${pathName}`);
    if (this.directory && !pathName.startsWith("/global")) {
      url.searchParams.set("directory", this.directory);
    }
    return url.toString();
  }

  headers(extra?: HeadersInit): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeader(this.username, this.password),
      ...Object.fromEntries(new Headers(extra).entries()),
    };
  }

  async request<T = unknown>(
    pathName: string,
    init?: RequestInit,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? new AbortController()
        : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(this.url(pathName), {
        ...init,
        headers: this.headers(init?.headers),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        const detail = formatOpenCodeErrorBody(text);
        throw new OpenCodeServerError(
          `OpenCode Server ${pathName} failed with ${response.status}: ${detail}`,
          response.status,
          text
        );
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new OpenCodeServerError(
          `OpenCode Server ${pathName} timed out after ${timeoutMs}ms.`,
          0,
          ""
        );
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  health(): Promise<{ healthy?: boolean; version?: string }> {
    return this.request("/global/health", undefined, { timeoutMs: 5_000 });
  }

  listSessions(): Promise<OpenCodeServerJson[]> {
    return this.request("/session");
  }

  createSession(input: { title?: string; parentID?: string }): Promise<OpenCodeServerJson> {
    return this.request("/session", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getSession(id: string): Promise<OpenCodeServerJson> {
    return this.request(`/session/${encodeURIComponent(id)}`);
  }

  abortSession(id: string): Promise<boolean> {
    return this.request(`/session/${encodeURIComponent(id)}/abort`, {
      method: "POST",
    });
  }

  disposeInstance(): Promise<boolean> {
    return this.request("/instance/dispose", {
      method: "POST",
    });
  }

  listMessages(id: string): Promise<Array<{ info?: OpenCodeServerJson; parts?: OpenCodeServerJson[] }>> {
    return this.request(`/session/${encodeURIComponent(id)}/message`);
  }

  sendMessage(
    id: string,
    body: OpenCodeServerJson
  ): Promise<{ info?: OpenCodeServerJson; parts?: OpenCodeServerJson[] }> {
    return this.request(`/session/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  sendPromptAsync(id: string, body: OpenCodeServerJson): Promise<null> {
    return this.request(`/session/${encodeURIComponent(id)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  answerPermission(
    sessionId: string,
    permissionId: string,
    body: OpenCodeServerJson
  ): Promise<boolean> {
    return this.request(
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  /**
   * Lists pending permission requests instance-wide. Modern OpenCode servers
   * raise permissions silently (no SSE event), so this is the only reliable
   * discovery mechanism; older servers 404 here and emit `permission.updated`
   * events instead.
   */
  listPermissions(): Promise<OpenCodeServerJson[]> {
    return this.request("/permission", undefined, { timeoutMs: 10_000 });
  }
}

export function openCodeServerAuthFromEnv(): { username?: string; password?: string } {
  return {
    username:
      process.env.OPENCURSOR_OPENCODE_SERVER_USERNAME?.trim() ||
      process.env.OPENCODE_SERVER_USERNAME?.trim() ||
      undefined,
    password:
      process.env.OPENCURSOR_OPENCODE_SERVER_PASSWORD?.trim() ||
      process.env.OPENCODE_SERVER_PASSWORD?.trim() ||
      undefined,
  };
}
