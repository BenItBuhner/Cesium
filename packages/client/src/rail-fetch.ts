import type { ServerConnection } from "./server-connections";

type RailServerHealth = "unknown" | "online" | "offline" | "auth_required" | "degraded";

type RailServerStatus = {
  health: RailServerHealth;
};

/** Per-server rail request budget — hung TCP must not block the sidebar forever. */
export const RAIL_FETCH_TIMEOUT_MS = 12_000;

/** Hard stop for the initial rail spinner even if every fetch misbehaves. */
export const RAIL_INITIAL_LOAD_FAILSAFE_MS = 20_000;

export async function withRailFetchTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = RAIL_FETCH_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Only fan out to servers with a verified health probe. While probes are still
 * `"unknown"`, fetch the active server alone so dead saved URLs cannot block
 * `Promise.all` on the first paint.
 */
export function resolveRailFetchServers(input: {
  activeServer: ServerConnection;
  onlineServers: ServerConnection[];
  serverStatusById: Record<string, RailServerStatus>;
}): ServerConnection[] {
  const { activeServer, onlineServers, serverStatusById } = input;
  const candidates = onlineServers.length > 0 ? onlineServers : [activeServer];
  const verified = candidates.filter((server) => {
    const health = serverStatusById[server.id]?.health ?? "unknown";
    return health === "online" || health === "auth_required";
  });
  if (verified.length > 0) {
    return verified;
  }
  return [activeServer];
}
