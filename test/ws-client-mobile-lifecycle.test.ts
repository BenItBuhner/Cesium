import assert from "node:assert/strict";
import test from "node:test";
import { JsonWebSocket } from "../packages/client/src/ws-client.ts";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send() {}
}

test("mobile lifecycle suspends and resumes reconnecting web sockets", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const fakeWindow = new EventTarget() as EventTarget & {
    ReactNativeWebView: { postMessage(message: string): void };
  };
  fakeWindow.ReactNativeWebView = { postMessage() {} };
  const idleClasses = new Set<string>();

  Object.assign(globalThis, {
    window: fakeWindow,
    document: {
      documentElement: {
        classList: {
          contains: (name: string) => idleClasses.has(name),
        },
      },
    },
    WebSocket: FakeWebSocket,
  });
  FakeWebSocket.instances = [];

  try {
    const states: string[] = [];
    let unexpectedCloses = 0;
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.onState((state) => states.push(state));
    socket.onClose(() => {
      unexpectedCloses += 1;
    });
    socket.connect();
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0]?.open();
    assert.equal(socket.connected, true);

    const backgroundEvent = new Event("cesium:mobile-bridge-message");
    Object.defineProperty(backgroundEvent, "detail", {
      value: { type: "lifecycle", state: "background" },
    });
    fakeWindow.dispatchEvent(backgroundEvent);
    assert.equal(socket.connected, false);
    assert.equal(FakeWebSocket.instances[0]?.readyState, FakeWebSocket.CLOSED);
    assert.equal(unexpectedCloses, 0);

    const activeEvent = new Event("cesium:mobile-bridge-message");
    Object.defineProperty(activeEvent, "detail", {
      value: { type: "lifecycle", state: "active" },
    });
    fakeWindow.dispatchEvent(activeEvent);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(states.at(-1), "connecting");

    socket.disconnect();
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      WebSocket: originalWebSocket,
    });
  }
});
