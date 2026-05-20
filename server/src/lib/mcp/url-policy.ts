import { URL } from "node:url";

const PRIVATE_IPV4_BLOCKS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
];

export function validateMcpRemoteUrl(
  rawUrl: string,
  options?: { allowInsecureLocalhost?: boolean }
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid MCP URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`MCP URL must be http(s): ${rawUrl}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol === "http:" && !isLocalhost) {
    throw new Error("HTTP MCP URLs are only allowed for localhost.");
  }
  if (isLocalhost && !options?.allowInsecureLocalhost && parsed.protocol === "http:") {
    return parsed;
  }
  if (parsed.protocol !== "https:" && !isLocalhost) {
    throw new Error("Remote MCP servers must use HTTPS.");
  }
  if (!options?.allowInsecureLocalhost) {
    for (const block of PRIVATE_IPV4_BLOCKS) {
      if (block.test(hostname)) {
        throw new Error("Private network MCP URLs are blocked unless allowInsecureLocalhost is enabled.");
      }
    }
  }
  return parsed;
}
