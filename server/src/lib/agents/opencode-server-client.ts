export type OpenCodeServerJson = Record<string, unknown>;

export type OpenCodeServerClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  promptTimeoutMs?: number;
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

export class OpenCodeServerClient {
  readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly promptTimeoutMs: number;

  constructor(options: OpenCodeServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 10 * 60_000;
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
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${pathName}`, {
        ...init,
        headers: this.headers(init?.headers),
        signal: controller.signal,
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
    } finally {
      clearTimeout(timer);
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
    }, { timeoutMs: this.promptTimeoutMs });
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
