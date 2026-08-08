export const SESSION_TOKEN_HEADER = "x-opencursor-session-token";
export const WORKSPACE_ID_HEADER = "x-opencursor-workspace-id";

export type Awaitable<T> = T | Promise<T>;
export type CesiumTokenProvider = () => Awaitable<string | null | undefined>;

export type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

export type CesiumFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CesiumClientOptions = {
  baseUrl: string | URL;
  token?: string | CesiumTokenProvider;
  fetch?: CesiumFetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  timeoutMs?: number;
  validateResponses?: boolean;
  onSessionToken?: (token: string | null) => void;
  webSocket?: WebSocketFactory;
};

export type CesiumQueryValue = string | number | boolean | null | undefined;

export type CesiumRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, CesiumQueryValue | readonly CesiumQueryValue[]>;
  json?: unknown;
  body?: BodyInit | null;
  headers?: HeadersInit;
  workspaceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  cache?: RequestCache;
  schema?: RuntimeSchema<unknown>;
};

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export class CesiumApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly response: Response;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    details?: unknown;
    requestId?: string;
    response: Response;
  }) {
    super(input.message);
    this.name = "CesiumApiError";
    this.status = input.status;
    this.code = input.code ?? `http_${input.status}`;
    this.details = input.details;
    this.requestId = input.requestId;
    this.response = input.response;
  }
}

export class CesiumContractError extends Error {
  readonly cause: unknown;
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Cesium returned an invalid response for ${operation}.`);
    this.name = "CesiumContractError";
    this.operation = operation;
    this.cause = cause;
  }
}

function normalizeBaseUrl(value: string | URL): string {
  const raw = String(value).trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function appendQuery(
  path: string,
  query?: CesiumRequestOptions["query"]
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
  }
  const serialized = params.toString();
  if (!serialized) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${serialized}`;
}

function parseErrorPayload(
  payload: unknown,
  status: number
): { message: string; code?: string; details?: unknown; requestId?: string } {
  if (!payload || typeof payload !== "object") {
    return { message: `Request failed with status ${status}.` };
  }
  const body = payload as {
    error?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
  if (typeof body.error === "string") {
    return {
      message: body.error,
      requestId: typeof body.requestId === "string" ? body.requestId : undefined,
    };
  }
  if (body.error && typeof body.error === "object") {
    const nested = body.error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    return {
      message:
        typeof nested.message === "string"
          ? nested.message
          : `Request failed with status ${status}.`,
      code: typeof nested.code === "string" ? nested.code : undefined,
      details: nested.details,
      requestId: typeof body.requestId === "string" ? body.requestId : undefined,
    };
  }
  if (typeof body.message === "string") {
    return { message: body.message };
  }
  return { message: `Request failed with status ${status}.` };
}

function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal?: AbortSignal; dispose(): void } {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal, dispose() {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)),
    timeoutMs
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export class CesiumTransport {
  readonly baseUrl: string;
  readonly webSocketFactory?: WebSocketFactory;
  private readonly fetchImpl: CesiumFetch;
  private readonly token?: string | CesiumTokenProvider;
  private readonly defaultHeaders: Headers;
  private readonly credentials: RequestCredentials;
  private readonly timeoutMs?: number;
  private readonly validateResponses: boolean;
  private readonly onSessionToken?: (token: string | null) => void;

  constructor(options: CesiumClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("CesiumClient requires a fetch implementation.");
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.token = options.token;
    this.defaultHeaders = new Headers(options.headers);
    this.credentials = options.credentials ?? "include";
    this.timeoutMs = options.timeoutMs;
    this.validateResponses = options.validateResponses !== false;
    this.onSessionToken = options.onSessionToken;
    this.webSocketFactory = options.webSocket;
  }

  url(path: string, query?: CesiumRequestOptions["query"]): string {
    const resolvedPath = appendQuery(path.startsWith("/") ? path : `/${path}`, query);
    return `${this.baseUrl}${resolvedPath}`;
  }

  async resolveToken(): Promise<string | null> {
    const value =
      typeof this.token === "function" ? await this.token() : this.token;
    return value?.trim() || null;
  }

  async raw(path: string, options: CesiumRequestOptions = {}): Promise<Response> {
    const headers = new Headers(this.defaultHeaders);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    const token = await this.resolveToken();
    if (token && !headers.has("authorization") && !headers.has(SESSION_TOKEN_HEADER)) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (options.workspaceId) {
      headers.set(WORKSPACE_ID_HEADER, options.workspaceId);
    }

    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }

    const combined = combineSignal(
      options.signal,
      options.timeoutMs ?? this.timeoutMs
    );
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method: options.method ?? "GET",
        headers,
        body,
        credentials: this.credentials,
        cache: options.cache,
        signal: combined.signal,
      });
    } finally {
      combined.dispose();
    }

    if (response.headers.has(SESSION_TOKEN_HEADER)) {
      this.onSessionToken?.(
        response.headers.get(SESSION_TOKEN_HEADER)?.trim() || null
      );
    }
    return response;
  }

  async request<T>(
    operation: string,
    path: string,
    options: CesiumRequestOptions & { schema?: RuntimeSchema<T> } = {}
  ): Promise<T> {
    const response = await this.raw(path, options);
    return this.parseResponse(operation, response, options.schema);
  }

  async parseResponse<T>(
    operation: string,
    response: Response,
    schema?: RuntimeSchema<T>
  ): Promise<T> {
    const text = await response.text();
    let payload: unknown;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const error = parseErrorPayload(payload, response.status);
      throw new CesiumApiError({
        ...error,
        requestId:
          error.requestId ??
          response.headers.get("x-request-id") ??
          undefined,
        status: response.status,
        response,
      });
    }

    if (!schema || !this.validateResponses) {
      return payload as T;
    }
    try {
      return schema.parse(payload);
    } catch (error) {
      throw new CesiumContractError(operation, error);
    }
  }

  async webSocketUrl(
    path: string,
    query?: CesiumRequestOptions["query"]
  ): Promise<string> {
    let url = this.url(path, query);
    if (url.startsWith("https://")) {
      url = `wss://${url.slice("https://".length)}`;
    } else if (url.startsWith("http://")) {
      url = `ws://${url.slice("http://".length)}`;
    } else if (url.startsWith("/") && typeof location !== "undefined") {
      url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${url}`;
    }
    const token = await this.resolveToken();
    if (!token) return url;
    const parsed = new URL(url);
    parsed.searchParams.set("access_token", token);
    return parsed.toString();
  }

  createWebSocket(url: string): WebSocketLike {
    if (this.webSocketFactory) {
      return this.webSocketFactory(url);
    }
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "WebSocket is unavailable. Pass a webSocket factory to CesiumClient in this runtime."
      );
    }
    return new WebSocket(url);
  }
}
