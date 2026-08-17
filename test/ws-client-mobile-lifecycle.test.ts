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

  /** Simulates the transport dying underneath us (frozen process, server idle-reap). */
  die() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("close"));
  }

  send() {}
}

type FakeDocument = EventTarget & {
  visibilityState: string;
  documentElement: { classList: { contains(name: string): boolean } };
};

function createMobileDom() {
  const fakeWindow = new EventTarget() as EventTarget & {
    ReactNativeWebView: { postMessage(message: string): void };
  };
  fakeWindow.ReactNativeWebView = { postMessage() {} };
  const idleClasses = new Set<string>();
  const fakeDocument = new EventTarget() as FakeDocument;
  fakeDocument.visibilityState = "visible";
  fakeDocument.documentElement = {
    classList: {
      contains: (name: string) => idleClasses.has(name),
    },
  };
  return { fakeWindow, fakeDocument, idleClasses };
}

function withMobileDom(
  run: (dom: ReturnType<typeof createMobileDom>) => void
): void {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const dom = createMobileDom();
  Object.assign(globalThis, {
    window: dom.fakeWindow,
    document: dom.fakeDocument,
    WebSocket: FakeWebSocket,
  });
  FakeWebSocket.instances = [];
  try {
    run(dom);
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      document: originalDocument,
      WebSocket: originalWebSocket,
    });
  }
}

function sendLifecycle(target: EventTarget, state: string) {
  const event = new Event("cesium:mobile-bridge-message");
  Object.defineProperty(event, "detail", {
    value: { type: "lifecycle", state },
  });
  target.dispatchEvent(event);
}

test("backgrounding keeps the socket open and resume reuses it untouched", () => {
  withMobileDom(({ fakeWindow }) => {
    const states: string[] = [];
    let closes = 0;
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.onState((state) => states.push(state));
    socket.onClose(() => {
      closes += 1;
    });
    socket.connect();
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0]?.open();
    assert.equal(socket.connected, true);

    sendLifecycle(fakeWindow, "background");
    // The socket must survive the background transition: short backgrounds
    // should not force a teardown + reconnect cycle.
    assert.equal(socket.connected, true);
    assert.equal(FakeWebSocket.instances[0]?.readyState, FakeWebSocket.OPEN);

    sendLifecycle(fakeWindow, "active");
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(socket.connected, true);
    assert.equal(closes, 0);

    socket.disconnect();
  });
});

test("a socket that dies while backgrounded is silent and reconnects on resume", () => {
  withMobileDom(({ fakeWindow }) => {
    const states: string[] = [];
    let closes = 0;
    let errors = 0;
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.onState((state) => states.push(state));
    socket.onClose(() => {
      closes += 1;
    });
    socket.onError(() => {
      errors += 1;
    });
    socket.connect();
    FakeWebSocket.instances[0]?.open();

    sendLifecycle(fakeWindow, "background");
    FakeWebSocket.instances[0]?.die();
    // No listener noise and no background reconnect churn.
    assert.equal(closes, 0);
    assert.equal(errors, 0);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(states.at(-1), "closed");

    sendLifecycle(fakeWindow, "active");
    // Resume reconnects immediately (fresh backoff, no timer).
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(states.at(-1), "connecting");
    FakeWebSocket.instances[1]?.open();
    assert.equal(socket.connected, true);
    assert.equal(closes, 0);
    assert.equal(errors, 0);

    socket.disconnect();
  });
});

test("visibilitychange drives suspend/resume even when bridge messages are dropped", () => {
  withMobileDom(({ fakeWindow, fakeDocument }) => {
    const states: string[] = [];
    let closes = 0;
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.onState((state) => states.push(state));
    socket.onClose(() => {
      closes += 1;
    });
    socket.connect();
    FakeWebSocket.instances[0]?.open();

    // Simulates the racy bridge: no lifecycle message arrives, only the
    // page-side visibility change.
    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    FakeWebSocket.instances[0]?.die();
    assert.equal(closes, 0);
    assert.equal(FakeWebSocket.instances.length, 1);

    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(states.at(-1), "connecting");

    // A late-delivered "active" bridge message after the visibility resume is
    // a no-op rather than a duplicate reconnect.
    sendLifecycle(fakeWindow, "active");
    assert.equal(FakeWebSocket.instances.length, 2);

    socket.disconnect();
  });
});

test("connect while hidden waits for resume instead of opening a socket", () => {
  withMobileDom(({ fakeDocument }) => {
    fakeDocument.visibilityState = "hidden";
    const states: string[] = [];
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.onState((state) => states.push(state));
    socket.connect();
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(states.at(-1), "closed");

    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(states.at(-1), "connecting");

    socket.disconnect();
  });
});

test("manual disconnect while backgrounded stays disconnected after resume", () => {
  withMobileDom(({ fakeWindow }) => {
    const socket = new JsonWebSocket("ws://example.test/socket");
    socket.connect();
    FakeWebSocket.instances[0]?.open();

    sendLifecycle(fakeWindow, "background");
    socket.disconnect();
    assert.equal(FakeWebSocket.instances[0]?.readyState, FakeWebSocket.CLOSED);

    // Resume must not revive a manually closed socket.
    sendLifecycle(fakeWindow, "active");
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(socket.connected, false);
  });
});
