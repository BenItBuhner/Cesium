import assert from "node:assert/strict";
import test from "node:test";
import { defaultPhoneControlCapabilities } from "@cesium/core";
import {
  PHONE_MCP_SERVER_ID,
  PHONE_MCP_TOOLS,
  callBuiltInPhoneTool,
} from "../src/lib/mcp/builtin-phone-tools.js";
import {
  completePhoneCommand,
  dispatchPhoneCommand,
  listPhoneDevices,
  readPhoneCommands,
  registerPhoneDevice,
  resetPhoneControlForTests,
} from "../src/lib/phone-control/service.js";

test("phone control registers a capability-derived Android device", () => {
  resetPhoneControlForTests();
  const device = registerPhoneDevice({
    workspaceId: "ws-phone",
    deviceId: "android-1",
    name: "Pixel",
    capabilities: {
      ...defaultPhoneControlCapabilities(),
      accessibilityEnabled: true,
      screenSnapshot: true,
      gestures: true,
    },
    sdkInt: 36,
  });
  assert.equal(device.platform, "android");
  assert.equal(device.connected, true);
  assert.equal(device.capabilities.screenSnapshot, true);
  assert.equal(device.capabilities.thirdPartyAppsOnSecondaryDisplay, false);
  assert.equal(device.capabilities.hardwareWakeWord, false);
  assert.equal(listPhoneDevices("ws-phone").length, 1);
});

test("phone control queues commands and resolves correlated results", async () => {
  resetPhoneControlForTests();
  registerPhoneDevice({
    workspaceId: "ws-phone",
    deviceId: "android-1",
  });
  const pending = dispatchPhoneCommand({
    workspaceId: "ws-phone",
    deviceId: "android-1",
    payload: { type: "list_apps", query: "maps" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = await readPhoneCommands({
    workspaceId: "ws-phone",
    deviceId: "android-1",
  });
  assert.equal(queued.commands.length, 1);
  assert.deepEqual(queued.commands[0]?.payload, {
    type: "list_apps",
    query: "maps",
  });
  completePhoneCommand({
    workspaceId: "ws-phone",
    deviceId: "android-1",
    commandId: queued.commands[0]!.commandId,
    ok: true,
    result: { apps: [{ label: "Maps", packageName: "com.example.maps" }] },
  });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(
    (result.result as { apps: Array<{ packageName: string }> }).apps[0]?.packageName,
    "com.example.maps"
  );
  assert.equal(
    (
      await readPhoneCommands({
        workspaceId: "ws-phone",
        deviceId: "android-1",
      })
    ).commands.length,
    0
  );
});

test("built-in phone MCP exposes explicit Android-safe tools and limits", async () => {
  resetPhoneControlForTests();
  assert.equal(PHONE_MCP_SERVER_ID, "phone");
  const names = new Set(PHONE_MCP_TOOLS.map((tool) => tool.name));
  assert.deepEqual(
    [
      "phone_devices",
      "phone_apps",
      "phone_snapshot",
      "phone_screenshot",
      "phone_tap",
      "phone_type",
      "phone_swipe",
      "phone_global_action",
      "phone_settings",
      "phone_secondary_display",
    ].every((name) => names.has(name)),
    true
  );
  registerPhoneDevice({
    workspaceId: "ws-phone",
    deviceId: "android-1",
    capabilities: {
      ...defaultPhoneControlCapabilities(),
      accessibilityEnabled: true,
      screenSnapshot: true,
    },
  });
  const devices = await callBuiltInPhoneTool({
    workspaceId: "ws-phone",
    toolName: "phone_devices",
    arguments: {},
  });
  assert.match(devices, /android-1/);
  assert.match(devices, /thirdPartyAppsOnPrivateSecondaryDisplay/);
  assert.match(devices, /hardwareWakeWordForThirdPartyApps/);
});

test("built-in phone MCP waits for device execution and returns the result", async () => {
  resetPhoneControlForTests();
  registerPhoneDevice({
    workspaceId: "ws-phone",
    deviceId: "android-1",
  });
  const call = callBuiltInPhoneTool({
    workspaceId: "ws-phone",
    toolName: "phone_apps",
    arguments: { action: "list", query: "camera" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = await readPhoneCommands({
    workspaceId: "ws-phone",
    deviceId: "android-1",
  });
  completePhoneCommand({
    workspaceId: "ws-phone",
    deviceId: "android-1",
    commandId: queued.commands[0]!.commandId,
    ok: true,
    result: { apps: [{ label: "Camera", packageName: "com.android.camera" }] },
  });
  const output = await call;
  assert.match(output, /com\.android\.camera/);
});

test("built-in phone MCP refuses unavailable accessibility capabilities", async () => {
  resetPhoneControlForTests();
  registerPhoneDevice({
    workspaceId: "ws-phone",
    deviceId: "android-1",
  });
  await assert.rejects(
    callBuiltInPhoneTool({
      workspaceId: "ws-phone",
      toolName: "phone_snapshot",
      arguments: {},
    }),
    /screenSnapshot is unavailable/
  );
});
