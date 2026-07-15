import { WebSocket } from "ws";

export type RuntimeSocketData = string | Buffer | Uint8Array | ArrayBuffer;

export type RuntimeSocketMessageHandler = (
  data: RuntimeSocketData,
  isBinary: boolean
) => void;

export interface RuntimeSocket {
  readonly isOpen: boolean;
  readonly bufferedAmount?: number;
  send(data: RuntimeSocketData, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: RuntimeSocketMessageHandler): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export function wrapNodeWebSocket(ws: WebSocket): RuntimeSocket {
  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(data, options) {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(data, { binary: options?.binary });
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(handler) {
      ws.on("message", (data, isBinary) => {
        handler(data as RuntimeSocketData, isBinary);
      });
    },
    onClose(handler) {
      ws.on("close", handler);
    },
    onError(handler) {
      ws.on("error", handler);
    },
  };
}

export class BufferedRuntimeSocket implements RuntimeSocket {
  private messageHandlers: RuntimeSocketMessageHandler[] = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private open = true;

  constructor(
    private readonly sendImpl: (
      data: RuntimeSocketData,
      options?: { binary?: boolean }
    ) => void,
    private readonly closeImpl: (code?: number, reason?: string) => void
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  send(data: RuntimeSocketData, options?: { binary?: boolean }): void {
    if (!this.open) {
      return;
    }
    this.sendImpl(data, options);
  }

  close(code?: number, reason?: string): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.closeImpl(code, reason);
  }

  onMessage(handler: RuntimeSocketMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  dispatchMessage(data: RuntimeSocketData, isBinary: boolean): void {
    if (!this.open) {
      return;
    }
    for (const handler of this.messageHandlers) {
      handler(data, isBinary);
    }
  }

  dispatchClose(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  dispatchError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}
