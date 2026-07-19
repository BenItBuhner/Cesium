import type {
  PhoneControlCapability,
  PhoneControlCommandPayload,
} from "@cesium/core/phone-control";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  dispatchPhoneCommand,
  getPhoneDevice,
  listPhoneDevices,
} from "../phone-control/service.js";

export const PHONE_MCP_SERVER_ID = "phone";

const deviceId = {
  type: "string",
  description:
    "Optional Android device id from phone_devices. The most recently seen connected phone is used when omitted.",
};

export const PHONE_MCP_TOOLS: Tool[] = [
  {
    name: "phone_devices",
    description:
      "List Android phones connected to this Cesium workspace and inspect their live, permission-derived capabilities. Call this before assuming accessibility, screenshots, assistant role, or secondary-display support.",
    inputSchema: {
      type: "object",
      properties: { deviceId },
      additionalProperties: false,
    },
  },
  {
    name: "phone_apps",
    description:
      "List launchable apps, or open an app by exact package name, app label, or a user-approved deep link.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        action: { type: "string", enum: ["list", "open"], default: "list" },
        query: { type: "string", description: "Optional app-name/package filter for list." },
        packageName: { type: "string" },
        appName: { type: "string" },
        deepLink: { type: "string", description: "Only http, https, and registered app schemes are accepted by Android." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "phone_snapshot",
    description:
      "Read the current Android accessibility hierarchy, visible text, bounds, view ids, actions, foreground package, and window metadata. Requires the user-enabled Cesium accessibility service. Prefer this semantic result over screenshots for text-only models.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        maxNodes: { type: "number", minimum: 1, maximum: 500, default: 250 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone_screenshot",
    description:
      "Capture the visible Android display as a JPEG data URL through the user-enabled accessibility service. Secure windows may be blank. Text-only models should use phone_snapshot instead.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        quality: { type: "number", minimum: 30, maximum: 95, default: 72 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone_tap",
    description:
      "Tap an accessibility node by visible text/view id, or tap screen coordinates. A successful dispatch does not prove the target app changed; verify with phone_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        text: { type: "string" },
        viewId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        longPressMs: { type: "number", minimum: 300, maximum: 5000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "phone_type",
    description:
      "Set or append text in the focused Android field or a field matched by visible label/view id. Requires the user-enabled accessibility service. Verify with phone_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        text: { type: "string" },
        targetText: { type: "string" },
        viewId: { type: "string" },
        replace: { type: "boolean", default: true },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "phone_swipe",
    description:
      "Dispatch a swipe gesture in physical screen coordinates. Verify the result with phone_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        durationMs: { type: "number", minimum: 100, maximum: 5000, default: 400 },
      },
      required: ["startX", "startY", "endX", "endY"],
      additionalProperties: false,
    },
  },
  {
    name: "phone_global_action",
    description:
      "Perform an Android accessibility global action such as Back, Home, Recents, notifications, quick settings, power dialog, lock, or screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        action: {
          type: "string",
          enum: [
            "back",
            "home",
            "recents",
            "notifications",
            "quick_settings",
            "power_dialog",
            "lock_screen",
            "take_screenshot",
          ],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "phone_settings",
    description:
      "Open a safe, explicit Android system settings page. Android may require the user to confirm changes.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        page: {
          type: "string",
          enum: [
            "accessibility",
            "assistant",
            "wifi",
            "bluetooth",
            "notifications",
            "display",
            "sound",
            "battery",
            "location",
            "security",
            "application",
          ],
        },
        packageName: { type: "string", description: "Required for page=application." },
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "phone_secondary_display",
    description:
      "Create, inspect, update, or close a private off-screen display owned by Cesium. Android allows Cesium's own assistant surface there, but an ordinary app cannot launch arbitrary third-party apps on this display; that requires OEM-only privileges.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId,
        action: { type: "string", enum: ["create", "status", "update", "close"] },
        width: { type: "number", minimum: 320, maximum: 2560, default: 1080 },
        height: { type: "number", minimum: 320, maximum: 2560, default: 1920 },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function requireCapability(
  workspaceId: string,
  requestedDeviceId: string | undefined,
  capability: PhoneControlCapability
): string {
  const device = getPhoneDevice(workspaceId, requestedDeviceId);
  if (!device) {
    throw new Error("No Android phone is registered for this workspace.");
  }
  if (!device.connected) {
    throw new Error(`Phone ${device.name} is offline.`);
  }
  if (!device.capabilities[capability]) {
    throw new Error(
      `Phone capability ${capability} is unavailable. Check Cesium's Phone & Assistant settings and the Android permission screens.`
    );
  }
  return device.deviceId;
}

async function run(
  workspaceId: string,
  requestedDeviceId: string | undefined,
  capability: PhoneControlCapability,
  payload: PhoneControlCommandPayload
): Promise<string> {
  const resolvedDeviceId = requireCapability(
    workspaceId,
    requestedDeviceId,
    capability
  );
  const result = await dispatchPhoneCommand({
    workspaceId,
    deviceId: resolvedDeviceId,
    payload,
  });
  if (!result.ok) {
    throw new Error(result.error || "The phone rejected the command.");
  }
  return json({
    ok: true,
    deviceId: resolvedDeviceId,
    result: result.result ?? null,
    verification:
      payload.type === "tap" ||
      payload.type === "long_press" ||
      payload.type === "swipe" ||
      payload.type === "type_text" ||
      payload.type === "global_action"
        ? "The command was delivered, but its UI effect is not assumed. Call phone_snapshot to verify the resulting state."
        : undefined,
  });
}

export async function callBuiltInPhoneTool(input: {
  workspaceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  const args = input.arguments;
  const requestedDeviceId = asString(args.deviceId);
  if (input.toolName === "phone_devices") {
    const all = listPhoneDevices(input.workspaceId);
    return json({
      devices: requestedDeviceId
        ? all.filter((device) => device.deviceId === requestedDeviceId)
        : all,
      platformLimits: {
        thirdPartyAppsOnPrivateSecondaryDisplay: false,
        hardwareWakeWordForThirdPartyApps: false,
        mediaProjectionRequiresPerSessionConsent: true,
        note:
          "These are Android security boundaries, not missing Cesium permissions. OEM/system-signed deployments can add privileged capabilities separately.",
      },
    });
  }
  if (input.toolName === "phone_apps") {
    const action = asString(args.action) ?? "list";
    if (action === "list") {
      return await run(input.workspaceId, requestedDeviceId, "appList", {
        type: "list_apps",
        query: asString(args.query),
      });
    }
    if (
      !asString(args.packageName) &&
      !asString(args.appName) &&
      !asString(args.deepLink)
    ) {
      throw new Error("phone_apps action=open requires packageName, appName, or deepLink.");
    }
    return await run(input.workspaceId, requestedDeviceId, "appLaunch", {
      type: "launch_app",
      packageName: asString(args.packageName),
      appName: asString(args.appName),
      deepLink: asString(args.deepLink),
    });
  }
  if (input.toolName === "phone_snapshot") {
    return await run(input.workspaceId, requestedDeviceId, "screenSnapshot", {
      type: "snapshot",
      maxNodes: Math.max(1, Math.min(500, Math.round(asNumber(args.maxNodes) ?? 250))),
    });
  }
  if (input.toolName === "phone_screenshot") {
    return await run(input.workspaceId, requestedDeviceId, "screenCapture", {
      type: "screenshot",
      quality: Math.max(30, Math.min(95, Math.round(asNumber(args.quality) ?? 72))),
    });
  }
  if (input.toolName === "phone_tap") {
    const longPressMs = asNumber(args.longPressMs);
    if (longPressMs !== undefined) {
      const x = asNumber(args.x);
      const y = asNumber(args.y);
      if (x === undefined || y === undefined) {
        throw new Error("Long press requires x and y coordinates.");
      }
      return await run(input.workspaceId, requestedDeviceId, "gestures", {
        type: "long_press",
        x,
        y,
        durationMs: Math.max(300, Math.min(5_000, Math.round(longPressMs))),
      });
    }
    if (
      asNumber(args.x) === undefined &&
      asNumber(args.y) === undefined &&
      !asString(args.text) &&
      !asString(args.viewId)
    ) {
      throw new Error("phone_tap requires text, viewId, or x and y.");
    }
    return await run(input.workspaceId, requestedDeviceId, "gestures", {
      type: "tap",
      x: asNumber(args.x),
      y: asNumber(args.y),
      text: asString(args.text),
      viewId: asString(args.viewId),
    });
  }
  if (input.toolName === "phone_type") {
    if (typeof args.text !== "string") {
      throw new Error("phone_type requires text.");
    }
    return await run(input.workspaceId, requestedDeviceId, "textInput", {
      type: "type_text",
      text: args.text,
      targetText: asString(args.targetText),
      viewId: asString(args.viewId),
      replace: args.replace !== false,
    });
  }
  if (input.toolName === "phone_swipe") {
    const coordinates = [
      asNumber(args.startX),
      asNumber(args.startY),
      asNumber(args.endX),
      asNumber(args.endY),
    ];
    if (coordinates.some((value) => value === undefined)) {
      throw new Error("phone_swipe requires all four coordinates.");
    }
    return await run(input.workspaceId, requestedDeviceId, "gestures", {
      type: "swipe",
      startX: coordinates[0]!,
      startY: coordinates[1]!,
      endX: coordinates[2]!,
      endY: coordinates[3]!,
      durationMs: Math.max(
        100,
        Math.min(5_000, Math.round(asNumber(args.durationMs) ?? 400))
      ),
    });
  }
  if (input.toolName === "phone_global_action") {
    const action = asString(args.action);
    const allowed = new Set([
      "back",
      "home",
      "recents",
      "notifications",
      "quick_settings",
      "power_dialog",
      "lock_screen",
      "take_screenshot",
    ]);
    if (!action || !allowed.has(action)) {
      throw new Error("phone_global_action received an unsupported action.");
    }
    return await run(input.workspaceId, requestedDeviceId, "globalActions", {
      type: "global_action",
      action: action as Extract<
        PhoneControlCommandPayload,
        { type: "global_action" }
      >["action"],
    });
  }
  if (input.toolName === "phone_settings") {
    const page = asString(args.page);
    const allowed = new Set([
      "accessibility",
      "assistant",
      "wifi",
      "bluetooth",
      "notifications",
      "display",
      "sound",
      "battery",
      "location",
      "security",
      "application",
    ]);
    if (!page || !allowed.has(page)) {
      throw new Error("phone_settings received an unsupported settings page.");
    }
    return await run(input.workspaceId, requestedDeviceId, "settings", {
      type: "open_settings",
      page: page as Extract<
        PhoneControlCommandPayload,
        { type: "open_settings" }
      >["page"],
      packageName: asString(args.packageName),
    });
  }
  if (input.toolName === "phone_secondary_display") {
    const action = asString(args.action);
    if (
      action !== "create" &&
      action !== "status" &&
      action !== "update" &&
      action !== "close"
    ) {
      throw new Error("phone_secondary_display received an unsupported action.");
    }
    return await run(input.workspaceId, requestedDeviceId, "secondaryDisplay", {
      type: "secondary_display",
      action,
      width: asNumber(args.width),
      height: asNumber(args.height),
      title: asString(args.title),
      body: asString(args.body),
    });
  }
  throw new Error(`Unknown phone MCP tool: ${input.toolName}`);
}
