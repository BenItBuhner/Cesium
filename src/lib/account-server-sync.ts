/**
 * Production cloud accounts inherit engines automatically. Manual URL / name
 * connect is a local-only fallback for unsigned or fully local clients.
 */

export function accountOwnsServers(cloud: {
  mode: string;
  status: string;
}): boolean {
  return cloud.status === "ready" && (cloud.mode === "clerk" || cloud.mode === "device");
}

export function shouldOfferManualServerConnect(cloud: {
  mode: string;
  status: string;
}): boolean {
  return !accountOwnsServers(cloud);
}

export function shouldShowServerUrlInDevicePicker(input: {
  cloud: { mode: string; status: string };
  isLocalDevice: boolean;
}): boolean {
  if (input.isLocalDevice) {
    return true;
  }
  return !accountOwnsServers(input.cloud);
}
