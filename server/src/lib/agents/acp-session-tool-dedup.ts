import { createHash } from "node:crypto";

const MAX_STABLE_LEN = 48_000;

/**
 * Produces a compact, order-stable string for ACP `session/update` params so that the same
 * logical tool announcement hashes identically (ignores key order / floating noise).
 */
function stableJsonForDedup(value: unknown, depth = 0): string {
  if (depth > 12) {
    return "…";
  }
  if (value == null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJsonForDedup(v, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    const keys = Object.keys(r).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ":" + stableJsonForDedup(r[k], depth + 1)).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * ACP sometimes re-issues the *same* `session/update` payload for a tool CallId after a later
 * user turn; we must not `append` those as new DB rows (and new WebSocket events).
 * Key is per {@link AcpSessionHandle} stdio connection — genuine new invocations have different
 * params and/or a different toolCallId.
 */
export function acpSessionInitialToolCallKey(
  toolCallId: string,
  record: Record<string, unknown>,
  params: unknown
): string {
  const material = {
    t: toolCallId,
    r: {
      type: record.type,
      subtype: record.subtype,
      kind: record.kind,
      title: record.title,
      /* Avoid hashing huge `content` blobs; locations/title/ids are enough to disambiguate. */
      id: (record as { id?: unknown }).id,
      tool_call: (record as { tool_call?: unknown }).tool_call,
      toolCall: (record as { toolCall?: unknown }).toolCall,
      tool_calls: (record as { tool_calls?: unknown }).tool_calls,
      locations: record.locations,
    },
    p: params,
  };
  const s = stableJsonForDedup(material);
  return createHash("sha256")
    .update(s.length > MAX_STABLE_LEN ? s.slice(0, MAX_STABLE_LEN) : s)
    .digest("hex");
}

/**
 * Deduplicate rapid identical `tool_call_update` re-broadcasts (same id + terminal-ish payload).
 */
export function acpSessionToolUpdateKey(
  toolCallId: string,
  record: Record<string, unknown>,
  params: unknown,
  status: string
): string {
  const material = { t: toolCallId, s: status, r: { type: record.type, kind: record.kind }, p: params };
  const s = stableJsonForDedup(material);
  return createHash("sha256")
    .update(s.length > MAX_STABLE_LEN ? s.slice(0, MAX_STABLE_LEN) : s)
    .digest("hex");
}
