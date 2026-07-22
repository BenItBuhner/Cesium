export type OpenCodeV2Json = Record<string, unknown>;

export type OpenCodeV2ClientOptions = {
  baseUrl: string;
  password?: string;
  timeoutMs?: number;
};

export type OpenCodeV2ModelRef = {
  id: string;
  providerID: string;
  variant?: string;
};

export class OpenCodeV2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "OpenCodeV2Error";
  }
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body.slice(0, 500);
    }
    const record = parsed as Record<string, unknown>;
    const data =
      record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : undefined;
    const message =
      (typeof data?.message === "string" && data.message) ||
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error);
    return message?.trim() || body.slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function dataRecord(value: unknown): OpenCodeV2Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as OpenCodeV2Json;
  return record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? (record.data as OpenCodeV2Json)
    : record;
}

function dataArray(value: unknown): OpenCodeV2Json[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const data = (value as OpenCodeV2Json).data;
  return Array.isArray(data)
    ? data.filter(
        (entry): entry is OpenCodeV2Json =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry))
      )
    : [];
}

export function openCodeV2AuthFromEnv(): { password?: string } {
  return {
    password:
      process.env.OPENCURSOR_OPENCODE_V2_PASSWORD?.trim() ||
      process.env.OPENCODE_PASSWORD?.trim() ||
      process.env.OPENCODE_SERVER_PASSWORD?.trim() ||
      undefined,
  };
}

export function parseOpenCodeV2ModelRef(value: string): OpenCodeV2ModelRef | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "__default__") {
    return undefined;
  }
  const providerEnd = trimmed.indexOf("/");
  if (providerEnd <= 0 || providerEnd >= trimmed.length - 1) {
    return undefined;
  }
  const variantStart = trimmed.indexOf("#", providerEnd + 1);
  const providerID = trimmed.slice(0, providerEnd);
  const id = trimmed.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
  const variant = variantStart === -1 ? undefined : trimmed.slice(variantStart + 1);
  if (!providerID || !id || (variantStart !== -1 && !variant)) {
    return undefined;
  }
  return { providerID, id, ...(variant ? { variant } : {}) };
}

export class OpenCodeV2Client {
  readonly baseUrl: string;
  private readonly password?: string;
  private readonly timeoutMs?: number;

  constructor(options: OpenCodeV2ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password;
    this.timeoutMs = options.timeoutMs;
  }

  headers(extra?: HeadersInit): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.password
        ? {
            Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
          }
        : {}),
      ...Object.fromEntries(new Headers(extra).entries()),
    };
  }

  async request<T = unknown>(
    pathName: string,
    init?: RequestInit,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? new AbortController()
        : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const response = await fetch(`${this.baseUrl}${pathName}`, {
        ...init,
        headers: this.headers(init?.headers),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new OpenCodeV2Error(
          `OpenCode v2 ${pathName} failed with ${response.status}: ${errorDetail(text)}`,
          response.status,
          text
        );
      }
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  health(): Promise<{ healthy: true; version: string; pid: number }> {
    return this.request("/api/health", undefined, { timeoutMs: 5_000 });
  }

  async createSession(input: {
    agent?: string;
    model?: OpenCodeV2ModelRef;
    location: { directory: string };
  }): Promise<OpenCodeV2Json> {
    return dataRecord(
      await this.request("/api/session", {
        method: "POST",
        body: JSON.stringify(input),
      })
    );
  }

  async getSession(id: string): Promise<OpenCodeV2Json> {
    return dataRecord(await this.request(`/api/session/${encodeURIComponent(id)}`));
  }

  renameSession(id: string, title: string): Promise<null> {
    return this.request(`/api/session/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  switchAgent(id: string, agent: string): Promise<null> {
    return this.request(`/api/session/${encodeURIComponent(id)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    });
  }

  switchModel(id: string, model: OpenCodeV2ModelRef): Promise<null> {
    return this.request(`/api/session/${encodeURIComponent(id)}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    });
  }

  sendPrompt(
    id: string,
    body: {
      text: string;
      files?: Array<{ uri: string; name?: string }>;
      metadata?: Record<string, unknown>;
      resume?: boolean;
    }
  ): Promise<OpenCodeV2Json> {
    return this.request(`/api/session/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  addSynthetic(
    id: string,
    body: { text: string; description?: string; metadata?: Record<string, unknown>; resume?: boolean }
  ): Promise<OpenCodeV2Json> {
    return this.request(`/api/session/${encodeURIComponent(id)}/synthetic`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  waitForSession(id: string): Promise<null> {
    return this.request(
      `/api/session/${encodeURIComponent(id)}/wait`,
      { method: "POST" },
      { timeoutMs: 0 }
    );
  }

  interruptSession(id: string): Promise<null> {
    return this.request(`/api/session/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
    });
  }

  answerPermission(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject"
  ): Promise<null> {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ reply }),
      }
    );
  }

  answerQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<null> {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      }
    );
  }

  answerForm(
    sessionId: string,
    formId: string,
    answer: Record<string, string | number | boolean | string[]>
  ): Promise<null> {
    return this.request(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ answer }),
      }
    );
  }

  async listAgents(directory: string): Promise<OpenCodeV2Json[]> {
    const query = new URLSearchParams({ "location[directory]": directory });
    return dataArray(await this.request(`/api/agent?${query.toString()}`));
  }

  async listModels(directory: string): Promise<OpenCodeV2Json[]> {
    const query = new URLSearchParams({ "location[directory]": directory });
    return dataArray(await this.request(`/api/model?${query.toString()}`));
  }
}
