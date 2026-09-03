import type { AgentBackendId } from "./protocol";
import { isHarnessEnabled } from "./active-agent-backends";

/** One user-facing harness, possibly backed by multiple transports. */
export type HarnessFamilyId =
  | "cesium"
  | "cursor"
  | "codex"
  | "opencode"
  | "devin"
  | "grok"
  | "claude"
  | "pi"
  | "antigravity";

export type HarnessTransportId = "native" | "sdk" | "acp" | "server" | "cli";

export type HarnessTransport = {
  id: HarnessTransportId;
  /** Short control label, e.g. "SDK" or "ACP". */
  label: string;
  backendId: AgentBackendId;
  /** One-line description of this transport. */
  description: string;
};

export type HarnessFamily = {
  id: HarnessFamilyId;
  /** Terse picker / settings-list name: Cursor, Codex, Cesium, … */
  label: string;
  /** Backend used for settings navigation and as the default transport. */
  settingsId: AgentBackendId;
  defaultTransportId: HarnessTransportId;
  transports: readonly HarnessTransport[];
};

export type HarnessTransportsState = Partial<{
  cursor: "sdk" | "acp";
  codex: "server" | "acp";
}>;

export const HARNESS_FAMILIES: readonly HarnessFamily[] = [
  {
    id: "cesium",
    label: "Cesium Agent (Beta)",
    settingsId: "cesium-agent",
    defaultTransportId: "native",
    transports: [
      {
        id: "native",
        label: "Cesium Agent",
        backendId: "cesium-agent",
        description:
          "First-party Cesium harness with direct inference APIs, tools, subagents, and compression.",
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    settingsId: "cursor-sdk",
    defaultTransportId: "sdk",
    transports: [
      {
        id: "sdk",
        label: "SDK",
        backendId: "cursor-sdk",
        description:
          "Cursor TypeScript SDK runtime. Uses the server-stored API key and enabled MCP servers from Plugins. Does not support Cursor CLI OAuth.",
      },
      {
        id: "acp",
        label: "ACP",
        backendId: "cursor-acp",
        description:
          "Cursor Agent CLI over ACP (`agent acp`). Sign in with `agent login` for the OAuth flow the TypeScript SDK does not expose.",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    settingsId: "codex-app-server",
    defaultTransportId: "server",
    transports: [
      {
        id: "server",
        label: "Server",
        backendId: "codex-app-server",
        description:
          "Codex App Server over JSON-RPC stdio. Uses ambient Codex auth and mirrors native plans into OpenCursor plan files. Default Codex transport.",
      },
      {
        id: "acp",
        label: "ACP",
        backendId: "codex-acp",
        description:
          "Codex CLI over ACP (`codex acp`). Same ambient Codex login as the app server, with the Agent Client Protocol session model.",
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    settingsId: "opencode-server",
    defaultTransportId: "server",
    transports: [
      {
        id: "server",
        label: "OpenCode",
        backendId: "opencode-server",
        description:
          "OpenCode native HTTP/SSE harness. Current uses OpenCode 1; the v2 Beta dialect is packaged in the same option.",
      },
    ],
  },
  {
    id: "devin",
    label: "Devin",
    settingsId: "devin-acp",
    defaultTransportId: "acp",
    transports: [
      {
        id: "acp",
        label: "ACP",
        backendId: "devin-acp",
        description:
          "Cognition Devin CLI over ACP (`devin acp`). Authenticate with `devin auth login` or set `WINDSURF_API_KEY`.",
      },
    ],
  },
  {
    id: "grok",
    label: "Grok Build",
    settingsId: "grok-build",
    defaultTransportId: "acp",
    transports: [
      {
        id: "acp",
        label: "ACP",
        backendId: "grok-build",
        description:
          "SpaceXAI Grok Build CLI over official ACP (`grok agent stdio`). Authenticate with `grok login --device-auth` or set `XAI_API_KEY`.",
      },
    ],
  },
  {
    id: "claude",
    label: "Claude Code",
    settingsId: "claude-code-sdk",
    defaultTransportId: "sdk",
    transports: [
      {
        id: "sdk",
        label: "SDK",
        backendId: "claude-code-sdk",
        description:
          "Anthropic Claude Agent SDK with stock Claude Code tools. Uses configured API/proxy auth and enabled MCP servers from Plugins.",
      },
    ],
  },
  {
    id: "pi",
    label: "Pi Agent",
    settingsId: "pi-agent",
    defaultTransportId: "native",
    transports: [
      {
        id: "native",
        label: "Pi Agent",
        backendId: "pi-agent",
        description:
          "Native Pi coding agent. Uses ~/.pi/agent by default so packages, extensions, skills, and settings match the CLI.",
      },
    ],
  },
  {
    id: "antigravity",
    label: "Google Antigravity",
    settingsId: "google-antigravity-acp",
    defaultTransportId: "acp",
    transports: [
      {
        id: "acp",
        label: "ACP",
        backendId: "google-antigravity-acp",
        description:
          "Google's official Antigravity ACP server (`agy_acp_server`, from the ACP Registry). Log in with Google directly through the server; Cesium never brokers tokens.",
      },
    ],
  },
] as const;

const FAMILY_BY_ID = new Map<string, HarnessFamily>(
  HARNESS_FAMILIES.map((family) => [family.id, family])
);
const FAMILY_BY_BACKEND = new Map<string, HarnessFamily>();
for (const family of HARNESS_FAMILIES) {
  for (const transport of family.transports) {
    FAMILY_BY_BACKEND.set(transport.backendId, family);
  }
}
FAMILY_BY_BACKEND.set("opencode-v2-beta", FAMILY_BY_ID.get("opencode")!);

export const HARNESS_FAMILY_SETTINGS_IDS: AgentBackendId[] = HARNESS_FAMILIES.map(
  (family) => family.settingsId
);

export function harnessFamilyById(familyId: string | null | undefined): HarnessFamily | null {
  if (!familyId) {
    return null;
  }
  return FAMILY_BY_ID.get(familyId) ?? null;
}

export function harnessFamilyForBackend(
  backendId: string | null | undefined
): HarnessFamily | null {
  if (!backendId) {
    return null;
  }
  return FAMILY_BY_BACKEND.get(backendId) ?? null;
}

export function harnessFamilyTransport(
  family: HarnessFamily,
  transportId: string | null | undefined
): HarnessTransport | null {
  if (!transportId) {
    return null;
  }
  return family.transports.find((transport) => transport.id === transportId) ?? null;
}

export function harnessTransportForBackend(
  backendId: string | null | undefined
): HarnessTransport | null {
  const family = harnessFamilyForBackend(backendId);
  if (!family || !backendId) {
    return null;
  }
  return family.transports.find((transport) => transport.backendId === backendId) ?? null;
}

export function harnessFamilyHasMultipleTransports(family: HarnessFamily): boolean {
  return family.transports.length > 1;
}

export function normalizeHarnessTransports(raw: unknown): HarnessTransportsState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const out: HarnessTransportsState = {};
  if (record.cursor === "sdk" || record.cursor === "acp") {
    out.cursor = record.cursor;
  }
  if (record.codex === "server" || record.codex === "acp") {
    out.codex = record.codex;
  }
  // `antigravity: "acp" | "cli"` existed while the legacy `agy` bridge was a
  // sibling transport; the family is ACP-only now, so the key is dropped.
  return out;
}

function storedTransportId(
  family: HarnessFamily,
  transports: HarnessTransportsState | undefined
): HarnessTransportId | null {
  if (family.id === "cursor") {
    return transports?.cursor ?? null;
  }
  if (family.id === "codex") {
    return transports?.codex ?? null;
  }
  return null;
}

/**
 * Infer the selected transport when Settings has no explicit preference.
 * If the default transport is turned off and another sibling is on, use that
 * sibling - this restores “only Cursor ACP enabled” installs.
 */
export function resolveHarnessFamilyTransport(
  family: HarnessFamily,
  options: {
    harnessTransports?: HarnessTransportsState;
    enabledHarnesses?: Partial<Record<string, boolean>>;
  } = {}
): HarnessTransport {
  const stored = storedTransportId(family, options.harnessTransports);
  const storedTransport = harnessFamilyTransport(family, stored);
  if (storedTransport) {
    return storedTransport;
  }

  const defaultTransport =
    family.transports.find((transport) => transport.id === family.defaultTransportId) ??
    family.transports[0]!;
  if (!harnessFamilyHasMultipleTransports(family)) {
    return defaultTransport;
  }

  const defaultEnabled = isHarnessEnabled(options.enabledHarnesses, defaultTransport.backendId);
  if (defaultEnabled) {
    return defaultTransport;
  }
  const enabledAlt = family.transports.find(
    (transport) =>
      transport.id !== defaultTransport.id &&
      isHarnessEnabled(options.enabledHarnesses, transport.backendId)
  );
  return enabledAlt ?? defaultTransport;
}

export function resolvePreferredHarnessBackendId(
  family: HarnessFamily,
  options: {
    harnessTransports?: HarnessTransportsState;
    enabledHarnesses?: Partial<Record<string, boolean>>;
  } = {}
): AgentBackendId {
  return resolveHarnessFamilyTransport(family, options).backendId;
}

/** Family is on when any of its transports is enabled (missing keys default on). */
export function isHarnessFamilyEnabled(
  enabledHarnesses: Partial<Record<string, boolean>> | undefined,
  family: HarnessFamily
): boolean {
  return family.transports.some((transport) =>
    isHarnessEnabled(enabledHarnesses, transport.backendId)
  );
}

export function applyHarnessFamilyEnabled(
  enabledHarnesses: Partial<Record<string, boolean>> | undefined,
  family: HarnessFamily,
  enabled: boolean
): Partial<Record<string, boolean>> {
  const next: Partial<Record<string, boolean>> = { ...(enabledHarnesses ?? {}) };
  for (const transport of family.transports) {
    next[transport.backendId] = enabled;
  }
  return next;
}

export function applyHarnessFamilyTransport(
  current: {
    enabledHarnesses?: Partial<Record<string, boolean>>;
    harnessTransports?: HarnessTransportsState;
  },
  family: HarnessFamily,
  transportId: HarnessTransportId
): {
  enabledHarnesses: Partial<Record<string, boolean>>;
  harnessTransports: HarnessTransportsState;
} {
  const transport = harnessFamilyTransport(family, transportId) ?? family.transports[0]!;
  const familyEnabled = isHarnessFamilyEnabled(current.enabledHarnesses, family);
  const enabledHarnesses: Partial<Record<string, boolean>> = {
    ...(current.enabledHarnesses ?? {}),
  };
  if (familyEnabled) {
    enabledHarnesses[transport.backendId] = true;
  }
  const harnessTransports: HarnessTransportsState = { ...(current.harnessTransports ?? {}) };
  if (family.id === "cursor" && (transport.id === "sdk" || transport.id === "acp")) {
    harnessTransports.cursor = transport.id;
  }
  if (family.id === "codex" && (transport.id === "server" || transport.id === "acp")) {
    harnessTransports.codex = transport.id;
  }
  return { enabledHarnesses, harnessTransports };
}

export function familyBackendIds(family: HarnessFamily): AgentBackendId[] {
  return family.transports.map((transport) => transport.backendId);
}

export function harnessFamilyLabelForBackend(backendId: string | null | undefined): string {
  return harnessFamilyForBackend(backendId)?.label ?? backendId ?? "";
}

/**
 * One picker row per family. If the open chat is already on a sibling
 * transport, keep that backend selected so switching families is the only
 * thing that changes the runtime.
 */
export function composerVisibleHarnesses<
  T extends { id: string; enabled?: boolean; label?: string },
>(
  backends: T[],
  options: {
    currentBackendId?: string | null;
    enabledHarnesses?: Partial<Record<string, boolean>>;
    harnessTransports?: HarnessTransportsState;
  } = {}
): T[] {
  const currentBackendId = options.currentBackendId ?? null;
  const seenFamilies = new Set<string>();
  const out: T[] = [];

  const pushFamily = (family: HarnessFamily, fallback: T | null) => {
    if (seenFamilies.has(family.id)) {
      return;
    }
    const familyEnabled = isHarnessFamilyEnabled(options.enabledHarnesses, family);
    const currentInFamily = family.transports.some(
      (transport) => transport.backendId === currentBackendId
    );
    if (!familyEnabled && !currentInFamily) {
      return;
    }
    seenFamilies.add(family.id);
    const preferredId = resolvePreferredHarnessBackendId(family, options);
    const pickId = currentInFamily ? currentBackendId! : preferredId;
    const picked =
      backends.find((backend) => backend.id === pickId) ??
      backends.find((backend) => backend.id === preferredId) ??
      fallback;
    if (!picked) {
      return;
    }
    out.push({
      ...picked,
      label: family.label,
    });
  };

  for (const family of HARNESS_FAMILIES) {
    const fallback =
      backends.find((backend) =>
        family.transports.some((transport) => transport.backendId === backend.id)
      ) ?? null;
    pushFamily(family, fallback);
  }

  for (const backend of backends) {
    const family = harnessFamilyForBackend(backend.id);
    if (family) {
      continue;
    }
    if (backend.enabled === false && backend.id !== currentBackendId) {
      continue;
    }
    if (
      backend.id !== currentBackendId &&
      !isHarnessEnabled(options.enabledHarnesses, backend.id)
    ) {
      continue;
    }
    out.push(backend);
  }

  return out;
}
