/**
 * Minimal request router for the in-browser engine. The browser machine
 * serves the same `/api/*` surface as the Bun engine, but requests never
 * leave the page: the client transport hands us a path + RequestInit and we
 * synthesize a `Response`.
 */

export type EngineRequest = {
  method: string;
  path: string;
  url: URL;
  headers: Headers;
  params: Record<string, string>;
  workspaceId: string | null;
  json<T>(): Promise<T>;
  text(): Promise<string>;
  formData(): Promise<FormData>;
};

export type EngineHandler = (request: EngineRequest) => Promise<Response> | Response;

type CompiledRoute = {
  method: string;
  segments: string[];
  handler: EngineHandler;
};

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export class EngineRouter {
  private readonly routes: CompiledRoute[] = [];

  register(method: string, pattern: string, handler: EngineHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter(Boolean),
      handler,
    });
  }

  get(pattern: string, handler: EngineHandler): void {
    this.register("GET", pattern, handler);
  }

  post(pattern: string, handler: EngineHandler): void {
    this.register("POST", pattern, handler);
  }

  put(pattern: string, handler: EngineHandler): void {
    this.register("PUT", pattern, handler);
  }

  patch(pattern: string, handler: EngineHandler): void {
    this.register("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: EngineHandler): void {
    this.register("DELETE", pattern, handler);
  }

  private match(
    method: string,
    path: string
  ): { handler: EngineHandler; params: Record<string, string> } | null {
    const pathSegments = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const routeSegment = route.segments[i] ?? "";
        const pathSegment = pathSegments[i] ?? "";
        if (routeSegment.startsWith(":")) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
          continue;
        }
        if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  async dispatch(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input, "https://browser.cesium.internal");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const matchResult = this.match(method, url.pathname);
    if (!matchResult) {
      return errorResponse(`No browser-machine route for ${method} ${url.pathname}`, 404);
    }
    const body = init?.body ?? null;
    const request: EngineRequest = {
      method,
      path: url.pathname,
      url,
      headers,
      params: matchResult.params,
      workspaceId: headers.get("x-opencursor-workspace-id"),
      async json<T>(): Promise<T> {
        if (typeof body === "string") return JSON.parse(body) as T;
        if (body instanceof Blob) return JSON.parse(await body.text()) as T;
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
          const bytes =
            body instanceof ArrayBuffer
              ? new Uint8Array(body)
              : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
          return JSON.parse(new TextDecoder().decode(bytes)) as T;
        }
        throw new Error("Expected a JSON request body.");
      },
      async text(): Promise<string> {
        if (body === null) return "";
        if (typeof body === "string") return body;
        if (body instanceof Blob) return body.text();
        if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
        if (ArrayBuffer.isView(body)) {
          return new TextDecoder().decode(
            new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          );
        }
        return String(body);
      },
      async formData(): Promise<FormData> {
        if (body instanceof FormData) return body;
        throw new Error("Expected multipart form data.");
      },
    };
    try {
      return await matchResult.handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 500);
    }
  }
}
