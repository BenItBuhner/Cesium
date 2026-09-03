"use client";

/**
 * Browser Machine transport seam.
 *
 * The "This browser" device runs a full Cesium engine inside the page
 * (@cesium/browser-machine). Its ServerConnection uses a reserved synthetic
 * base URL; `engineFetch` and the WebSocket layer route any request against
 * that URL to the in-page engine instead of the network. The engine module
 * is loaded lazily on first use so it never weighs down normal sessions.
 */

export const BROWSER_MACHINE_HOSTNAME = "browser.cesium.internal";
export const BROWSER_MACHINE_BASE_URL = `https://${BROWSER_MACHINE_HOSTNAME}`;
export const BROWSER_MACHINE_SERVER_ID = "browser:local";
export const BROWSER_MACHINE_SERVER_LABEL = "This browser";
export const BROWSER_MACHINE_NATIVE_UNAVAILABLE_MESSAGE =
  "The in-browser engine is only available on the website and PWA.";

/** WebSocket-compatible surface produced by the browser machine transport. */
export type BrowserMachineSocketLike = {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

export type BrowserMachineTransportLike = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openSocket(url: string): BrowserMachineSocketLike;
};

export function isBrowserMachineUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes(BROWSER_MACHINE_HOSTNAME);
}

type TransportLoader = () => Promise<BrowserMachineTransportLike>;

let transport: BrowserMachineTransportLike | null = null;
let transportPromise: Promise<BrowserMachineTransportLike> | null = null;
let loader: TransportLoader | null = null;

/** Override the default dynamic-import loader (tests, alternate engines). */
export function setBrowserMachineTransportLoader(nextLoader: TransportLoader): void {
  loader = nextLoader;
  transport = null;
  transportPromise = null;
}

export function getBrowserMachineTransportSync(): BrowserMachineTransportLike | null {
  return transport;
}

export async function ensureBrowserMachineTransport(): Promise<BrowserMachineTransportLike> {
  if (transport) return transport;
  if (!transportPromise) {
    const load: TransportLoader =
      loader ??
      (async () => {
        const engineModule = await import("@cesium/browser-machine");
        return engineModule.createBrowserMachineTransport();
      });
    transportPromise = load()
      .then((created) => {
        transport = created;
        return created;
      })
      .catch((error) => {
        transportPromise = null;
        throw error instanceof Error
          ? error
          : new Error("Failed to load the browser machine engine.");
      });
  }
  return transportPromise;
}

/**
 * Fetch against an engine base URL, routing browser-machine URLs to the
 * in-page engine. All `@cesium/client` HTTP paths go through this helper.
 */
export async function engineFetch(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  if (isBrowserMachineUrl(baseUrl)) {
    const localTransport = await ensureBrowserMachineTransport();
    return localTransport.fetch(path, init);
  }
  return fetch(`${baseUrl}${path}`, init);
}

/**
 * Create a WebSocket-like connection for a resolved ws(s) URL, routing
 * browser-machine URLs to virtual in-page sockets.
 */
export function openEngineWebSocket(url: string): WebSocket {
  if (isBrowserMachineUrl(url)) {
    let socket: BrowserMachineSocketLike | null = null;
    const pendingSends: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
    const listeners: Array<{ type: string; listener: (event: { data?: unknown }) => void }> = [];
    // The transport may still be loading; return a shim that binds once ready.
    const shim: BrowserMachineSocketLike = {
      readyState: 0,
      binaryType: "blob",
      send(data) {
        if (socket) {
          socket.send(data);
        } else {
          pendingSends.push(data);
        }
      },
      close(code, reason) {
        if (socket) {
          socket.close(code, reason);
        } else {
          shim.readyState = 3;
        }
      },
      addEventListener(type, listener) {
        listeners.push({ type, listener });
        socket?.addEventListener(type, listener);
      },
      removeEventListener(type, listener) {
        const index = listeners.findIndex(
          (entry) => entry.type === type && entry.listener === listener
        );
        if (index >= 0) listeners.splice(index, 1);
        socket?.removeEventListener(type, listener);
      },
    };
    void ensureBrowserMachineTransport()
      .then((localTransport) => {
        if (shim.readyState === 3) return;
        socket = localTransport.openSocket(url);
        for (const entry of listeners) {
          socket.addEventListener(entry.type, entry.listener);
        }
        Object.defineProperty(shim, "readyState", {
          get: () => socket?.readyState ?? 3,
        });
        Object.defineProperty(shim, "binaryType", {
          get: () => socket?.binaryType ?? "blob",
          set: (value: string) => {
            if (socket) socket.binaryType = value;
          },
        });
        for (const data of pendingSends.splice(0)) {
          socket.send(data);
        }
      })
      .catch((error) => {
        console.error("[browser-machine] transport load failed:", error);
        shim.readyState = 3;
        for (const entry of listeners) {
          if (entry.type === "error") {
            (entry.listener as (event: unknown) => void)({ message: String(error) });
          }
        }
        for (const entry of listeners) {
          if (entry.type === "close") {
            (entry.listener as (event: unknown) => void)({});
          }
        }
      });
    return shim as unknown as WebSocket;
  }
  return new WebSocket(url);
}
