import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeSocket } from "../../ws/runtime-socket.js";

export const MOBILE_MCP_SERVER_ID = "mobile";

export type MobileControlCapability =
  | "device_info"
  | "open_apps"
  | "screen_capture"
  | "ui_automation"
  | "private_display"
  | "device_settings";

export type MobileControlDeviceInfo = {
  id: string;
  name: string;
  platform: "android";
  apiLevel: number;
  appVersion: string;
};

export type MobileControlDeviceSummary = MobileControlDeviceInfo & {
  connectedAt: number;
  capabilities: MobileControlCapability[];
};

type PendingInvocation = {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectedDevice = MobileControlDeviceSummary & {
  socket: RuntimeSocket;
  pending: Map<string, PendingInvocation>;
};

const devicesByWorkspace = new Map<string, Map<string, ConnectedDevice>>();
const MOBILE_CALL_TIMEOUT_MS = 45_000;

const deviceIdProperty = {
  type: "string",
  description:
    "Optional connected Android device id. Omit when exactly one device is connected.",
};
const displayIdProperty = {
  type: "integer",
  description: "Android display id. Omit for the user's primary display.",
};

export const MOBILE_MCP_TOOLS: Tool[] = [
  {
    name: "mobile_devices",
    description:
      "List connected Android devices and the capabilities currently granted by the user.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mobile_open_app",
    description:
      "Open an installed Android app or deep link. This is visible to the user unless displayId targets a private display.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        packageName: { type: "string", description: "Android package name." },
        uri: { type: "string", description: "Optional app deep link or web URL." },
        displayId: displayIdProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: "mobile_screen_snapshot",
    description:
      "Capture an Android display and optionally include a redacted accessibility hierarchy. Secure windows may be blank.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        displayId: displayIdProperty,
        includeImage: { type: "boolean", default: true },
        includeHierarchy: { type: "boolean", default: true },
        imageFormat: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
        quality: { type: "integer", minimum: 20, maximum: 100, default: 70 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mobile_ui_tree",
    description:
      "Read the current accessibility hierarchy with text, labels, ids, state, and screen bounds. Password text is always redacted.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        displayId: displayIdProperty,
        maxNodes: { type: "integer", minimum: 1, maximum: 1000, default: 400 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mobile_tap",
    description:
      "Dispatch a tap through the user-enabled Android accessibility service. Follow with mobile_screen_snapshot or mobile_ui_tree to verify the effect.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        displayId: displayIdProperty,
        x: { type: "number" },
        y: { type: "number" },
        durationMs: { type: "integer", minimum: 1, maximum: 2000, default: 80 },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_swipe",
    description:
      "Dispatch a swipe through Android accessibility. Follow with an observation tool to verify the effect.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        displayId: displayIdProperty,
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        durationMs: { type: "integer", minimum: 50, maximum: 5000, default: 400 },
      },
      required: ["startX", "startY", "endX", "endY"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_type_text",
    description:
      "Set text on the focused editable accessibility node. Existing text is replaced unless append=true.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        text: { type: "string" },
        append: { type: "boolean", default: false },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_global_action",
    description:
      "Run an Android accessibility global action such as back, home, recents, notifications, quick settings, or power dialog.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
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
    name: "mobile_private_display",
    description:
      "Create, list, capture, or destroy app-owned private virtual displays that are not shown on the physical screen.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        action: { type: "string", enum: ["create", "list", "capture", "destroy"] },
        displayId: displayIdProperty,
        width: { type: "integer", minimum: 320, maximum: 3840, default: 1080 },
        height: { type: "integer", minimum: 320, maximum: 3840, default: 1920 },
        densityDpi: { type: "integer", minimum: 120, maximum: 640, default: 420 },
        imageFormat: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
        quality: { type: "integer", minimum: 20, maximum: 100, default: 70 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_launch_on_display",
    description:
      "Launch an app or deep link on a private virtual display. Android may reject apps that disallow secondary displays.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        displayId: displayIdProperty,
        packageName: { type: "string" },
        uri: { type: "string" },
      },
      required: ["displayId"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_open_settings",
    description:
      "Open a user-visible Android settings panel. Supported panels include wifi, bluetooth, accessibility, assistant, notifications, location, and app_details.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        panel: {
          type: "string",
          enum: [
            "wifi",
            "bluetooth",
            "accessibility",
            "assistant",
            "notifications",
            "location",
            "app_details",
          ],
        },
      },
      required: ["panel"],
      additionalProperties: false,
    },
  },
  {
    name: "mobile_set_volume",
    description:
      "Set a media, ring, alarm, notification, or voice-call stream volume as a percentage.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: deviceIdProperty,
        stream: {
          type: "string",
          enum: ["media", "ring", "alarm", "notification", "voice_call"],
          default: "media",
        },
        percent: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["percent"],
      additionalProperties: false,
    },
  },
];

const requiredCapabilityByTool: Partial<Record<string, MobileControlCapability>> = {
  mobile_open_app: "open_apps",
  mobile_screen_snapshot: "screen_capture",
  mobile_ui_tree: "ui_automation",
  mobile_tap: "ui_automation",
  mobile_swipe: "ui_automation",
  mobile_type_text: "ui_automation",
  mobile_global_action: "ui_automation",
  mobile_private_display: "private_display",
  mobile_launch_on_display: "private_display",
  mobile_open_settings: "device_settings",
  mobile_set_volume: "device_settings",
};

function workspaceDevices(workspaceId: string): Map<string, ConnectedDevice> {
  const existing = devicesByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created = new Map<string, ConnectedDevice>();
  devicesByWorkspace.set(workspaceId, created);
  return created;
}

function publicDevice(device: ConnectedDevice): MobileControlDeviceSummary {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    apiLevel: device.apiLevel,
    appVersion: device.appVersion,
    connectedAt: device.connectedAt,
    capabilities: [...device.capabilities],
  };
}

export function listMobileControlDevices(workspaceId: string): MobileControlDeviceSummary[] {
  return [...(devicesByWorkspace.get(workspaceId)?.values() ?? [])]
    .map(publicDevice)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function registerMobileControlDevice(input: {
  workspaceId: string;
  socket: RuntimeSocket;
  device: MobileControlDeviceInfo;
  capabilities: MobileControlCapability[];
}): () => void {
  const devices = workspaceDevices(input.workspaceId);
  const previous = devices.get(input.device.id);
  if (previous) {
    rejectPending(previous, "Android device connection was replaced.");
    previous.socket.close(1012, "Replaced by a newer device connection");
  }
  const connected: ConnectedDevice = {
    ...input.device,
    connectedAt: Date.now(),
    capabilities: [...new Set(input.capabilities)],
    socket: input.socket,
    pending: new Map(),
  };
  devices.set(input.device.id, connected);
  return () => {
    if (devices.get(input.device.id) !== connected) return;
    devices.delete(input.device.id);
    rejectPending(connected, "Android device disconnected.");
    if (devices.size === 0) devicesByWorkspace.delete(input.workspaceId);
  };
}

export function resolveMobileControlInvocation(input: {
  workspaceId: string;
  deviceId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}): boolean {
  const device = devicesByWorkspace.get(input.workspaceId)?.get(input.deviceId);
  const pending = device?.pending.get(input.requestId);
  if (!device || !pending) return false;
  device.pending.delete(input.requestId);
  clearTimeout(pending.timer);
  if (input.ok) {
    pending.resolve(
      typeof input.result === "string" ? input.result : JSON.stringify(input.result ?? null, null, 2)
    );
  } else {
    pending.reject(new Error(input.error?.trim() || "Android device tool call failed."));
  }
  return true;
}

export async function callBuiltInMobileTool(input: {
  workspaceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  if (input.toolName === "mobile_devices") {
    return JSON.stringify({ devices: listMobileControlDevices(input.workspaceId) }, null, 2);
  }
  if (!MOBILE_MCP_TOOLS.some((tool) => tool.name === input.toolName)) {
    throw new Error(`Unknown mobile MCP tool: ${input.toolName}`);
  }
  const devices = devicesByWorkspace.get(input.workspaceId);
  const requestedDeviceId =
    typeof input.arguments.deviceId === "string" ? input.arguments.deviceId.trim() : "";
  const device = requestedDeviceId
    ? devices?.get(requestedDeviceId)
    : devices?.size === 1
      ? [...devices.values()][0]
      : undefined;
  if (!device) {
    if (!devices?.size) throw new Error("No Android device is connected to this workspace.");
    throw new Error(
      requestedDeviceId
        ? `Android device is not connected: ${requestedDeviceId}`
        : "Multiple Android devices are connected; provide deviceId."
    );
  }
  const required = requiredCapabilityByTool[input.toolName];
  if (required && !device.capabilities.includes(required)) {
    throw new Error(
      `${input.toolName} requires Android capability ${required}, which the user has not granted.`
    );
  }
  if (!device.socket.isOpen) {
    throw new Error(`Android device is disconnected: ${device.id}`);
  }
  const requestId = randomUUID();
  const forwardedArguments = { ...input.arguments };
  delete forwardedArguments.deviceId;
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      device.pending.delete(requestId);
      reject(new Error(`${input.toolName} timed out on Android after 45s.`));
    }, MOBILE_CALL_TIMEOUT_MS);
    device.pending.set(requestId, { resolve, reject, timer });
    device.socket.send(
      JSON.stringify({
        type: "invoke",
        requestId,
        toolName: input.toolName,
        arguments: forwardedArguments,
      })
    );
  });
}

function rejectPending(device: ConnectedDevice, message: string): void {
  for (const pending of device.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  device.pending.clear();
}

export function clearMobileControlDevicesForTests(): void {
  for (const devices of devicesByWorkspace.values()) {
    for (const device of devices.values()) {
      rejectPending(device, "Mobile control test registry reset.");
    }
  }
  devicesByWorkspace.clear();
}
