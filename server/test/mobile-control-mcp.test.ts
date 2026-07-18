import assert from "node:assert/strict";
import test from "node:test";
import {
  callBuiltInMobileTool,
  clearMobileControlDevicesForTests,
  listMobileControlDevices,
} from "../src/lib/mcp/builtin-mobile-tools.js";
import { attachMobileControlSocket } from "../src/ws/mobile-control.js";
import type {
  RuntimeSocket,
  RuntimeSocketData,
  RuntimeSocketMessageHandler,
} from "../src/ws/runtime-socket.js";

class FakeSocket implements RuntimeSocket {
  isOpen = true;
  sent: string[] = [];
  private messageHandlers: RuntimeSocketMessageHandler[] = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];

  send(data: RuntimeSocketData): void {
    this.sent.push(String(data));
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const handler of this.closeHandlers) handler();
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

  receive(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(JSON.stringify(message), false);
    }
  }
}

test.afterEach(() => {
  clearMobileControlDevicesForTests();
});

test("mobile MCP forwards calls to a registered Android client", async () => {
  const socket = new FakeSocket();
  attachMobileControlSocket(socket, "workspace-mobile-test");
  socket.receive({
    type: "register",
    device: {
      id: "pixel-8",
      name: "Pixel 8",
      platform: "android",
      apiLevel: 36,
      appVersion: "0.1.3",
    },
    capabilities: ["device_info", "open_apps", "ui_automation"],
  });

  assert.deepEqual(listMobileControlDevices("workspace-mobile-test")[0]?.capabilities, [
    "device_info",
    "open_apps",
    "ui_automation",
  ]);

  const pending = callBuiltInMobileTool({
    workspaceId: "workspace-mobile-test",
    toolName: "mobile_tap",
    arguments: { deviceId: "pixel-8", x: 120, y: 480 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const invocation = socket.sent
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    .find((entry) => entry.type === "invoke");
  assert.equal(invocation?.toolName, "mobile_tap");
  assert.deepEqual(invocation?.arguments, { x: 120, y: 480 });

  socket.receive({
    type: "result",
    requestId: invocation?.requestId,
    ok: true,
    result: { ok: true, action: "tap_dispatched" },
  });
  assert.match(await pending, /tap_dispatched/);
});

test("mobile MCP rejects capabilities the user has not granted", async () => {
  const socket = new FakeSocket();
  attachMobileControlSocket(socket, "workspace-mobile-capabilities");
  socket.receive({
    type: "register",
    device: {
      id: "phone",
      name: "Phone",
      platform: "android",
      apiLevel: 35,
      appVersion: "0.1.3",
    },
    capabilities: ["device_info", "open_apps"],
  });

  await assert.rejects(
    callBuiltInMobileTool({
      workspaceId: "workspace-mobile-capabilities",
      toolName: "mobile_screen_snapshot",
      arguments: {},
    }),
    /screen_capture/
  );
});

test("mobile MCP requires a device id when multiple phones are connected", async () => {
  for (const id of ["one", "two"]) {
    const socket = new FakeSocket();
    attachMobileControlSocket(socket, "workspace-mobile-many");
    socket.receive({
      type: "register",
      device: {
        id,
        name: id,
        platform: "android",
        apiLevel: 36,
        appVersion: "0.1.3",
      },
      capabilities: ["device_info", "open_apps"],
    });
  }

  await assert.rejects(
    callBuiltInMobileTool({
      workspaceId: "workspace-mobile-many",
      toolName: "mobile_open_app",
      arguments: { packageName: "com.android.settings" },
    }),
    /Multiple Android devices/
  );
});
