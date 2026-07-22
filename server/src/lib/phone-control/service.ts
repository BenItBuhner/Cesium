import { randomUUID } from "node:crypto";
import type {
  PhoneControlCapabilities,
  PhoneControlCommand,
  PhoneControlCommandPayload,
  PhoneControlCommandResult,
  PhoneControlDevice,
} from "@cesium/core/phone-control";
import {
  PHONE_CONTROL_PROTOCOL_VERSION,
  defaultPhoneControlCapabilities,
} from "@cesium/core/phone-control";

type RegisterPhoneDeviceInput = {
  workspaceId: string;
  deviceId: string;
  name?: string;
  capabilities?: Partial<PhoneControlCapabilities>;
  appVersion?: string;
  androidVersion?: string;
  sdkInt?: number;
  model?: string;
  deviceToken?: string;
};

const DEVICE_ONLINE_WINDOW_MS = 45_000;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_RETENTION_MS = 2 * 60_000;
const MAX_COMMANDS = 1_000;

const devices = new Map<string, PhoneControlDevice>();
const deviceTokens = new Map<string, string>();
const commands: PhoneControlCommand[] = [];
const commandResults = new Map<string, PhoneControlCommandResult>();
const resultWaiters = new Map<
  string,
  (result: PhoneControlCommandResult | null) => void
>();
const commandWaiters = new Map<string, Set<() => void>>();
let commandSeq = 0;

function deviceKey(workspaceId: string, deviceId: string): string {
  return `${workspaceId}\0${deviceId}`;
}

function connectedDevice(device: PhoneControlDevice, now = Date.now()): PhoneControlDevice {
  return {
    ...device,
    connected: now - device.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS,
  };
}

function touchDevice(workspaceId: string, deviceId: string): PhoneControlDevice {
  const key = deviceKey(workspaceId, deviceId);
  const current = devices.get(key);
  if (!current) {
    throw new Error("Phone device is not registered.");
  }
  const next = { ...current, connected: true, lastSeenAt: Date.now() };
  devices.set(key, next);
  return next;
}

function prune(now = Date.now()): void {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (!command || now - command.createdAt <= COMMAND_RETENTION_MS) {
      continue;
    }
    commands.splice(index, 1);
    commandResults.delete(command.commandId);
    const waiter = resultWaiters.get(command.commandId);
    if (waiter) {
      resultWaiters.delete(command.commandId);
      waiter(null);
    }
  }
  for (const [commandId, result] of commandResults) {
    if (now - result.completedAt > COMMAND_RETENTION_MS) {
      commandResults.delete(commandId);
    }
  }
}

function notifyCommandWaiters(workspaceId: string, deviceId: string): void {
  const key = deviceKey(workspaceId, deviceId);
  const waiters = commandWaiters.get(key);
  if (!waiters) {
    return;
  }
  commandWaiters.delete(key);
  for (const resolve of waiters) {
    resolve();
  }
}

export function registerPhoneDevice(
  input: RegisterPhoneDeviceInput
): PhoneControlDevice {
  const id = input.deviceId.trim();
  if (!id || id.length > 160) {
    throw new Error("A valid phone deviceId is required.");
  }
  const key = deviceKey(input.workspaceId, id);
  const presentedToken = input.deviceToken?.trim() || undefined;
  const existingToken = deviceTokens.get(key);
  // Registration is authorized by workspace access. The pairing token binds the
  // command channel (poll/result) to the latest device instance: re-registering
  // rotates the token unless the caller proves it already holds the current one,
  // so a reinstalled app can always re-pair while stale pollers are cut off.
  const token =
    presentedToken && presentedToken === existingToken
      ? existingToken
      : `phone-token:${randomUUID()}`;
  deviceTokens.set(key, token);
  const current = devices.get(key);
  const now = Date.now();
  const capabilities: PhoneControlCapabilities = {
    ...defaultPhoneControlCapabilities(),
    ...(input.capabilities ?? {}),
    thirdPartyAppsOnSecondaryDisplay: false,
    hardwareWakeWord: false,
  };
  const next: PhoneControlDevice = {
    deviceId: id,
    workspaceId: input.workspaceId,
    name: input.name?.trim().slice(0, 120) || current?.name || "Android phone",
    platform: "android",
    protocolVersion: PHONE_CONTROL_PROTOCOL_VERSION,
    capabilities,
    connected: true,
    registeredAt: current?.registeredAt ?? now,
    lastSeenAt: now,
    ...(input.appVersion?.trim() ? { appVersion: input.appVersion.trim() } : {}),
    ...(input.androidVersion?.trim()
      ? { androidVersion: input.androidVersion.trim() }
      : {}),
    ...(Number.isFinite(input.sdkInt) ? { sdkInt: input.sdkInt } : {}),
    ...(input.model?.trim() ? { model: input.model.trim().slice(0, 120) } : {}),
  };
  devices.set(key, next);
  return next;
}

export function registerPhoneDeviceSession(
  input: RegisterPhoneDeviceInput
): { device: PhoneControlDevice; deviceToken: string } {
  const device = registerPhoneDevice(input);
  return {
    device,
    deviceToken: deviceTokens.get(deviceKey(input.workspaceId, device.deviceId))!,
  };
}

export function authorizePhoneDevice(
  workspaceId: string,
  deviceId: string,
  deviceToken: string | undefined
): void {
  const expected = deviceTokens.get(deviceKey(workspaceId, deviceId));
  if (!expected || !deviceToken || deviceToken !== expected) {
    throw new Error("Phone pairing token is missing or invalid.");
  }
}

export function listPhoneDevices(workspaceId: string): PhoneControlDevice[] {
  const now = Date.now();
  return [...devices.values()]
    .filter((device) => device.workspaceId === workspaceId)
    .map((device) => connectedDevice(device, now))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export function getPhoneDevice(
  workspaceId: string,
  deviceId?: string | null
): PhoneControlDevice | null {
  if (deviceId) {
    const device = devices.get(deviceKey(workspaceId, deviceId));
    return device ? connectedDevice(device) : null;
  }
  return (
    listPhoneDevices(workspaceId).find((device) => device.connected) ??
    listPhoneDevices(workspaceId)[0] ??
    null
  );
}

export function unregisterPhoneDevice(
  workspaceId: string,
  deviceId: string
): boolean {
  const key = deviceKey(workspaceId, deviceId);
  deviceTokens.delete(key);
  return devices.delete(key);
}

export function enqueuePhoneCommand(input: {
  workspaceId: string;
  deviceId?: string;
  payload: PhoneControlCommandPayload;
  timeoutMs?: number;
}): PhoneControlCommand {
  prune();
  const device = getPhoneDevice(input.workspaceId, input.deviceId);
  if (!device) {
    throw new Error("No Android phone is registered for this workspace.");
  }
  if (!device.connected) {
    throw new Error(`Phone ${device.name} is offline.`);
  }
  commandSeq += 1;
  const now = Date.now();
  const command: PhoneControlCommand = {
    commandId: `phone:${randomUUID()}`,
    seq: commandSeq,
    workspaceId: input.workspaceId,
    deviceId: device.deviceId,
    createdAt: now,
    expiresAt: now + Math.max(1_000, Math.min(input.timeoutMs ?? COMMAND_TIMEOUT_MS, 60_000)),
    payload: input.payload,
  };
  commands.push(command);
  if (commands.length > MAX_COMMANDS) {
    commands.splice(0, commands.length - MAX_COMMANDS);
  }
  notifyCommandWaiters(input.workspaceId, device.deviceId);
  return command;
}

export async function waitForPhoneCommandResult(
  command: PhoneControlCommand
): Promise<PhoneControlCommandResult> {
  const existing = commandResults.get(command.commandId);
  if (existing) {
    return existing;
  }
  const timeoutMs = Math.max(0, command.expiresAt - Date.now());
  const result = await new Promise<PhoneControlCommandResult | null>((resolve) => {
    const timer = setTimeout(() => {
      resultWaiters.delete(command.commandId);
      resolve(null);
    }, timeoutMs);
    resultWaiters.set(command.commandId, (next) => {
      clearTimeout(timer);
      resolve(next);
    });
  });
  if (!result) {
    throw new Error(
      "The phone did not complete the command before it expired. Confirm Cesium phone control is enabled and the device is online."
    );
  }
  return result;
}

export async function dispatchPhoneCommand(input: {
  workspaceId: string;
  deviceId?: string;
  payload: PhoneControlCommandPayload;
  timeoutMs?: number;
}): Promise<PhoneControlCommandResult> {
  const command = enqueuePhoneCommand(input);
  return await waitForPhoneCommandResult(command);
}

export async function readPhoneCommands(input: {
  workspaceId: string;
  deviceId: string;
  afterSeq?: number;
  waitMs?: number;
}): Promise<{ commands: PhoneControlCommand[]; cursor: number }> {
  touchDevice(input.workspaceId, input.deviceId);
  prune();
  const read = () =>
    commands.filter(
      (command) =>
        command.workspaceId === input.workspaceId &&
        command.deviceId === input.deviceId &&
        command.seq > (input.afterSeq ?? 0) &&
        command.expiresAt > Date.now() &&
        !commandResults.has(command.commandId)
    );
  let pending = read();
  const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, 25_000));
  if (pending.length === 0 && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const key = deviceKey(input.workspaceId, input.deviceId);
      const bucket = commandWaiters.get(key) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        bucket.delete(done);
        if (bucket.size === 0) {
          commandWaiters.delete(key);
        }
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      bucket.add(done);
      commandWaiters.set(key, bucket);
    });
    touchDevice(input.workspaceId, input.deviceId);
    pending = read();
  }
  return {
    commands: pending,
    cursor: Math.max(input.afterSeq ?? 0, ...pending.map((command) => command.seq)),
  };
}

export function completePhoneCommand(input: {
  workspaceId: string;
  deviceId: string;
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}): PhoneControlCommandResult {
  touchDevice(input.workspaceId, input.deviceId);
  const existing = commandResults.get(input.commandId);
  if (existing) {
    return existing;
  }
  const command = commands.find(
    (candidate) =>
      candidate.commandId === input.commandId &&
      candidate.workspaceId === input.workspaceId &&
      candidate.deviceId === input.deviceId
  );
  if (!command) {
    throw new Error("Unknown phone command.");
  }
  const result: PhoneControlCommandResult = {
    commandId: command.commandId,
    seq: command.seq,
    workspaceId: command.workspaceId,
    deviceId: command.deviceId,
    ok: input.ok,
    completedAt: Date.now(),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.error?.trim() ? { error: input.error.trim() } : {}),
  };
  commandResults.set(command.commandId, result);
  const commandIndex = commands.findIndex(
    (candidate) => candidate.commandId === command.commandId
  );
  if (commandIndex >= 0) {
    commands.splice(commandIndex, 1);
  }
  const waiter = resultWaiters.get(command.commandId);
  if (waiter) {
    resultWaiters.delete(command.commandId);
    waiter(result);
  }
  return result;
}

export function resetPhoneControlForTests(): void {
  for (const waiter of resultWaiters.values()) {
    waiter(null);
  }
  for (const bucket of commandWaiters.values()) {
    for (const waiter of bucket) {
      waiter();
    }
  }
  devices.clear();
  deviceTokens.clear();
  commands.splice(0, commands.length);
  commandResults.clear();
  resultWaiters.clear();
  commandWaiters.clear();
  commandSeq = 0;
}
