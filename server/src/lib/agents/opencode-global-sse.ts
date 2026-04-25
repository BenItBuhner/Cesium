import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEventInput } from "./types.js";

type SseTarget = {
  workspaceRoot: string;
  rootSessionId: string;
  baseUrl: string;
  onEvent: (directory: string, payload: Record<string, unknown>) => Promise<void>;
};

type PoolRow = {
  baseUrl: string;
  targets: Map<string, SseTarget>;
  abort: AbortController | null;
  loop: Promise<void> | null;
};

const pools = new Map<string, PoolRow>();
const subagentRootMemo = new Map<string, boolean>();

function pathResolveEq(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

export function extractOpenCodeEventSessionId(
  payloadType: string,
  props: Record<string, unknown>
): string | undefined {
  if (payloadType === "message.part.delta") {
    return typeof props.sessionID === "string" ? props.sessionID : undefined;
  }
  if (payloadType === "message.part.updated") {
    const part = props.part;
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const p = part as Record<string, unknown>;
      if (typeof p.sessionID === "string") {
        return p.sessionID;
      }
    }
  }
  return undefined;
}

async function fetchOpenCodeSessionInfo(
  baseUrl: string,
  directory: string,
  sessionId: string
): Promise<{ parentID?: string | null } | undefined> {
  try {
    const root = baseUrl.replace(/\/$/, "");
    const u = new URL(`${root}/session/${encodeURIComponent(sessionId)}`);
    u.searchParams.set("directory", directory);
    const res = await fetch(u, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return undefined;
    }
    const j = (await res.json()) as { data?: { parentID?: string | null } } | { parentID?: string | null };
    const row = "data" in j && j.data && typeof j.data === "object" ? j.data : (j as { parentID?: string | null });
    if (!row || typeof row !== "object") {
      return undefined;
    }
    return { parentID: row.parentID ?? null };
  } catch {
    return undefined;
  }
}

export async function openCodeEventBelongsToRootSession(input: {
  baseUrl: string;
  directory: string;
  eventSessionId: string;
  rootSessionId: string;
}): Promise<boolean> {
  if (input.eventSessionId === input.rootSessionId) {
    return false;
  }
  const memoKey = `${input.baseUrl}\0${input.directory}\0${input.eventSessionId}\0${input.rootSessionId}`;
  const fast = subagentRootMemo.get(memoKey);
  if (fast != null) {
    return fast;
  }

  let cur: string | undefined = input.eventSessionId;
  const visited = new Set<string>();
  for (let i = 0; i < 48 && cur && !visited.has(cur); i++) {
    visited.add(cur);
    if (cur === input.rootSessionId) {
      subagentRootMemo.set(memoKey, true);
      return true;
    }
    const info = await fetchOpenCodeSessionInfo(input.baseUrl, input.directory, cur);
    const parent = info?.parentID;
    if (typeof parent !== "string" || parent.length === 0) {
      subagentRootMemo.set(memoKey, false);
      return false;
    }
    cur = parent;
  }
  subagentRootMemo.set(memoKey, false);
  return false;
}

/** Lowercase and strip separators so `todo_write` / `todo-write` match `todowrite`. */
export function normalizeOpenCodeToolKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[_-]+/g, "");
}

/**
 * Built-in OpenCode tools (see anomalyco/opencode packages). Unknown names fall through to `"other"`.
 * @see https://github.com/anomalyco/opencode
 */
function mapOpenCodeToolNameToAcpKind(toolName: string): string {
  const key = normalizeOpenCodeToolKey(toolName);
  switch (key) {
    case "bash":
      return "execute";
    case "webfetch":
      return "fetch";
    case "edit":
    case "patch":
    case "write":
      return "edit";
    case "grep":
    case "glob":
    case "context7resolvelibraryid":
    case "context7getlibrarydocs":
      return "search";
    case "read":
      return "read";
    case "todowrite":
    case "todoread":
      return "todo";
    case "task":
      return "other";
    case "skill":
    case "question":
    case "invalid":
      return "other";
    default:
      if (key.startsWith("context7")) {
        return "search";
      }
      if (
        (key.startsWith("todo") && (key.includes("read") || key.includes("write") || key.includes("update"))) ||
        key === "writetodos" ||
        key === "readtodos"
      ) {
        return "todo";
      }
      return "other";
  }
}

function mapOpenCodeToolLocations(
  toolName: string,
  input: Record<string, unknown>
): Array<{ path: string }> {
  const tool = normalizeOpenCodeToolKey(toolName);
  const filePath =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.target_file === "string" && input.target_file) ||
    (typeof input.file === "string" && input.file) ||
    undefined;
  switch (tool) {
    case "read":
    case "edit":
    case "write":
      return filePath ? [{ path: filePath }] : [];
    case "glob":
    case "grep":
      return typeof input.path === "string" ? [{ path: input.path }] : [];
    default:
      return [];
  }
}

function toolPartStateInput(part: Record<string, unknown>): Record<string, unknown> {
  const state = part.state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as Record<string, unknown>;
    const input = s.input;
    if (input && typeof input === "object" && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
  }
  return {};
}

/** Preserve structured tool results so {@link extractToolEditPreview} can build diffs (OpenCode often uses objects, not strings). */
function openCodeToolRawOutputForPreview(
  output: unknown,
  meta: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (meta && typeof meta === "object") {
    Object.assign(out, meta);
  }
  if (typeof output === "string") {
    if (output.trim()) {
      out.output = output;
    }
  } else if (output && typeof output === "object" && !Array.isArray(output)) {
    Object.assign(out, output as Record<string, unknown>);
  }
  return out;
}

/**
 * Map OpenCode `message.part.updated` tool parts to ACP-shaped `session/update` records
 * so {@link AcpSessionHandle.handleNotification} can ingest them unchanged.
 */
export function openCodeToolPartToAcpSessionUpdate(part: Record<string, unknown>): Record<string, unknown> | null {
  if (part.type !== "tool") {
    return null;
  }
  const toolName = typeof part.tool === "string" ? part.tool : "tool";
  const callId = typeof part.callID === "string" ? part.callID : randomUUID();
  const state = part.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const st = state as Record<string, unknown>;
  const status = st.status;
  const input = toolPartStateInput(part);
  const kind = mapOpenCodeToolNameToAcpKind(toolName);
  const locations = mapOpenCodeToolLocations(toolName, input);

  if (status === "pending") {
    return {
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title: toolName,
      kind,
      status: "pending",
      locations,
      rawInput: input,
    };
  }

  if (status === "running") {
    const content: unknown[] = [];
    const meta = st.metadata;
    if (normalizeOpenCodeToolKey(toolName) === "bash" && meta && typeof meta === "object" && !Array.isArray(meta)) {
      const out = (meta as Record<string, unknown>).output;
      if (typeof out === "string" && out.trim()) {
        content.push({
          type: "content",
          content: { type: "text", text: out },
        });
      }
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: "in_progress",
      kind,
      title: toolName,
      locations,
      rawInput: input,
      ...(content.length > 0 ? { content } : {}),
    };
  }

  if (status === "completed") {
    const outputVal = st.output;
    const outputText = typeof outputVal === "string" ? outputVal : "";
    const title =
      typeof st.title === "string" && st.title.trim() ? st.title.trim() : toolName;
    const meta =
      st.metadata && typeof st.metadata === "object" && !Array.isArray(st.metadata)
        ? (st.metadata as Record<string, unknown>)
        : undefined;
    const rawOutput = openCodeToolRawOutputForPreview(outputVal, meta);
    const content: unknown[] = [];
    if (outputText.trim()) {
      content.push({
        type: "content",
        content: { type: "text", text: outputText },
      });
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: "completed",
      kind,
      title,
      locations,
      rawInput: input,
      ...(content.length > 0 ? { content } : {}),
      rawOutput,
    };
  }

  if (status === "error") {
    const err = typeof st.error === "string" ? st.error : "Tool error";
    const meta =
      st.metadata && typeof st.metadata === "object" && !Array.isArray(st.metadata)
        ? (st.metadata as Record<string, unknown>)
        : undefined;
    const rawOutput = openCodeToolRawOutputForPreview({ error: err }, meta);
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: "failed",
      kind,
      title: toolName,
      locations,
      rawInput: input,
      content: [
        {
          type: "content",
          content: { type: "text", text: err },
        },
      ],
      rawOutput,
    };
  }

  return null;
}

export function translateOpenCodeGlobalPayload(input: {
  conversationId: string;
  rootSessionId: string;
  payload: Record<string, unknown>;
}):
  | { kind: "session_update"; params: Record<string, unknown> }
  | { kind: "append"; events: AgentEventInput[] }
  | { kind: "none" } {
  const type = typeof input.payload.type === "string" ? input.payload.type : "";
  const props = input.payload.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return { kind: "none" };
  }
  const p = props as Record<string, unknown>;

  if (type === "message.part.updated") {
    const part = p.part;
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return { kind: "none" };
    }
    const update = openCodeToolPartToAcpSessionUpdate(part as Record<string, unknown>);
    if (!update) {
      return { kind: "none" };
    }
    const partSessionId = extractOpenCodeEventSessionId("message.part.updated", p);
    return {
      kind: "session_update",
      params: {
        sessionId: input.rootSessionId,
        update,
        _meta: {
          openCodeSse: true,
          ...(partSessionId && partSessionId !== input.rootSessionId
            ? { openCodeChildSessionId: partSessionId }
            : {}),
        },
      },
    };
  }

  if (type === "message.part.delta") {
    if (p.field !== "text") {
      return { kind: "none" };
    }
    const sid = typeof p.sessionID === "string" ? p.sessionID : "";
    const msgId = typeof p.messageID === "string" ? p.messageID : "";
    const delta = typeof p.delta === "string" ? p.delta : "";
    if (!sid || !msgId || !delta) {
      return { kind: "none" };
    }
    return {
      kind: "append",
      events: [
        {
          eventId: randomUUID(),
          conversationId: input.conversationId,
          kind: "assistant_message_chunk",
          messageId: `opencode-subagent:${sid}:${msgId}`,
          text: delta,
          raw: input.payload,
        },
      ],
    };
  }

  return { kind: "none" };
}

async function* iterateSseDataLines(
  url: string,
  signal: AbortSignal
): AsyncGenerator<string, void, undefined> {
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenCode SSE ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep < 0) {
        break;
      }
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of block.split("\n")) {
        const t = line.trimEnd();
        if (t.startsWith("data:")) {
          yield t.slice(5).trimStart();
        }
      }
    }
  }
}

async function runPoolLoop(poolKey: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const row = pools.get(poolKey);
    if (!row || row.targets.size === 0) {
      return;
    }
    const baseUrl = row.baseUrl.replace(/\/$/, "");
    const url = `${baseUrl}/global/event`;
    try {
      for await (const data of iterateSseDataLines(url, signal)) {
        if (signal.aborted) {
          return;
        }
        let env: unknown;
        try {
          env = JSON.parse(data);
        } catch {
          continue;
        }
        if (!env || typeof env !== "object") {
          continue;
        }
        const rec = env as Record<string, unknown>;
        const directory = typeof rec.directory === "string" ? rec.directory : "";
        const payload = rec.payload;
        if (!payload || typeof payload !== "object") {
          continue;
        }
        const p = payload as Record<string, unknown>;
        const pType = typeof p.type === "string" ? p.type : "";
        if (!pType || pType === "server.connected" || pType === "server.heartbeat") {
          continue;
        }
        const props = p.properties;
        if (!props || typeof props !== "object") {
          continue;
        }
        const eventSid = extractOpenCodeEventSessionId(pType, props as Record<string, unknown>);
        if (!eventSid) {
          continue;
        }

        const snapshot = pools.get(poolKey);
        if (!snapshot || snapshot.targets.size === 0) {
          return;
        }

        for (const target of snapshot.targets.values()) {
          if (directory && !pathResolveEq(directory, target.workspaceRoot)) {
            continue;
          }
          const ok = await openCodeEventBelongsToRootSession({
            baseUrl: snapshot.baseUrl,
            directory: target.workspaceRoot,
            eventSessionId: eventSid,
            rootSessionId: target.rootSessionId,
          });
          if (!ok) {
            continue;
          }
          await target.onEvent(directory || target.workspaceRoot, p as Record<string, unknown>);
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

function startPoolLoopIfNeeded(poolKey: string): void {
  const row = pools.get(poolKey);
  if (!row || row.loop) {
    return;
  }
  const ac = new AbortController();
  row.abort = ac;
  row.loop = runPoolLoop(poolKey, ac.signal).finally(() => {
    const r = pools.get(poolKey);
    if (r) {
      r.loop = null;
      r.abort = null;
    }
  });
}

export function attachOpenCodeGlobalSse(
  poolKey: string,
  registrationId: string,
  target: SseTarget
): void {
  let row = pools.get(poolKey);
  if (!row) {
    row = { baseUrl: target.baseUrl, targets: new Map(), abort: null, loop: null };
    pools.set(poolKey, row);
  }
  row.baseUrl = target.baseUrl;
  row.targets.set(registrationId, target);
  startPoolLoopIfNeeded(poolKey);
}

export function detachOpenCodeGlobalSse(poolKey: string, registrationId: string): void {
  const row = pools.get(poolKey);
  if (!row) {
    return;
  }
  row.targets.delete(registrationId);
  if (row.targets.size === 0) {
    row.abort?.abort();
    pools.delete(poolKey);
  }
}
