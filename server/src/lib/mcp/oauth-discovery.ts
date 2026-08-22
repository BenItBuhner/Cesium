export type OAuthAuthorizationServerMetadata = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
};

export type OAuthProtectedResourceMetadata = {
  resource?: string;
  authorization_servers?: string[];
};

export type McpAuthProbeResult = {
  kind: "none" | "oauth" | "unknown";
  resource?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  discoveryUrl?: string;
  resourceMetadataUrl?: string;
};

type FetchLike = typeof fetch;

function joinUrl(base: string, pathname: string): string {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  return url.toString();
}

export function parseWwwAuthenticate(header: string): {
  scheme?: string;
  resourceMetadata?: string;
} {
  const trimmed = header.trim();
  const scheme = trimmed.split(/\s+/, 1)[0];
  const metadataMatch = trimmed.match(/resource_metadata="([^"]+)"/i);
  return {
    ...(scheme ? { scheme } : {}),
    ...(metadataMatch?.[1] ? { resourceMetadata: metadataMatch[1] } : {}),
  };
}

export function wellKnownProtectedResourceUrl(remoteUrl: string): string {
  const url = new URL(remoteUrl);
  return `${url.origin}/.well-known/oauth-protected-resource`;
}

export function wellKnownAuthorizationServerUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    return `${url.origin}/.well-known/oauth-authorization-server`;
  }
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

export async function fetchJsonDocument(
  url: string,
  http: FetchLike = fetch
): Promise<Record<string, unknown>> {
  const response = await http(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OAuth discovery failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function discoverProtectedResource(
  resourceMetadataUrl: string,
  http: FetchLike = fetch
): Promise<OAuthProtectedResourceMetadata> {
  const doc = await fetchJsonDocument(resourceMetadataUrl, http);
  const servers = Array.isArray(doc.authorization_servers)
    ? doc.authorization_servers.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...(typeof doc.resource === "string" ? { resource: doc.resource } : {}),
    ...(servers.length > 0 ? { authorization_servers: servers } : {}),
  };
}

export async function discoverAuthorizationServer(
  discoveryUrl: string,
  http: FetchLike = fetch
): Promise<OAuthAuthorizationServerMetadata> {
  const doc = await fetchJsonDocument(discoveryUrl, http);
  return {
    ...(typeof doc.authorization_endpoint === "string"
      ? { authorization_endpoint: doc.authorization_endpoint }
      : {}),
    ...(typeof doc.token_endpoint === "string" ? { token_endpoint: doc.token_endpoint } : {}),
    ...(typeof doc.registration_endpoint === "string"
      ? { registration_endpoint: doc.registration_endpoint }
      : {}),
    ...(Array.isArray(doc.code_challenge_methods_supported)
      ? {
          code_challenge_methods_supported: doc.code_challenge_methods_supported.filter(
            (value): value is string => typeof value === "string"
          ),
        }
      : {}),
  };
}

export async function registerOAuthClient(input: {
  registrationUrl: string;
  redirectUri: string;
  clientName?: string;
  http?: FetchLike;
}): Promise<{ clientId: string; clientSecret?: string }> {
  const http = input.http ?? fetch;
  const response = await http(input.registrationUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: input.clientName?.trim() || "Cesium",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OAuth client registration failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
  };
  if (!payload.client_id?.trim()) {
    throw new Error("OAuth client registration did not return a client_id.");
  }
  return {
    clientId: payload.client_id.trim(),
    ...(payload.client_secret?.trim() ? { clientSecret: payload.client_secret.trim() } : {}),
  };
}

export async function probeMcpRemoteAuth(
  remoteUrl: string,
  http: FetchLike = fetch
): Promise<McpAuthProbeResult> {
  let resourceMetadataUrl: string | undefined;
  try {
    const response = await http(remoteUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
    });
    const authenticate = response.headers.get("www-authenticate");
    if (authenticate) {
      resourceMetadataUrl = parseWwwAuthenticate(authenticate).resourceMetadata;
    }
    if (!resourceMetadataUrl && (response.status === 401 || response.status === 403)) {
      resourceMetadataUrl = wellKnownProtectedResourceUrl(remoteUrl);
    }
  } catch {
    resourceMetadataUrl = wellKnownProtectedResourceUrl(remoteUrl);
  }

  if (!resourceMetadataUrl) {
    try {
      resourceMetadataUrl = wellKnownProtectedResourceUrl(remoteUrl);
    } catch {
      return { kind: "unknown" };
    }
  }

  try {
    const resource = await discoverProtectedResource(resourceMetadataUrl, http);
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) {
      return {
        kind: "unknown",
        resource: resource.resource,
        resourceMetadataUrl,
      };
    }
    const discoveryUrl = issuer.includes("/.well-known/")
      ? issuer
      : wellKnownAuthorizationServerUrl(issuer);
    const as = await discoverAuthorizationServer(discoveryUrl, http);
    if (!as.authorization_endpoint || !as.token_endpoint) {
      return {
        kind: "unknown",
        resource: resource.resource ?? remoteUrl,
        discoveryUrl,
        resourceMetadataUrl,
      };
    }
    return {
      kind: "oauth",
      resource: resource.resource ?? remoteUrl,
      authorizationUrl: as.authorization_endpoint,
      tokenUrl: as.token_endpoint,
      registrationUrl: as.registration_endpoint,
      discoveryUrl,
      resourceMetadataUrl,
    };
  } catch {
    return { kind: "none", resourceMetadataUrl };
  }
}

export function mcpResourceFromRemoteUrl(remoteUrl: string): string {
  try {
    return joinUrl(remoteUrl, "").replace(/\/+$/, "") || remoteUrl;
  } catch {
    return remoteUrl;
  }
}
