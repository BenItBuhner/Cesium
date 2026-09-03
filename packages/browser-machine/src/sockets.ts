/**
 * Virtual WebSockets between the workbench UI and the in-page engine.
 *
 * The client's reconnecting socket layer (`@cesium/client` ws-client) calls
 * `new WebSocket(url)`; for browser-machine URLs it instead receives a
 * {@link BrowserMachineWebSocket} - a same-shape object whose frames are
 * routed synchronously to an engine-side channel. No network is involved.
 */

export type EngineSocketContext = {
  send(message: unknown): void;
  close(code?: number, reason?: string): void;
};

export type EngineSocketChannel = {
  onClientMessage(raw: string): void;
  onClose(): void;
};

export type EngineSocketFactory = (
  url: URL,
  context: EngineSocketContext
) => EngineSocketChannel | null;

type SocketListener = (event: { data?: unknown }) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class BrowserMachineWebSocket {
  readyState: number = CONNECTING;
  binaryType = "blob";
  private readonly listeners = new Map<string, Set<SocketListener>>();
  private channel: EngineSocketChannel | null = null;

  constructor(
    private readonly url: string,
    attach: (socket: BrowserMachineWebSocket) => Promise<EngineSocketChannel | null>
  ) {
    // Attach on a macrotask so callers can register `open` listeners first
    // (mirrors real WebSocket semantics where open is never synchronous).
    setTimeout(() => {
      attach(this)
        .then((channel) => {
          if (this.readyState !== CONNECTING) {
            channel?.onClose();
            return;
          }
          if (!channel) {
            this.fail("No browser machine channel for this path.");
            return;
          }
          this.channel = channel;
          this.readyState = OPEN;
          this.dispatch("open", {});
        })
        .catch((error) => {
          this.fail(error instanceof Error ? error.message : String(error));
        });
    }, 0);
  }

  /** Engine → client frame. */
  deliver(message: unknown): void {
    if (this.readyState !== OPEN) return;
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.dispatch("message", { data });
  }

  /** Engine-initiated close. */
  closeFromEngine(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.dispatch("close", {});
  }

  private fail(message: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.dispatch("error", { message });
    this.dispatch("close", {});
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== OPEN || !this.channel) return;
    if (typeof data === "string") {
      this.channel.onClientMessage(data);
      return;
    }
    if (data instanceof Blob) {
      void data.text().then((text) => this.channel?.onClientMessage(text));
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(0);
    this.channel.onClientMessage(new TextDecoder().decode(bytes));
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    const channel = this.channel;
    this.channel = null;
    this.readyState = CLOSED;
    channel?.onClose();
    this.dispatch("close", {});
  }

  addEventListener(type: string, listener: SocketListener): void {
    const set = this.listeners.get(type) ?? new Set<SocketListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, payload: { data?: unknown; message?: string }): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload as { data?: unknown });
      } catch (error) {
        console.error(`[browser-machine] socket ${type} listener failed:`, error);
      }
    }
  }

  get socketUrl(): string {
    return this.url;
  }
}

/** Engine-side registry of socket channel factories, keyed by path prefix. */
export class EngineSocketHub {
  private readonly factories: Array<{ prefix: string; factory: EngineSocketFactory }> = [];

  registerPrefix(prefix: string, factory: EngineSocketFactory): void {
    this.factories.push({ prefix, factory });
  }

  createChannel(url: URL, context: EngineSocketContext): EngineSocketChannel | null {
    for (const entry of this.factories) {
      if (url.pathname === entry.prefix || url.pathname.startsWith(`${entry.prefix}/`)) {
        return entry.factory(url, context);
      }
    }
    return null;
  }
}
