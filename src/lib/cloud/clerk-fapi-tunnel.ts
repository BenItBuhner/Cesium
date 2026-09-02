"use client";

/**
 * Clerk Frontend API tunnel for packaged mobile WebViews.
 *
 * The bundled workbench runs from file://, and Chromium stamps
 * `Origin: null` onto every POST it makes - a forbidden header that page
 * JavaScript cannot remove. Clerk's production Frontend API rejects any
 * request whose Origin is not the instance domain (`origin_invalid`, 400),
 * while requests carrying *no* Origin header (native clients) are accepted.
 * That means clerk-js inside the WebView can never sign in or refresh a
 * session token on its own.
 *
 * React Native's fetch sends no Origin header and shares its cookie jar
 * with the WebView (Android CookieManager / iOS NSHTTPCookieStorage), so
 * relaying FAPI traffic through the native shell makes the whole Clerk
 * runtime - ticket sign-in, session cookies, token refresh for Convex -
 * behave exactly like a first-party browser client.
 *
 * This module patches `window.fetch` so requests to the instance's FAPI
 * origin ride the mobile bridge (`clerkFapiRequest` / `clerkFapiResponse`)
 * instead of the WebView network stack. Every other request is untouched.
 */

import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  hasMobileBridge,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";
import { getClerkPublishableKey } from "@/lib/cloud/cloud-env";

const TUNNEL_TIMEOUT_MS = 30_000;

type TunnelResponseMessage = Extract<
  MobileNativeToWebMessage,
  { type: "clerkFapiResponse" }
>;

/**
 * Frontend API origin encoded in a Clerk publishable key:
 * `pk_live_<base64("clerk.example.com$")>`. Returns null for malformed keys.
 */
export function clerkFapiOriginFromPublishableKey(key: string | null | undefined): string | null {
  if (!key) {
    return null;
  }
  const encoded = key.trim().match(/^pk_(?:live|test)_([A-Za-z0-9+/=]+)$/)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const decoded =
      typeof atob === "function"
        ? atob(encoded)
        : Buffer.from(encoded, "base64").toString("utf8");
    const host = decoded.replace(/\$$/, "").trim();
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
      return null;
    }
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function isClerkFapiUrl(url: string, fapiOrigin: string): boolean {
  try {
    return new URL(url).origin === fapiOrigin;
  } catch {
    return false;
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) {
    return record;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      record[name] = value;
    }
    return record;
  }
  for (const [name, value] of Object.entries(headers)) {
    record[name] = value;
  }
  return record;
}

/** Bodies clerk-js actually sends: urlencoded strings / URLSearchParams. */
function serializeBody(body: BodyInit | null | undefined): {
  ok: boolean;
  body?: string | null;
  contentType?: string;
} {
  if (body == null) {
    return { ok: true, body: null };
  }
  if (typeof body === "string") {
    return { ok: true, body };
  }
  if (body instanceof URLSearchParams) {
    return {
      ok: true,
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }
  return { ok: false };
}

type PendingTunnelRequest = {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

declare global {
  interface Window {
    __CESIUM_CLERK_FAPI_TUNNEL__?: boolean;
  }
}

/** Statuses the Response constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function buildResponse(message: TunnelResponseMessage): Response {
  const status = message.status ?? 502;
  const body = NULL_BODY_STATUSES.has(status) ? null : (message.body ?? null);
  return new Response(body, {
    status,
    headers: message.headers,
  });
}

/**
 * Routes Clerk Frontend API requests through the native shell. Idempotent;
 * no-ops outside the mobile WebView or when no publishable key resolves.
 */
export function installClerkFapiTunnel(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.__CESIUM_CLERK_FAPI_TUNNEL__) {
    return true;
  }
  if (!hasMobileBridge()) {
    return false;
  }
  const fapiOrigin = clerkFapiOriginFromPublishableKey(getClerkPublishableKey());
  if (!fapiOrigin) {
    return false;
  }

  const pending = new Map<string, PendingTunnelRequest>();
  let requestCounter = 0;

  window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, (event) => {
    const detail = (event as CustomEvent<MobileNativeToWebMessage>).detail;
    if (!detail || detail.type !== "clerkFapiResponse") {
      return;
    }
    const entry = pending.get(detail.id);
    if (!entry) {
      return;
    }
    pending.delete(detail.id);
    clearTimeout(entry.timer);
    if (!detail.ok) {
      entry.reject(
        new TypeError(detail.error || "Clerk request failed in the native shell.")
      );
      return;
    }
    try {
      entry.resolve(buildResponse(detail));
    } catch (error) {
      entry.reject(error);
    }
  });

  const originalFetch = window.fetch.bind(window);
  const tunneledFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!isClerkFapiUrl(url, fapiOrigin)) {
      return originalFetch(input, init);
    }

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = headersToRecord(
      init?.headers ?? (request ? request.headers : undefined)
    );
    let rawBody: BodyInit | null | undefined = init?.body;
    if (rawBody === undefined && request && method !== "GET" && method !== "HEAD") {
      rawBody = await request.clone().text();
    }
    const serialized = serializeBody(rawBody);
    if (!serialized.ok) {
      // Unexpected body type (Blob/FormData/stream) - let the network stack
      // try rather than silently corrupting the request.
      return originalFetch(input, init);
    }
    if (serialized.contentType && !hasHeader(headers, "content-type")) {
      headers["content-type"] = serialized.contentType;
    }

    const id = `clerk-fapi-${Date.now()}-${++requestCounter}`;
    const signal = init?.signal ?? request?.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new TypeError("Clerk request timed out in the native shell."));
      }, TUNNEL_TIMEOUT_MS);
      const settle: PendingTunnelRequest = {
        resolve,
        reject,
        timer,
      };
      pending.set(id, settle);
      signal?.addEventListener(
        "abort",
        () => {
          if (pending.delete(id)) {
            clearTimeout(timer);
            reject(createAbortError());
          }
        },
        { once: true }
      );
      const posted = postMobileBridgeMessage({
        type: "clerkFapiRequest",
        id,
        url,
        method,
        headers,
        body: serialized.body ?? null,
      });
      if (!posted) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new TypeError("Mobile bridge unavailable for Clerk request."));
      }
    });
  };

  window.__CESIUM_CLERK_FAPI_TUNNEL__ = true;
  window.fetch = tunneledFetch;
  return true;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
