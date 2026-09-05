export const MCP_STATELESS_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SESSION_PROTOCOL_VERSION = "2025-11-25";

export const MCP_CLIENT_INFO = {
  name: "opencursor-cesium",
  version: "0.1.0",
} as const;

export type McpProtocolEra = "stateless" | "session";

export type McpProtocolProbeResult = {
  era: McpProtocolEra;
  version: string;
  ok: boolean;
  error?: string;
};

export type McpProtocolNegotiation = {
  selected: McpProtocolEra | null;
  selectedVersion: string | null;
  probes: McpProtocolProbeResult[];
};

export function mcpProtocolMeta(version = MCP_STATELESS_PROTOCOL_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

/**
 * Prefer the stateless 2026-07-28 core when the server answered it.
 * Otherwise keep the session/initialize dialect most current servers still speak.
 */
export function selectPreferredProtocol(
  probes: McpProtocolProbeResult[]
): McpProtocolNegotiation {
  const stateless = probes.find((probe) => probe.era === "stateless" && probe.ok);
  const session = probes.find((probe) => probe.era === "session" && probe.ok);
  if (stateless) {
    return {
      selected: "stateless",
      selectedVersion: stateless.version,
      probes,
    };
  }
  if (session) {
    return {
      selected: "session",
      selectedVersion: session.version,
      probes,
    };
  }
  return { selected: null, selectedVersion: null, probes };
}

export function describeProtocolNegotiation(
  negotiation: McpProtocolNegotiation
): string {
  if (negotiation.selected === "stateless") {
    return `Stateless MCP ${negotiation.selectedVersion}`;
  }
  if (negotiation.selected === "session") {
    return `Session MCP ${negotiation.selectedVersion}`;
  }
  const errors = negotiation.probes
    .filter((probe) => !probe.ok && probe.error)
    .map((probe) => `${probe.era}: ${probe.error}`)
    .join("; ");
  return errors || "MCP server did not answer stateless or session protocol probes.";
}

export function protocolStatusPayload(negotiation: McpProtocolNegotiation): {
  selected?: McpProtocolEra;
  selectedVersion?: string;
  stateless?: { ok: boolean; version?: string; error?: string };
  session?: { ok: boolean; version?: string; error?: string };
} {
  const stateless = negotiation.probes.find((probe) => probe.era === "stateless");
  const session = negotiation.probes.find((probe) => probe.era === "session");
  return {
    ...(negotiation.selected
      ? { selected: negotiation.selected, selectedVersion: negotiation.selectedVersion ?? undefined }
      : {}),
    ...(stateless
      ? {
          stateless: {
            ok: stateless.ok,
            version: stateless.ok ? stateless.version : undefined,
            error: stateless.error,
          },
        }
      : {}),
    ...(session
      ? {
          session: {
            ok: session.ok,
            version: session.ok ? session.version : undefined,
            error: session.error,
          },
        }
      : {}),
  };
}
