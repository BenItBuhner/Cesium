import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpJsonRpcError, AcpStdioClient } from "./acp-transport.js";
import {
  acpSessionInitialToolCallKey,
  acpSessionToolUpdateKey,
} from "./acp-session-tool-dedup.js";
import {
  type AcpSharedBridge,
  makeAcpPoolKey,
  retainAcpSharedBridge,
} from "./acp-shared-bridge.js";
import {
  attachOpenCodeGlobalSse,
  detachOpenCodeGlobalSse,
  normalizeOpenCodeToolKey,
  translateOpenCodeGlobalPayload,
} from "./opencode-global-sse.js";
import {
  buildOpenCodeAcpCliArgs,
  getOpenCodeAcpListenPort,
  openCodeAcpInternalBaseUrl,
} from "./opencode-acp-port.js";
import {
  createClaudeAdapterProvider,
  createCodexAdapterProvider,
  type CliRuntimeSpec,
} from "./cli-adapter.js";
import {
  readAgentBackendConfigCache,
  writeAgentBackendConfigCache,
} from "./provider-cache-store.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConfigOptionCategory,
  AgentConversationMode,
  AgentConversationRecord,
  AgentPermissionOption,
  AgentPlanEntry,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentToolCallStatus,
} from "./types.js";
import {
  configOptionMatchesCategory,
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";
import { formatRejectedToolDetail } from "./tool-rejection-utils.js";
import {
  formatDeleteToolTitle,
  formatFindToolTitle,
  formatGrepToolTitle,
  formatReadToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  formatWebSearchTitle,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import { inferFileKind, isDimmed } from "../workspace.js";
import {
  getGlobalSettings,
  saveRememberedAgentPermissionRule,
} from "../global-settings-store.js";
import { extractInlineReasoning } from "./parse-inline-reasoning.js";

function tryParseJsonArrayString(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** ACP `plan` updates vary by server: `entries`, `todos`, stringified JSON, or nested under `data`. */
function parseTodoLikeArrayFromPlanRecord(record: Record<string, unknown>): unknown[] | undefined {
  const fromData =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  return (
    tryParseJsonArrayString(record.entries) ??
    tryParseJsonArrayString(record.todos) ??
    tryParseJsonArrayString(record.items) ??
    (fromData
      ? tryParseJsonArrayString(fromData.entries) ??
        tryParseJsonArrayString(fromData.todos) ??
        tryParseJsonArrayString(fromData.items)
      : undefined)
  );
}

function agentPlanEntriesFromTodoLikeList(
  list: unknown[] | undefined,
  conversationId: string,
  idPrefix: string
): AgentPlanEntry[] {
  if (!list?.length) {
    return [];
  }
  const entries: AgentPlanEntry[] = [];
  for (const [index, todo] of list.entries()) {
    if (!todo || typeof todo !== "object") {
      continue;
    }
    const todoRecord = todo as Record<string, unknown>;
    const content =
      typeof todoRecord.content === "string"
        ? todoRecord.content
        : typeof todoRecord.text === "string"
          ? todoRecord.text
          : typeof todoRecord.title === "string"
            ? todoRecord.title
            : "";
    const status =
      todoRecord.status === "pending" ||
      todoRecord.status === "in_progress" ||
      todoRecord.status === "completed"
        ? todoRecord.status
        : "pending";
    const trimmed = content.trim();
    if (!trimmed) {
      continue;
    }
    entries.push({
      id:
        typeof todoRecord.id === "string"
          ? todoRecord.id
          : `${conversationId}-${idPrefix}-${index}`,
      content: trimmed,
      priority:
        typeof todoRecord.priority === "string" ? todoRecord.priority : undefined,
      status,
    });
  }
  return entries;
}

function isOpenCodeGlobalSseParams(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const meta = (params as Record<string, unknown>)._meta;
  return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>).openCodeSse === true);
}

function openCodeTodoArrayFromToolRecord(record: Record<string, unknown>): unknown[] | undefined {
  const input = parseLooseJsonObjectForAcp(record.rawInput) ?? parseLooseJsonObjectForAcp(record.raw_input);
  const output = parseLooseJsonObjectForAcp(record.rawOutput) ?? parseLooseJsonObjectForAcp(record.raw_output);
  const pick = (obj: Record<string, unknown> | undefined): unknown[] | undefined => {
    if (!obj) {
      return undefined;
    }
    return (
      tryParseJsonArrayString(obj.todos) ??
      tryParseJsonArrayString(obj.items) ??
      (Array.isArray(obj.list) ? (obj.list as unknown[]) : undefined)
    );
  };
  return pick(input) ?? pick(output);
}

function shouldMirrorOpenCodeTodoToolToPlan(
  params: unknown,
  record: Record<string, unknown>,
  toolKind: string,
  status: string,
  title: string | undefined
): boolean {
  if (status !== "completed") {
    return false;
  }
  if (!isOpenCodeGlobalSseParams(params)) {
    return false;
  }
  if (toolKind === "todo") {
    return true;
  }
  const rawTitle = typeof record.title === "string" ? record.title : title;
  const k = normalizeOpenCodeToolKey(rawTitle ?? "");
  if (k === "todowrite" || k === "todoread") {
    return true;
  }
  if (k.startsWith("todo") && (k.includes("read") || k.includes("write") || k.includes("update"))) {
    return true;
  }
  return false;
}

async function appendOpenCodeTodoPlanIfNeeded(
  callbacks: AgentRuntimeCallbacks,
  params: unknown,
  record: Record<string, unknown>,
  toolKind: string,
  status: string,
  title: string | undefined
): Promise<void> {
  if (!shouldMirrorOpenCodeTodoToolToPlan(params, record, toolKind, status, title)) {
    return;
  }
  const list = openCodeTodoArrayFromToolRecord(record);
  if (!list?.length) {
    return;
  }
  const entries = agentPlanEntriesFromTodoLikeList(list, callbacks.conversation.id, "todo");
  if (entries.length === 0) {
    return;
  }
  await callbacks.appendEvents([
    {
      eventId: randomUUID(),
      conversationId: callbacks.conversation.id,
      kind: "plan",
      planId: `${callbacks.conversation.id}-todos`,
      entries,
      raw: params,
    },
  ]);
}

type AcpRuntimeSpec = CliRuntimeSpec;

const openCodeCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: true,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
};

const basicCliCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: false,
  supportsModeSelection: false,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: false,
  supportsToolCalls: false,
  supportsStructuredPlans: false,
  supportsTodos: false,
  supportsSessionResume: false,
  supportsPromptImages: false,
  supportsInlineReasoning: false,
};

const claudeCliCapabilities: AgentProviderCapabilities = {
  ...basicCliCapabilities,
  supportsToolCalls: true,
};

const codexCliCapabilities: AgentProviderCapabilities = {
  ...basicCliCapabilities,
  supportsToolCalls: true,
};

const cursorAcpCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: true,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
};

const LEGACY_MODE_CONFIG_ID = "__acp_legacy_mode__";
const LEGACY_MODEL_CONFIG_ID = "__acp_legacy_model__";

/**
 * Declares what the OpenCursor Node client can delegate when the agent asks.
 * Defaults are conservative. For headless / CI, Cursor may require overrides —
 * set `OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON` (partial JSON merged on top).
 */
function buildAcpClientCapabilities(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    promptCapabilities: { image: true },
  };
  const raw = process.env.OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON?.trim();
  if (!raw) {
    return base;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return base;
    }
    const p = parsed as Record<string, unknown>;
    const next: Record<string, unknown> = { ...base, ...p };
    if (p.fs && typeof p.fs === "object" && !Array.isArray(p.fs)) {
      next.fs = {
        ...(base.fs as Record<string, unknown>),
        ...(p.fs as Record<string, unknown>),
      };
    }
    return next;
  } catch {
    return base;
  }
}

/**
 * Gemini CLI ACP invocation: default `gemini --acp` (see Gemini CLI ACP docs).
 * Override with JSON array if your build uses different flags, e.g. `["--experimental-acp"]`.
 */
function parseGeminiCliAcpArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_GEMINI_CLI_ARGS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return ["--acp"];
}

/** Extra argv merged after the resolved Cursor `agent` binary (JSON string array). */
function parseCursorAgentExtraArgs(): string[] {
  const rawJson = process.env.OPENCURSOR_CURSOR_AGENT_ARGS?.trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  const permissionMode = process.env.OPENCURSOR_CURSOR_PERMISSION_MODE?.trim();
  if (permissionMode) {
    return ["--permission-mode", permissionMode];
  }
  return [];
}

function summarizeAuthenticateResult(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  for (const key of [
    "message",
    "instructions",
    "detail",
    "url",
    "loginUrl",
    "verificationUrl",
  ] as const) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      if (key === "url" || key === "loginUrl" || key === "verificationUrl") {
        return `Open or complete: ${t}`;
      }
      return t;
    }
  }
  return undefined;
}

async function runAcpTransportBootstrap(transport: AcpStdioClient): Promise<string[]> {
  const messages: string[] = [];
  const init = (await transport.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: buildAcpClientCapabilities(),
    clientInfo: {
      name: "opencursor-server",
      title: "OpenCursor Server",
      version: "0.1.0",
    },
  })) as Record<string, unknown> | undefined;

  const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
  const seen = new Set<string>();
  for (const entry of authMethods) {
    const id =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? parseConfigOptionString((entry as Record<string, unknown>).id)
        : typeof entry === "string"
          ? entry.trim()
          : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (id === "cursor_login") {
      try {
        const authResult = await transport.request("authenticate", { methodId: "cursor_login" });
        const note = summarizeAuthenticateResult(authResult);
        if (note) {
          messages.push(`Cursor CLI authentication: ${note}`);
        }
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        messages.push(
          `Cursor CLI authentication failed: ${errText}. Sign in on the server host with your Cursor CLI, set OPENCURSOR_CURSOR_CLI_BIN to that binary, and redeploy.`
        );
      }
    } else if (id === "opencode-login") {
      try {
        const authResult = await transport.request("authenticate", { methodId: "opencode-login" });
        const note = summarizeAuthenticateResult(authResult);
        if (note) {
          messages.push(`OpenCode ACP authentication: ${note}`);
        }
      } catch {
        // Auth failed (e.g. not logged in) — silent; the ACP transport itself will
        // surface any action the user needs to take through its normal protocol flow.
      }
    } else {
      messages.push(
        `ACP lists authentication method "${id}". If the agent stalls, complete any login this method requires on the server (TTY or documented OAuth); OpenCursor only bridges stdio.`
      );
    }
  }
  return messages;
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function backendUsesAcpPromptHints(backendId: AgentBackendId): boolean {
  return (
    backendId === "cursor-acp" ||
    backendId === "opencode-acp" ||
    backendId === "gemini-acp"
  );
}

type CursorPromptSearchHint = {
  query: string;
  presentation: "find" | "grep";
};

type CursorPromptToolHints = {
  explicitPaths: string[];
  searches: CursorPromptSearchHint[];
  nextPathIndex: number;
  nextSearchIndex: number;
};

type CursorToolInference = {
  toolKind?: string;
  path?: string;
  query?: string;
  searchPresentation?: "find" | "grep";
  locations?: { path: string; line?: number }[];
  detail?: string;
};

const CURSOR_INFERENCE_MAX_FILE_BYTES = 256 * 1024;
const CURSOR_INFERENCE_MAX_PATH_MATCH_BYTES = 512 * 1024;
const CURSOR_INFERENCE_MAX_LOCATIONS = 24;
const CURSOR_INFERENCE_MAX_CONTENT_SCAN_FILES = 4000;

function toWorkspaceRelativePath(workspaceRoot: string, filePath: string): string | undefined {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, "/");
}

function normalizePromptToken(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"(\[{<]+/, "")
    .replace(/[`'"),.;:!?\]}>]+$/, "")
    .trim();
}

function resolvePromptPathHint(workspaceRoot: string, rawToken: string): string | undefined {
  const token = normalizePromptToken(rawToken);
  if (!token) {
    return undefined;
  }
  const absolute = path.isAbsolute(token)
    ? path.resolve(token)
    : path.resolve(workspaceRoot, token);
  if (!fileExists(absolute)) {
    return undefined;
  }
  return toWorkspaceRelativePath(workspaceRoot, absolute);
}

export function extractCursorPromptPathHints(
  workspaceRoot: string,
  promptText: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | undefined) => {
    const normalized = candidate?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  for (const match of promptText.matchAll(/`([^`\n]+)`/g)) {
    push(resolvePromptPathHint(workspaceRoot, match[1] ?? ""));
  }

  for (const match of promptText.matchAll(
    /(?:^|[\s([{"'])((?:\.{0,2}\/)?(?:[\w@%+~:-]+\/)*[\w@%+~:-]+\.[A-Za-z0-9]{1,12})(?=$|[\s)\]},'":;!?])/g
  )) {
    push(resolvePromptPathHint(workspaceRoot, match[1] ?? ""));
  }

  return out;
}

export function extractCursorPromptSearchHints(promptText: string): CursorPromptSearchHint[] {
  const out: CursorPromptSearchHint[] = [];
  const seen = new Set<string>();
  const push = (rawQuery: string | undefined, presentation: "find" | "grep") => {
    const query = normalizePromptToken(rawQuery ?? "").replace(/^references?\s+to\s+/i, "");
    if (!query || seen.has(`${presentation}\0${query}`)) {
      return;
    }
    seen.add(`${presentation}\0${query}`);
    out.push({ query, presentation });
  };

  const patterns: Array<{ regex: RegExp; presentation: "find" | "grep" }> = [
    {
      regex:
        /\bfind(?:\s+all)?\s+references?\s+to\s+`([^`\n]+)`/gi,
      presentation: "find",
    },
    {
      regex:
        /\bfind(?:\s+all)?\s+references?\s+to\s+"([^"\n]+)"/gi,
      presentation: "find",
    },
    {
      regex:
        /\bfind(?:\s+all)?\s+references?\s+to\s+'([^'\n]+)'/gi,
      presentation: "find",
    },
    {
      regex:
        /\bfind(?:\s+all)?\s+references?\s+to\s+([A-Za-z_$][\w.$:-]*)/gi,
      presentation: "find",
    },
    {
      regex: /\b(?:grep|search(?:\s+for)?|find(?:\s+in\s+workspace)?(?:\s+for)?)\s+`([^`\n]+)`/gi,
      presentation: "grep",
    },
    {
      regex: /\b(?:grep|search(?:\s+for)?|find(?:\s+in\s+workspace)?(?:\s+for)?)\s+"([^"\n]+)"/gi,
      presentation: "grep",
    },
    {
      regex: /\b(?:grep|search(?:\s+for)?|find(?:\s+in\s+workspace)?(?:\s+for)?)\s+'([^'\n]+)'/gi,
      presentation: "grep",
    },
  ];

  for (const { regex, presentation } of patterns) {
    for (const match of promptText.matchAll(regex)) {
      push(match[1], presentation);
    }
  }

  return out;
}

function buildCursorPromptToolHints(
  workspaceRoot: string,
  promptText: string
): CursorPromptToolHints | null {
  const explicitPaths = extractCursorPromptPathHints(workspaceRoot, promptText);
  const searches = extractCursorPromptSearchHints(promptText);
  if (explicitPaths.length === 0 && searches.length === 0) {
    return null;
  }
  return {
    explicitPaths,
    searches,
    nextPathIndex: 0,
    nextSearchIndex: 0,
  };
}

function normalizeTextForCursorInference(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

async function readUtf8FileIfReasonable(absolutePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > CURSOR_INFERENCE_MAX_FILE_BYTES) {
      return undefined;
    }
    if (inferFileKind(absolutePath) !== "text") {
      return undefined;
    }
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

async function findWorkspaceFilesByExactContent(
  workspaceRoot: string,
  content: string,
  preferredPaths: readonly string[]
): Promise<string[]> {
  const normalizedNeedle = normalizeTextForCursorInference(content);
  const tryCollect = async (mode: "exact" | "includes"): Promise<string[]> => {
    const hits: string[] = [];
    const seen = new Set<string>();

    const tryPush = async (relativePath: string | undefined) => {
      const normalized = relativePath?.trim();
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      const absolute = path.join(workspaceRoot, normalized);
      const text = await readUtf8FileIfReasonable(absolute);
      if (text == null) {
        return false;
      }
      const normalizedHaystack = normalizeTextForCursorInference(text);
      const matched =
        mode === "exact"
          ? normalizedHaystack === normalizedNeedle
          : normalizedNeedle.length >= 64 && normalizedHaystack.includes(normalizedNeedle);
      if (!matched) {
        return false;
      }
      hits.push(normalized);
      return hits.length >= 2;
    };

    for (const candidate of preferredPaths) {
      if (await tryPush(candidate)) {
        return hits;
      }
    }

    if (Buffer.byteLength(content, "utf8") > CURSOR_INFERENCE_MAX_PATH_MATCH_BYTES) {
      return hits;
    }

    let visited = 0;
    async function walk(currentDir: string): Promise<boolean> {
      if (visited >= CURSOR_INFERENCE_MAX_CONTENT_SCAN_FILES) {
        return true;
      }
      let dirents;
      try {
        dirents = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const dirent of dirents) {
        const absolute = path.join(currentDir, dirent.name);
        if (dirent.isDirectory()) {
          if (isDimmed(dirent.name)) {
            continue;
          }
          if (await walk(absolute)) {
            return true;
          }
          continue;
        }
        if (!dirent.isFile()) {
          continue;
        }
        visited += 1;
        const relative = toWorkspaceRelativePath(workspaceRoot, absolute);
        if (!relative) {
          continue;
        }
        if (await tryPush(relative)) {
          return true;
        }
        if (visited >= CURSOR_INFERENCE_MAX_CONTENT_SCAN_FILES) {
          return true;
        }
      }
      return false;
    }

    await walk(workspaceRoot);
    return hits;
  };

  const exact = await tryCollect("exact");
  if (exact.length > 0) {
    return exact;
  }
  return tryCollect("includes");
}

export async function inferCursorReadPathFromContent(
  workspaceRoot: string,
  content: string,
  preferredPaths: readonly string[]
): Promise<string | undefined> {
  const matches = await findWorkspaceFilesByExactContent(workspaceRoot, content, preferredPaths);
  return matches.length === 1 ? matches[0] : matches[0];
}

export async function inferCursorSearchLocations(
  workspaceRoot: string,
  query: string,
  maxLocations = CURSOR_INFERENCE_MAX_LOCATIONS
): Promise<Array<{ path: string; line?: number }>> {
  const needle = query.trim();
  if (!needle) {
    return [];
  }
  const out: Array<{ path: string; line?: number }> = [];
  let stopped = false;

  async function walk(currentDir: string): Promise<void> {
    if (stopped) {
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (stopped) {
        return;
      }
      const absolute = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        if (isDimmed(dirent.name)) {
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      const relative = toWorkspaceRelativePath(workspaceRoot, absolute);
      if (!relative) {
        continue;
      }
      const text = await readUtf8FileIfReasonable(absolute);
      if (!text) {
        continue;
      }
      const lines = normalizeTextForCursorInference(text).split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]?.includes(needle)) {
          continue;
        }
        out.push({ path: relative, line: index + 1 });
        if (out.length >= maxLocations) {
          stopped = true;
          return;
        }
      }
    }
  }

  await walk(workspaceRoot);
  return out;
}

function countUniqueLocationPaths(locations: readonly { path: string; line?: number }[]): number {
  return new Set(locations.map((entry) => entry.path)).size;
}

function isGenericCursorSearchTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "grep" ||
    normalized === "find" ||
    normalized === "search" ||
    isGenericAcpToolTitle(value)
  );
}

function quotePreview(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  return /[\s"]/u.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

function buildInvocation(
  executablePath: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): AcpRuntimeSpec {
  const ext = path.extname(executablePath).toLowerCase();
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const comspec =
      process.env.ComSpec ??
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const commandLine = [quoteCmdArg(executablePath), ...args.map(quoteCmdArg)].join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      env,
      commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
    };
  }

  if (process.platform === "win32" && ext === ".ps1") {
    const powershell =
      process.env.PWSH ??
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
    return {
      command: powershell,
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executablePath, ...args],
      env,
      commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
    };
  }

  return {
    command: executablePath,
    args,
    env,
    commandPreview: [quotePreview(executablePath), ...args.map(quotePreview)].join(" "),
  };
}

function findExecutableOnPath(names: string[]): string | null {
  const rawPath = process.env.PATH ?? "";
  const directories = rawPath
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveConfiguredRuntime(
  configured: string | undefined,
  args: string[],
  env?: NodeJS.ProcessEnv
): AcpRuntimeSpec | null {
  const trimmed = configured?.trim();
  if (!trimmed) {
    return null;
  }
  const direct =
    trimmed.includes("\\") ||
    trimmed.includes("/") ||
    /^[a-zA-Z]:/.test(trimmed)
      ? trimmed
      : findExecutableOnPath(
          process.platform === "win32"
            ? [trimmed, `${trimmed}.exe`, `${trimmed}.cmd`, `${trimmed}.bat`, `${trimmed}.ps1`]
            : [trimmed]
        );
  if (!direct) {
    return null;
  }
  return buildInvocation(direct, args, env);
}

function resolveCursorCliRuntime(): CliRuntimeSpec | null {
  const envOverrides = {
    ...process.env,
    CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS || "agent.cmd",
  };
  const extraArgs = [...parseCursorAgentExtraArgs(), "acp"];
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_CURSOR_CLI_BIN ?? process.env.OPENCURSOR_CURSOR_ACP_BIN,
    extraArgs,
    envOverrides
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["agent.exe", "agent.cmd", "cursor-agent.cmd", "agent"]
      : ["agent"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, extraArgs, envOverrides);
  }

  return null;
}

function openCodeHomeDirCandidates(): string[] {
  const raw = process.env.OPENCURSOR_REAL_HOME?.trim();
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const t = value?.trim();
    if (t && !out.includes(t)) {
      out.push(t);
    }
  };
  push(raw || undefined);
  if (process.env.USER?.trim()) {
    push(`/home/${process.env.USER!.trim()}`);
  }
  push(os.homedir());
  return out;
}

function resolveOpenCodeBundledBinary(): string | null {
  const names =
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
      : ["opencode"];
  for (const home of openCodeHomeDirCandidates()) {
    for (const name of names) {
      const candidate = path.join(home, ".opencode", "bin", name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveGeminiAcpRuntime(): AcpRuntimeSpec | null {
  const acpArgs = parseGeminiCliAcpArgs();
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_GEMINI_CLI_BIN, acpArgs);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["gemini.exe", "gemini.cmd", "gemini.bat", "gemini"]
      : ["gemini"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, acpArgs);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "gemini.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, acpArgs);
    }
  }

  return null;
}

function resolveOpenCodeAcpRuntime(): AcpRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(
    process.env.OPENCURSOR_OPENCODE_ACP_BIN,
    ["acp"]
  );
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
      : ["opencode"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, ["acp"]);
  }

  const bundled = resolveOpenCodeBundledBinary();
  if (bundled) {
    return buildInvocation(bundled, ["acp"]);
  }

  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "opencode.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, ["acp"]);
    }
  }

  return null;
}

/** Same discovery as {@link resolveOpenCodeAcpRuntime}, but with a fixed embedded HTTP `--port` for SSE bridging. */
function resolveOpenCodeAcpInvocationWithPort(port: number): AcpRuntimeSpec | null {
  const args = buildOpenCodeAcpCliArgs(port);
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_OPENCODE_ACP_BIN, args);
  if (configured) {
    return configured;
  }
  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
      : ["opencode"]
  );
  if (pathHit) {
    return buildInvocation(pathHit, args);
  }
  const bundled = resolveOpenCodeBundledBinary();
  if (bundled) {
    return buildInvocation(bundled, args);
  }
  if (process.platform === "win32") {
    const roamingNpm = process.env.APPDATA?.trim()
      ? path.join(process.env.APPDATA, "npm", "opencode.cmd")
      : null;
    if (roamingNpm && fileExists(roamingNpm)) {
      return buildInvocation(roamingNpm, args);
    }
  }
  return null;
}

function resolveCodexCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_CODEX_BIN, []);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex"]
      : ["codex"]
  );
  return pathHit ? buildInvocation(pathHit, []) : null;
}

function resolveClaudeCliRuntime(): CliRuntimeSpec | null {
  const configured = resolveConfiguredRuntime(process.env.OPENCURSOR_CLAUDE_BIN, []);
  if (configured) {
    return configured;
  }

  const pathHit = findExecutableOnPath(
    process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
      : ["claude"]
  );
  return pathHit ? buildInvocation(pathHit, []) : null;
}

const CURSOR_RUNTIME = resolveCursorCliRuntime();
const OPENCODE_RUNTIME = resolveOpenCodeAcpRuntime();
const GEMINI_RUNTIME = resolveGeminiAcpRuntime();
const CODEX_RUNTIME = resolveCodexCliRuntime();
const CLAUDE_RUNTIME = resolveClaudeCliRuntime();

export type CursorAgentDeploymentHints = {
  resolved: boolean;
  commandPreview: string | null;
  extraArgs: string[];
  permissionModeEnv: string | null;
  acpCapabilitiesJsonSet: boolean;
  cursorBinEnvSet: boolean;
};

export function getCursorAgentDeploymentHints(): CursorAgentDeploymentHints {
  return {
    resolved: CURSOR_RUNTIME !== null,
    commandPreview: CURSOR_RUNTIME?.commandPreview ?? null,
    extraArgs: parseCursorAgentExtraArgs(),
    permissionModeEnv: process.env.OPENCURSOR_CURSOR_PERMISSION_MODE?.trim() || null,
    acpCapabilitiesJsonSet: Boolean(process.env.OPENCURSOR_ACP_CLIENT_CAPABILITIES_JSON?.trim()),
    cursorBinEnvSet: Boolean(
      (process.env.OPENCURSOR_CURSOR_CLI_BIN ?? process.env.OPENCURSOR_CURSOR_ACP_BIN)?.trim()
    ),
  };
}

function createBackendInfo(input: {
  id: AgentBackendId;
  label: string;
  description: string;
  commandPreview?: string;
  experimental?: boolean;
  available?: boolean;
  capabilities: AgentProviderCapabilities;
  defaultMode?: AgentConversationMode;
  defaultModelId?: string;
  defaultModelName?: string;
}): AgentBackendInfo {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    commandPreview: input.commandPreview,
    experimental: input.experimental ?? false,
    available: input.available ?? true,
    capabilities: input.capabilities,
    defaultMode: input.defaultMode ?? "agent",
    defaultModelId: input.defaultModelId ?? "auto",
    defaultModelName: input.defaultModelName ?? "Auto",
  };
}

export const AGENT_BACKENDS: Record<AgentBackendId, AgentBackendInfo> = {
  "cursor-acp": createBackendInfo({
    id: "cursor-acp",
    label: "Cursor",
    description: "Cursor CLI over ACP stdio with full model variants.",
    commandPreview: CURSOR_RUNTIME?.commandPreview ?? "Cursor CLI not found",
    available: CURSOR_RUNTIME !== null,
    capabilities: cursorAcpCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "opencode-acp": createBackendInfo({
    id: "opencode-acp",
    label: "Opencode",
    description: "OpenCode CLI over ACP stdio.",
    commandPreview: OPENCODE_RUNTIME?.commandPreview ?? "OpenCode CLI not found",
    available: OPENCODE_RUNTIME !== null,
    capabilities: openCodeCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "gemini-acp": createBackendInfo({
    id: "gemini-acp",
    label: "Gemini",
    description: "Gemini CLI over ACP stdio (`gemini --acp`).",
    commandPreview: GEMINI_RUNTIME?.commandPreview ?? "Gemini CLI not found",
    available: GEMINI_RUNTIME !== null,
    capabilities: openCodeCapabilities,
    defaultMode: "agent",
    defaultModelId: "auto",
    defaultModelName: "Auto",
  }),
  "codex-adapter": createBackendInfo({
    id: "codex-adapter",
    label: "Codex",
    description: "Official Codex CLI via non-interactive adapter.",
    experimental: false,
    commandPreview: CODEX_RUNTIME?.commandPreview ?? "Codex CLI not found",
    available: CODEX_RUNTIME !== null,
    capabilities: codexCliCapabilities,
    defaultMode: "agent",
    defaultModelId: "gpt-5.4-mini",
    defaultModelName: "GPT-5.4-Mini",
  }),
  "claude-adapter": createBackendInfo({
    id: "claude-adapter",
    label: "Claude Code",
    description: "Official Claude Code CLI routed through the local model proxy.",
    experimental: false,
    commandPreview: CLAUDE_RUNTIME?.commandPreview ?? "Claude Code CLI not found",
    available: CLAUDE_RUNTIME !== null,
    capabilities: claudeCliCapabilities,
    defaultMode: "agent",
    defaultModelId: "glm-5.1",
    defaultModelName: "GLM 5.1",
  }),
};

export function listAgentBackends(): AgentBackendInfo[] {
  return Object.values(AGENT_BACKENDS);
}

export async function listAgentBackendsWithCache(): Promise<AgentBackendInfo[]> {
  return Promise.all(
    Object.values(AGENT_BACKENDS).map(async (backend) => ({
      ...backend,
      cachedConfigOptions: await readAgentBackendConfigCache(backend.id),
    }))
  );
}

function parseConfigOptionCategory(value: unknown): AgentConfigOptionCategory {
  if (
    value === "mode" ||
    value === "model" ||
    value === "thought_level" ||
    value === "permission" ||
    value === "other"
  ) {
    return value;
  }
  return "other";
}

function parseConfigOptionString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function inferConfigOptionCategory(
  record: Record<string, unknown>,
  id: string,
  name: string
): AgentConfigOptionCategory {
  const direct = parseConfigOptionCategory(record.category);
  if (direct !== "other") {
    return direct;
  }
  const lowerId = id.toLowerCase();
  const lowerName = name.toLowerCase();
  if (
    lowerId.includes("thought") ||
    lowerName.includes("thought") ||
    lowerId.includes("reasoning") ||
    lowerName.includes("reasoning") ||
    lowerId.includes("effort") ||
    lowerName.includes("effort") ||
    lowerId.includes("thinking") ||
    lowerName.includes("thinking") ||
    lowerId.includes("speed") ||
    lowerName.includes("speed") ||
    lowerId.includes("tier") ||
    lowerName.includes("tier")
  ) {
    return "thought_level";
  }
  if (
    lowerId === "mode" ||
    lowerId.endsWith("mode") ||
    lowerName.includes("mode") ||
    lowerName.includes("agent")
  ) {
    return "mode";
  }
  if (
    lowerId === "model" ||
    lowerId.endsWith("model") ||
    lowerName.includes("model")
  ) {
    return "model";
  }
  if (lowerId.includes("permission") || lowerName.includes("permission")) {
    return "permission";
  }
  return "other";
}

function resolveConfigOptionCurrentValue(
  record: Record<string, unknown>,
  options: AgentConfigOption["options"]
): string {
  const directKeys = ["currentValue", "selectedValue", "value", "defaultValue"];
  for (const key of directKeys) {
    const candidate = parseConfigOptionString(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  const rawOptions = Array.isArray(record.options)
    ? record.options
    : Array.isArray(record.values)
      ? record.values
      : Array.isArray(record.items)
        ? record.items
        : [];
  for (const rawOption of rawOptions) {
    if (!rawOption || typeof rawOption !== "object") {
      continue;
    }
    const optionRecord = rawOption as Record<string, unknown>;
    if (
      optionRecord.selected === true ||
      optionRecord.current === true ||
      optionRecord.active === true ||
      optionRecord.default === true
    ) {
      const selectedValue =
        parseConfigOptionString(optionRecord.value) ||
        parseConfigOptionString(optionRecord.id) ||
        parseConfigOptionString(optionRecord.key);
      if (selectedValue) {
        return selectedValue;
      }
    }
  }

  return options[0]?.value ?? "";
}

function normalizeProviderMode(
  rawValue: string | undefined,
  fallback: AgentConversationMode
): AgentConversationMode {
  const normalized = rawValue?.trim();
  return normalized ? (normalized as AgentConversationMode) : fallback;
}

function isCursorCliModelId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("[");
}

function parseCursorBracketModelValue(value: string): {
  params: Record<string, string>;
} {
  const match = /^.+?\[(.*)\]$/.exec(value.trim());
  if (!match) {
    return { params: {} };
  }
  const params = Object.fromEntries(
    match[1]
      .split(",")
      .map((entry) => {
        const [rawKey, rawValue] = entry.split("=");
        return [rawKey?.trim() ?? "", rawValue?.trim() ?? ""];
      })
      .filter(([key]) => key.length > 0)
  );
  return { params };
}

function parseCursorSeedVariant(value: string): {
  effort?: string;
  fast: boolean;
  thinking: boolean;
} {
  let rest = value.trim().toLowerCase();
  let fast = false;
  let thinking = false;
  let effort: string | undefined;

  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }

  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -9);
  }

  for (const candidate of ["none", "low", "medium", "high", "xhigh"] as const) {
    if (rest.endsWith(`-${candidate}`)) {
      effort = candidate;
      break;
    }
  }

  if (!effort && rest.startsWith("claude-") && rest.endsWith("-max")) {
    effort = "max";
  }

  return { effort, fast, thinking };
}

function parseCursorLiveVariant(value: string): {
  effort?: string;
  fast: boolean;
  thinking: boolean;
} {
  const params = parseCursorBracketModelValue(value).params;
  const rawEffort = params.reasoning || params.effort || "";
  return {
    effort: rawEffort ? rawEffort.toLowerCase() : undefined,
    fast: params.fast === "true",
    thinking: params.thinking === "true",
  };
}

function tokenizeCursorModelLabel(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function resolveCursorSeedModelValue(input: {
  seedModelOption: AgentConfigOption;
  liveModelOption?: AgentConfigOption;
  selectedModelId?: string;
  selectedModelName?: string;
}): string {
  const { seedModelOption, liveModelOption, selectedModelId, selectedModelName } = input;
  const directModelId = selectedModelId?.trim() ?? "";
  if (directModelId && seedModelOption.options.some((option) => option.value === directModelId)) {
    return directModelId;
  }

  const directName = selectedModelName?.trim() ?? "";
  if (directName) {
    const exactName = seedModelOption.options.find((option) => option.name === directName);
    if (exactName) {
      return exactName.value;
    }
  }

  const liveCurrentValue = liveModelOption?.currentValue?.trim() ?? "";
  const liveCurrentOption =
    liveModelOption?.options.find((option) => option.value === liveCurrentValue) ?? null;
  const liveName = directName || liveCurrentOption?.name?.trim() || "";
  const liveVariant = parseCursorLiveVariant(directModelId || liveCurrentValue);
  const liveTokens = new Set(tokenizeCursorModelLabel(liveName));

  let bestMatch: { value: string; score: number } | null = null;
  for (const option of seedModelOption.options) {
    const seedTokens = new Set(tokenizeCursorModelLabel(option.name));
    let matchedTokenCount = 0;
    for (const token of liveTokens) {
      if (seedTokens.has(token)) {
        matchedTokenCount += 1;
      }
    }
    if (liveTokens.size > 0 && matchedTokenCount === 0) {
      continue;
    }

    const seedVariant = parseCursorSeedVariant(option.value);
    let score = matchedTokenCount * 10;
    if (liveTokens.size > 0 && matchedTokenCount === liveTokens.size) {
      score += 20;
    }
    if ((seedVariant.effort ?? "") === (liveVariant.effort ?? "")) {
      score += 12;
    } else if (liveVariant.effort) {
      score -= 12;
    }
    if (seedVariant.fast === liveVariant.fast) {
      score += 6;
    } else if (liveVariant.fast || seedVariant.fast) {
      score -= 6;
    }
    if (seedVariant.thinking === liveVariant.thinking) {
      score += 6;
    } else if (liveVariant.thinking || seedVariant.thinking) {
      score -= 6;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { value: option.value, score };
    }
  }

  if (bestMatch) {
    return bestMatch.value;
  }

  return seedModelOption.currentValue;
}

function mergeCursorSeedConfigOptions(
  seedConfigOptions: AgentConfigOption[] | undefined,
  liveConfigOptions: AgentConfigOption[],
  selectedConfig: AgentConversationRecord["config"]
): AgentConfigOption[] {
  if (!seedConfigOptions || seedConfigOptions.length === 0) {
    return liveConfigOptions;
  }

  const seedById = new Map(seedConfigOptions.map((option) => [option.id, option]));
  const liveById = new Map(liveConfigOptions.map((option) => [option.id, option]));
  const merged: AgentConfigOption[] = [];

  for (const seedOption of seedConfigOptions) {
    const liveOption = liveById.get(seedOption.id);
    if (seedOption.category === "model") {
      merged.push({
        ...seedOption,
        currentValue: resolveCursorSeedModelValue({
          seedModelOption: seedOption,
          liveModelOption: liveOption,
          selectedModelId: selectedConfig.modelId,
          selectedModelName: selectedConfig.modelName,
        }),
      });
      continue;
    }
    merged.push(liveOption ? { ...seedOption, currentValue: liveOption.currentValue } : seedOption);
  }

  for (const liveOption of liveConfigOptions) {
    if (!seedById.has(liveOption.id)) {
      merged.push(liveOption);
    }
  }

  return merged;
}

function parseConfigOptions(raw: unknown): AgentConfigOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parsed: AgentConfigOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = parseConfigOptionString(record.id);
    const name =
      parseConfigOptionString(record.name) ||
      parseConfigOptionString(record.label) ||
      id;
    if (!id) {
      continue;
    }
    const options: AgentConfigOption["options"] = [];
    const rawOptions = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : Array.isArray(record.items)
          ? record.items
          : [];
    if (rawOptions.length > 0) {
      for (const option of rawOptions) {
        if (!option || typeof option !== "object") {
          continue;
        }
        const optionRecord = option as Record<string, unknown>;
        const value =
          parseConfigOptionString(optionRecord.value) ||
          parseConfigOptionString(optionRecord.id) ||
          parseConfigOptionString(optionRecord.key);
        const optionName =
          parseConfigOptionString(optionRecord.name) ||
          parseConfigOptionString(optionRecord.label) ||
          value;
        if (!value || !optionName) {
          continue;
        }
        options.push({
          value,
          name: optionName,
          description:
            typeof optionRecord.description === "string"
              ? optionRecord.description
              : undefined,
        });
      }
    }
    const currentValue = resolveConfigOptionCurrentValue(record, options);
    parsed.push({
      id,
      name,
      description:
        typeof record.description === "string" ? record.description : undefined,
      category: inferConfigOptionCategory(record, id, name),
      currentValue,
      options,
    });
  }
  return parsed;
}

function parseLegacySessionConfigOptions(
  session: Record<string, unknown>
): AgentConfigOption[] {
  const parsed: AgentConfigOption[] = [];

  const rawModes =
    session.modes && typeof session.modes === "object"
      ? (session.modes as Record<string, unknown>)
      : null;
  if (rawModes && Array.isArray(rawModes.availableModes)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModes.availableModes) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.modeId);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODE_CONFIG_ID,
        name: "Mode",
        category: "mode",
        currentValue:
          parseConfigOptionString(rawModes.currentModeId) || options[0]?.value || "",
        options,
      });
    }
  }

  const rawModels =
    session.models && typeof session.models === "object"
      ? (session.models as Record<string, unknown>)
      : null;
  if (rawModels && Array.isArray(rawModels.availableModels)) {
    const options: AgentConfigOption["options"] = [];
    for (const entry of rawModels.availableModels) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const value =
        parseConfigOptionString(record.modelId) ||
        parseConfigOptionString(record.id) ||
        parseConfigOptionString(record.value);
      const name =
        parseConfigOptionString(record.name) ||
        parseConfigOptionString(record.label) ||
        value;
      if (!value || !name) {
        continue;
      }
      options.push({
        value,
        name,
        description:
          typeof record.description === "string" ? record.description : undefined,
      });
    }
    if (options.length > 0) {
      parsed.push({
        id: LEGACY_MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        currentValue:
          parseConfigOptionString(rawModels.currentModelId) || options[0]?.value || "",
        options,
      });
    }
  }

  return parsed;
}

function mergeSessionConfigOptions(
  configOptions: AgentConfigOption[],
  legacyOptions: AgentConfigOption[]
): AgentConfigOption[] {
  const merged = [...configOptions];
  for (const option of legacyOptions) {
    if (
      merged.some((existing) => existing.id === option.id) ||
      merged.some((existing) => configOptionMatchesCategory(existing, option.category))
    ) {
      continue;
    }
    merged.push(option);
  }
  return merged;
}

function normalizeConversationModeForProvider(
  requested: AgentConversationMode,
  option: AgentConfigOption | undefined
): string | null {
  if (!option) {
    return null;
  }
  const req = typeof requested === "string" ? requested.trim() : "";
  if (option.options.some((value) => value.value === requested)) {
    return requested;
  }
  const requestedLower = req.toLowerCase();
  const caseMatch = option.options.find((v) => v.value.toLowerCase() === requestedLower);
  if (caseMatch) {
    return caseMatch.value;
  }
  const rawCandidates =
    requestedLower === "agent" || requestedLower === "code"
      ? ["agent", "code", "build"]
      : requestedLower === "plan"
        ? ["plan", "architect"]
        : requestedLower === "ask"
          ? ["ask", "review", "readonly", "read-only"]
          : requestedLower === "debug"
            ? ["debug", "build", "agent", "code"]
            : [req];
  const available = new Set(option.options.map((value) => value.value));
  for (const candidate of rawCandidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of rawCandidates) {
    const found = option.options.find((v) => v.value.toLowerCase() === candidate.toLowerCase());
    if (found) {
      return found.value;
    }
  }
  return null;
}

function summarizeToolContent(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const first = raw[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const record = first as Record<string, unknown>;
  if (typeof record.path === "string" && typeof record.newText === "string") {
    return `Updated ${record.path}`;
  }
  const summarizeInlineText = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.includes("\n") || trimmed.length > 240) {
      return undefined;
    }
    return trimmed;
  };
  if (record.content && typeof record.content === "object") {
    const content = record.content as Record<string, unknown>;
    const inlineText = summarizeInlineText(content.text);
    if (inlineText) {
      return inlineText;
    }
  }
  const inlineText = summarizeInlineText(record.text);
  if (inlineText) {
    return inlineText;
  }
  return undefined;
}

function humanizeAcpToolCallName(value: string): string {
  return value
    .replace(/ToolCall$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim();
}

function isGenericAcpToolTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "tool call" ||
    normalized === "tool" ||
    normalized === "function call" ||
    normalized === "function" ||
    normalized === "ran" ||
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "find" ||
    normalized === "search" ||
    /** OpenCode / ACP often send these; we replace via summarize + payload. */
    normalized === "read file" ||
    normalized === "find in workspace" ||
    normalized === "grep workspace" ||
    normalized === "web search"
  );
}

type AcpToolCallEntry = {
  rawName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

function parseLooseJsonObjectForAcp(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pushParsedAcpToolEntry(
  entries: AcpToolCallEntry[],
  rawName: string | undefined,
  argsRaw: unknown,
  resultRaw: unknown
): void {
  if (!rawName?.trim()) {
    return;
  }
  const args =
    parseLooseJsonObjectForAcp(argsRaw) ??
    (argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : undefined);
  const result =
    parseLooseJsonObjectForAcp(resultRaw) ??
    (resultRaw && typeof resultRaw === "object" && !Array.isArray(resultRaw)
      ? (resultRaw as Record<string, unknown>)
      : undefined);
  entries.push({ rawName: rawName.trim(), args, result });
}

function extractClassicAcpToolCallMap(record: Record<string, unknown>): AcpToolCallEntry[] {
  const toolCall =
    record.tool_call && typeof record.tool_call === "object" && !Array.isArray(record.tool_call)
      ? (record.tool_call as Record<string, unknown>)
      : record.toolCall && typeof record.toolCall === "object" && !Array.isArray(record.toolCall)
        ? (record.toolCall as Record<string, unknown>)
        : undefined;
  if (!toolCall) {
    return [];
  }
  const entries: AcpToolCallEntry[] = [];
  for (const [rawName, value] of Object.entries(toolCall)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    pushParsedAcpToolEntry(entries, rawName, entry.args ?? entry.input, entry.result);
  }
  return entries;
}

function extractAlternateAcpToolCallEntries(
  record: Record<string, unknown>,
  depth = 0
): AcpToolCallEntry[] {
  if (depth > 4) {
    return [];
  }
  const entries: AcpToolCallEntry[] = [];
  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const item of toolCalls) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const it = item as Record<string, unknown>;
      const fn =
        it.function && typeof it.function === "object" && !Array.isArray(it.function)
          ? (it.function as Record<string, unknown>)
          : undefined;
      const name =
        (typeof it.name === "string" ? it.name.trim() : "") ||
        (typeof fn?.name === "string" ? fn.name.trim() : "") ||
        undefined;
      const argsSrc = fn?.arguments ?? fn?.input ?? it.arguments ?? it.args ?? it.input;
      const res = it.result ?? it.output ?? it.response;
      pushParsedAcpToolEntry(entries, name, argsSrc, res);
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      const t = b.type;
      if (t === "tool_use" || t === "tool-call" || t === "tool_call") {
        const nm = typeof b.name === "string" ? b.name : undefined;
        pushParsedAcpToolEntry(entries, nm, b.input ?? b.arguments ?? b.args, b.result ?? b.output);
      }
    }
  }

  if (entries.length === 0 && typeof record.name === "string" && record.name.trim()) {
    pushParsedAcpToolEntry(
      entries,
      record.name,
      record.input ?? record.arguments ?? record.args ?? record.parameters,
      record.result ?? record.output ?? record.response
    );
  }

  if (entries.length > 0) {
    return entries;
  }

  for (const key of ["message", "payload", "delta", "item", "data", "body"] as const) {
    const v = record[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = extractAlternateAcpToolCallEntries(v as Record<string, unknown>, depth + 1);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function toolNameHintFromAcpRecord(record: Record<string, unknown>): string | undefined {
  for (const key of ["toolName", "tool_name", "toolId", "tool_id", "mcpTool", "mcp_tool"] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function inferToolNameFromFlatArgs(
  record: Record<string, unknown>,
  args: Record<string, unknown>
): string {
  const hint = toolNameHintFromAcpRecord(record);
  if (hint) {
    return hint;
  }
  const titleNorm = typeof record.title === "string" ? normalizeOpenCodeToolKey(record.title) : "";
  if (titleNorm === "todowrite" || titleNorm === "todoread") {
    return titleNorm;
  }
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  if (kind && kind !== "tool" && kind !== "other") {
    if (kind === "read" || kind === "file_read") {
      return "read_file";
    }
    if (kind === "edit" || kind === "write" || kind === "patch") {
      return "write_file";
    }
    if (kind === "delete" || kind === "unlink") {
      return "delete_file";
    }
    if (kind === "grep" || kind === "ripgrep") {
      return "grep";
    }
    if (kind === "glob" || kind === "find" || kind === "file_search") {
      return "glob_file_search";
    }
    if (kind === "terminal" || kind === "shell" || kind === "run") {
      return "run_terminal_cmd";
    }
    if (kind.includes("web")) {
      return "web_search";
    }
  }
  const hasCmd =
    typeof args.command === "string" ||
    typeof args.cmd === "string" ||
    typeof args.shell === "string";
  if (hasCmd) {
    return "run_terminal_cmd";
  }
  const hasPath =
    typeof args.path === "string" ||
    typeof args.filePath === "string" ||
    typeof args.file_path === "string" ||
    typeof args.target_file === "string" ||
    typeof args.file === "string" ||
    typeof args.uri === "string";
  const hasPattern =
    typeof args.pattern === "string" ||
    typeof args.query === "string" ||
    typeof args.regex === "string";
  if (hasPattern && !hasPath) {
    return typeof args.globPattern === "string" || typeof args.glob === "string"
      ? "glob_file_search"
      : "grep";
  }
  if (hasPath && typeof args.new_string === "string") {
    return "write_file";
  }
  if (hasPath) {
    return "read_file";
  }
  return "tool";
}

/** Cursor / ACP sometimes send `rawInput` as the argument object with no `tool_call` wrapper. */
function tryExtractToolEntryFromFlatRawInput(record: Record<string, unknown>): AcpToolCallEntry[] {
  const ri =
    parseLooseJsonObjectForAcp(record.rawInput) ??
    parseLooseJsonObjectForAcp(record.raw_input);
  if (!ri) {
    return [];
  }
  const args = ri as Record<string, unknown>;
  const meaningful =
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.filePath === "string" && args.filePath.trim()) ||
    (typeof args.file_path === "string" && args.file_path.trim()) ||
    (typeof args.target_file === "string" && args.target_file.trim()) ||
    (typeof args.file === "string" && args.file.trim()) ||
    (typeof args.uri === "string" && args.uri.trim()) ||
    (typeof args.command === "string" && args.command.trim()) ||
    (typeof args.cmd === "string" && args.cmd.trim()) ||
    (typeof args.pattern === "string" && args.pattern.trim()) ||
    (typeof args.query === "string" && args.query.trim()) ||
    (typeof args.globPattern === "string" && args.globPattern.trim()) ||
    (typeof args.glob === "string" && args.glob.trim()) ||
    (Array.isArray(args.todos) && args.todos.length > 0) ||
    (Array.isArray(args.items) && args.items.length > 0);
  if (!meaningful) {
    return [];
  }
  const rawName = inferToolNameFromFlatArgs(record, args);
  const result =
    parseLooseJsonObjectForAcp(record.rawOutput) ??
    parseLooseJsonObjectForAcp(record.raw_output);
  return result ? [{ rawName, args, result }] : [{ rawName, args }];
}

function extractAcpToolCallEntries(record: Record<string, unknown>): AcpToolCallEntry[] {
  const classic = extractClassicAcpToolCallMap(record);
  if (classic.length > 0) {
    return classic;
  }
  const alternate = extractAlternateAcpToolCallEntries(record);
  if (alternate.length > 0) {
    return alternate;
  }
  const flatRaw = tryExtractToolEntryFromFlatRawInput(record);
  if (flatRaw.length > 0) {
    return flatRaw;
  }
  const nested =
    parseLooseJsonObjectForAcp(record.rawInput) ??
    parseLooseJsonObjectForAcp(record.raw_input);
  if (nested && nested !== record) {
    return extractAcpToolCallEntries(nested);
  }
  return [];
}

function extractAcpToolCallPayload(record: Record<string, unknown>): {
  rawName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} {
  const [entry] = extractAcpToolCallEntries(record);
  return entry ?? {};
}

function hashDeterministicId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function buildAcpToolCallFallbackId(record: Record<string, unknown>): string {
  const entries = extractAcpToolCallEntries(record);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (
    entries.length === 0 &&
    !title &&
    typeof record.session_id !== "string" &&
    typeof record.model_call_id !== "string"
  ) {
    return "tool-call";
  }
  const seed = JSON.stringify({
    title: title || undefined,
    sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
    modelCallId: typeof record.model_call_id === "string" ? record.model_call_id : undefined,
    entries: entries.map((entry) => ({
      rawName: entry.rawName,
      path:
        typeof entry.args?.path === "string"
          ? entry.args.path
          : typeof entry.args?.filePath === "string"
            ? entry.args.filePath
            : undefined,
      pattern:
        typeof entry.args?.pattern === "string"
          ? entry.args.pattern
          : typeof entry.args?.query === "string"
            ? entry.args.query
            : typeof entry.args?.globPattern === "string"
              ? entry.args.globPattern
              : undefined,
      command:
        typeof entry.args?.command === "string"
          ? entry.args.command
          : typeof entry.args?.cmd === "string"
            ? entry.args.cmd
            : undefined,
    })),
  });
  return `tool-${hashDeterministicId(seed)}`;
}

function inferAcpToolKind(rawName: string | undefined): string {
  const name = humanizeAcpToolCallName(rawName ?? "").toLowerCase();
  if (!name) {
    return "tool";
  }
  if (name.includes("todo")) {
    return "todo";
  }
  if (name.includes("shell") || name.includes("terminal") || name.includes("command")) {
    return "terminal";
  }
  if (name.includes("grep")) {
    return "grep";
  }
  if (name.includes("glob") || name.includes("find") || name.includes("search")) {
    return "search";
  }
  if (name.includes("delete") || name.includes("remove") || name.includes("unlink")) {
    return "delete";
  }
  if (
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("apply") ||
    name.includes("update") ||
    name.includes("create") ||
    name.includes("insert") ||
    name.includes("str replace") ||
    name.includes("rename")
  ) {
    return "edit";
  }
  if (name.includes("read") || name.includes("open")) {
    return "read";
  }
  return "tool";
}

function acpRecordHasAnyKey(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): boolean {
  if (!record) {
    return false;
  }
  return keys.some((key) => key in record && record[key] != null);
}

function looksLikeAcpEditPayload(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  if (
    acpRecordHasAnyKey(record, [
      "diffString",
      "linesAdded",
      "linesRemoved",
      "beforeFullFileContent",
      "afterFullFileContent",
      "old_string",
      "new_string",
      "oldString",
      "newString",
      "replacement",
      "replacements",
      "patch",
      "edits",
      "contents",
      "renameTo",
      "newPath",
      "oldFileContent",
      "newFileContent",
      "previousContent",
      "writtenContent",
      "fileContentBefore",
      "fileContentAfter",
    ])
  ) {
    return true;
  }
  const errorText =
    typeof record.error === "string"
      ? record.error
      : record.error &&
          typeof record.error === "object" &&
          typeof (record.error as Record<string, unknown>).error === "string"
        ? ((record.error as Record<string, unknown>).error as string)
        : undefined;
  return Boolean(errorText && /failed to find context|apply patch|replace/i.test(errorText));
}

function looksLikeAcpReadShape(record: Record<string, unknown> | undefined): boolean {
  if (!record || looksLikeAcpEditPayload(record)) {
    return false;
  }
  return (
    typeof record.path === "string" ||
    typeof record.filePath === "string" ||
    typeof record.file_path === "string" ||
    "readRange" in record ||
    "lineRange" in record
  );
}

function inferAcpToolKindFromEntry(payload: {
  rawName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): string {
  if (looksLikeAcpEditPayload(payload.result) || looksLikeAcpEditPayload(payload.args)) {
    return "edit";
  }
  const fromName = inferAcpToolKind(payload.rawName);
  if (fromName !== "tool") {
    return fromName;
  }
  if (looksLikeAcpReadShape(payload.result) || looksLikeAcpReadShape(payload.args)) {
    return "read";
  }
  return "tool";
}

function summarizeAcpToolCallTitle(record: Record<string, unknown>): string | undefined {
  const entries = extractAcpToolCallEntries(record);
  if (entries.length > 1) {
    const parts = entries
      .map((entry) =>
        summarizeAcpToolCallTitle({
          ...record,
          tool_call: { [entry.rawName]: { args: entry.args, result: entry.result } },
        })
      )
      .filter((value): value is string => Boolean(value));
    const uniqueParts = parts.filter((value, index) => parts.indexOf(value) === index);
    if (uniqueParts.length > 0) {
      return uniqueParts.join(" + ");
    }
  }
  const payload = entries[0];
  if (!payload) {
    const scav = scavengePathStringsFromAcpRecord(record)[0];
    return scav ? formatReadToolTitle(scav) : undefined;
  }
  const args = payload.args ?? {};
  let path =
    typeof args.path === "string"
      ? args.path
      : typeof args.filePath === "string"
        ? args.filePath
        : typeof args.file_path === "string"
          ? args.file_path
          : typeof args.target_file === "string"
            ? args.target_file
            : typeof args.uri === "string"
              ? args.uri
              : typeof args.relPath === "string"
                ? args.relPath
                : typeof args.relativePath === "string"
                  ? args.relativePath
                  : typeof args.relative_path === "string"
                    ? args.relative_path
                    : typeof args.file === "string"
                      ? args.file
                      : undefined;
  if (!path) {
    path = scavengePathStringsFromAcpRecord(record)[0];
  }
  const pattern =
    typeof args.pattern === "string"
      ? args.pattern
      : typeof args.query === "string"
        ? args.query
        : typeof args.searchTerm === "string"
          ? args.searchTerm
          : typeof args.q === "string"
            ? args.q
            : typeof args.search_query === "string"
              ? args.search_query
              : typeof args.globPattern === "string"
                ? args.globPattern
                : typeof args.glob_pattern === "string"
                  ? args.glob_pattern
                  : undefined;
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.cmd === "string"
        ? args.cmd
        : undefined;
  const toolKind = inferAcpToolKindFromEntry(payload);
  const rawNameStr =
    typeof payload.rawName === "string" ? payload.rawName : undefined;
  const isWebSearch =
    toolKind === "search_web" ||
    (rawNameStr != null && /web_search|websearch|search_web/i.test(rawNameStr));
  if (toolKind === "read") {
    return formatReadToolTitle(path);
  }
  if (toolKind === "grep") {
    return formatGrepToolTitle(pattern);
  }
  if (isWebSearch) {
    return formatWebSearchTitle(pattern);
  }
  if (toolKind === "search") {
    return formatFindToolTitle(pattern);
  }
  if (toolKind === "delete") {
    return formatDeleteToolTitle(path, "Delete file");
  }
  if (toolKind === "edit") {
    return formatUpdateToolTitle(path, "Update file");
  }
  if (toolKind === "todo") {
    return "Update todo list";
  }
  if (command) {
    return formatTerminalCommandTitle(command);
  }
  return payload.rawName
    ? truncateGenericToolTitle(humanizeAcpToolCallName(payload.rawName), "Tool call")
    : undefined;
}

function summarizeAcpToolCallDetail(record: Record<string, unknown>): string | undefined {
  const payloads = extractAcpToolCallEntries(record);
  const rejected = payloads
    .map((payload) =>
      payload.result?.rejected &&
      typeof payload.result.rejected === "object" &&
      !Array.isArray(payload.result.rejected)
        ? (payload.result.rejected as Record<string, unknown>)
        : undefined
    )
    .find((value) => value != null);
  if (rejected) {
    return formatRejectedToolDetail(rejected);
  }
  for (const payload of payloads) {
    if (typeof payload.args?.description === "string" && payload.args.description.trim()) {
      return payload.args.description.trim();
    }
  }
  return summarizeToolContent(record.content);
}

function normalizeAcpToolCallStatus(
  record: Record<string, unknown>,
  fallback: AgentToolCallStatus
): AgentToolCallStatus {
  if (record.status === "failed" || record.status === "cancelled") {
    return record.status;
  }
  if (
    extractAcpToolCallEntries(record).some((payload) => Boolean(payload.result?.rejected))
  ) {
    return "failed";
  }
  if (record.status === "completed") {
    return "completed";
  }
  if (record.subtype === "completed") {
    return "completed";
  }
  if (
    record.subtype === "started" &&
    (record.status == null || record.status === "pending")
  ) {
    return "in_progress";
  }
  if (
    record.status === "pending" ||
    record.status === "in_progress"
  ) {
    return record.status;
  }
  if (record.subtype === "started") {
    return "in_progress";
  }
  return fallback;
}

function humanizePermissionOptionLabel(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "Option";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function normalizePermissionOptionKind(input: {
  kind?: unknown;
  optionId?: string;
  name?: string;
}): AgentPermissionOption["kind"] | null {
  const direct =
    typeof input.kind === "string"
      ? input.kind.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  if (
    direct === "allow_once" ||
    direct === "allow_always" ||
    direct === "reject_once" ||
    direct === "reject_always"
  ) {
    return direct;
  }
  const seed = `${input.optionId ?? ""} ${input.name ?? ""} ${direct}`
    .trim()
    .toLowerCase();
  if (!seed) {
    return null;
  }
  const isAllow = /(allow|approve|accept|continue|yes|grant)/.test(seed);
  const isReject = /(reject|deny|decline|block|cancel|stop|no)/.test(seed);
  const isAlways = /(always|permanent|persist|remember|future)/.test(seed);
  if (isAllow) {
    return isAlways ? "allow_always" : "allow_once";
  }
  if (isReject) {
    return isAlways ? "reject_always" : "reject_once";
  }
  if (direct === "allow") {
    return "allow_once";
  }
  if (direct === "reject" || direct === "deny") {
    return "reject_once";
  }
  return null;
}

function parsePermissionOptions(raw: unknown): AgentPermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        const optionId = item.trim();
        const name = humanizePermissionOptionLabel(optionId);
        const kind = normalizePermissionOptionKind({ optionId, name });
        return kind
          ? ({
              optionId,
              name,
              kind,
            } satisfies AgentPermissionOption)
          : null;
      }
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const optionId =
        typeof record.optionId === "string"
          ? record.optionId.trim()
          : typeof record.id === "string"
            ? record.id.trim()
            : typeof record.value === "string"
              ? record.value.trim()
              : typeof record.key === "string"
                ? record.key.trim()
                : typeof record.actionId === "string"
                  ? record.actionId.trim()
                  : undefined;
      const name =
        typeof record.name === "string"
          ? record.name.trim()
          : typeof record.label === "string"
            ? record.label.trim()
            : typeof record.title === "string"
              ? record.title.trim()
              : typeof record.text === "string"
                ? record.text.trim()
                : optionId
                  ? humanizePermissionOptionLabel(optionId)
                  : undefined;
      const kind = normalizePermissionOptionKind({
        kind: record.kind ?? record.type ?? record.action,
        optionId,
        name,
      });
      if (!optionId || !name || !kind) {
        return null;
      }
      return {
        optionId,
        name,
        kind,
      } satisfies AgentPermissionOption;
    })
    .filter((value): value is AgentPermissionOption => value !== null);
}

function withPersistentPermissionOptions(
  options: AgentPermissionOption[]
): AgentPermissionOption[] {
  const next = [...options];
  const hasAllowOnce = next.some((option) => option.kind === "allow_once");
  const hasAllowAlways = next.some((option) => option.kind === "allow_always");
  const hasRejectOnce = next.some((option) => option.kind === "reject_once");
  const hasRejectAlways = next.some((option) => option.kind === "reject_always");
  if (
    hasAllowOnce &&
    !hasAllowAlways &&
    !next.some((option) => option.optionId === "allow_always")
  ) {
    next.push({
      optionId: "allow_always",
      name: "Allow always",
      kind: "allow_always",
    });
  }
  if (
    hasRejectOnce &&
    !hasRejectAlways &&
    !next.some((option) => option.optionId === "reject_always")
  ) {
    next.push({
      optionId: "reject_always",
      name: "Reject always",
      kind: "reject_always",
    });
  }
  return next;
}

function buildFallbackPermissionOptions(
  _backendId: AgentBackendId
): AgentPermissionOption[] {
  return [
    {
      optionId: "allow_once",
      name: "Allow once",
      kind: "allow_once",
    },
    {
      optionId: "allow_always",
      name: "Allow always",
      kind: "allow_always",
    },
    {
      optionId: "reject_once",
      name: "Reject",
      kind: "reject_once",
    },
    {
      optionId: "reject_always",
      name: "Reject always",
      kind: "reject_always",
    },
  ];
}

function permissionDecisionFromKind(
  kind: AgentPermissionOption["kind"] | undefined
): "allow" | "reject" | null {
  if (kind === "allow_once" || kind === "allow_always") {
    return "allow";
  }
  if (kind === "reject_once" || kind === "reject_always") {
    return "reject";
  }
  return null;
}

function providerOptionIdForPermissionSelection(
  options: AgentPermissionOption[],
  selectedOptionId: string | undefined
): string | undefined {
  const selected = options.find((option) => option.optionId === selectedOptionId);
  if (!selected) {
    return selectedOptionId;
  }
  if (selected.kind === "allow_always") {
    return options.find((option) => option.kind === "allow_once")?.optionId ?? selected.optionId;
  }
  if (selected.kind === "reject_always") {
    return options.find((option) => option.kind === "reject_once")?.optionId ?? selected.optionId;
  }
  return selected.optionId;
}

function providerOptionIdForRememberedPermission(
  options: AgentPermissionOption[],
  decision: "allow" | "reject"
): string | undefined {
  const onceKind = decision === "allow" ? "allow_once" : "reject_once";
  const alwaysKind = decision === "allow" ? "allow_always" : "reject_always";
  return (
    options.find((option) => option.kind === onceKind)?.optionId ??
    options.find((option) => option.kind === alwaysKind)?.optionId
  );
}

function normalizeToolCallId(record: Record<string, unknown>): string {
  const readIdFromNestedRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const nested = value as Record<string, unknown>;
    if (typeof nested.toolCallId === "string" && nested.toolCallId.trim()) {
      return nested.toolCallId;
    }
    if (typeof nested.toolUseId === "string" && nested.toolUseId.trim()) {
      return nested.toolUseId;
    }
    if (typeof nested.tool_use_id === "string" && nested.tool_use_id.trim()) {
      return nested.tool_use_id;
    }
    if (typeof nested.call_id === "string" && nested.call_id.trim()) {
      return nested.call_id;
    }
    if (typeof nested.callId === "string" && nested.callId.trim()) {
      return nested.callId;
    }
    if (typeof nested.id === "string" && nested.id.trim()) {
      return nested.id;
    }
    return undefined;
  };
  if (typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return record.toolCallId;
  }
  if (typeof record.toolUseId === "string" && record.toolUseId.trim()) {
    return record.toolUseId;
  }
  if (typeof record.tool_use_id === "string" && record.tool_use_id.trim()) {
    return record.tool_use_id;
  }
  if (typeof record.call_id === "string" && record.call_id.trim()) {
    return record.call_id;
  }
  if (typeof record.callId === "string" && record.callId.trim()) {
    return record.callId;
  }
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id;
  }
  for (const payload of extractAcpToolCallEntries(record)) {
    const nestedId = readIdFromNestedRecord(payload.args) ?? readIdFromNestedRecord(payload.result);
    if (nestedId) {
      return nestedId;
    }
  }
  return buildAcpToolCallFallbackId(record);
}

function pathFromAcpLocationRecord(locationRecord: Record<string, unknown>): string | undefined {
  const raw =
    (typeof locationRecord.path === "string" && locationRecord.path) ||
    (typeof locationRecord.filePath === "string" && locationRecord.filePath) ||
    (typeof locationRecord.file_path === "string" && locationRecord.file_path) ||
    (typeof locationRecord.file === "string" && locationRecord.file) ||
    (typeof locationRecord.uri === "string" && locationRecord.uri) ||
    (typeof locationRecord.href === "string" && locationRecord.href);
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = p.replace(/^file:\/\//i, "");
    }
  }
  return p;
}

function extractAcpLocations(record: Record<string, unknown>): { path: string; line?: number }[] | undefined {
  const nextLocations: { path: string; line?: number }[] = [];
  if (Array.isArray(record.locations)) {
    for (const location of record.locations) {
      if (!location || typeof location !== "object") {
        continue;
      }
      const locationRecord = location as Record<string, unknown>;
      const resolvedPath = pathFromAcpLocationRecord(locationRecord);
      if (!resolvedPath) {
        continue;
      }
      nextLocations.push({
        path: resolvedPath,
        line:
          typeof locationRecord.line === "number"
            ? locationRecord.line
            : undefined,
      });
    }
  }
  const single = record.location;
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const resolvedPath = pathFromAcpLocationRecord(single as Record<string, unknown>);
    if (resolvedPath) {
      nextLocations.push({
        path: resolvedPath,
        line:
          typeof (single as Record<string, unknown>).line === "number"
            ? ((single as Record<string, unknown>).line as number)
            : undefined,
      });
    }
  }
  const flat =
    (typeof record.path === "string" && record.path.trim()) ||
    (typeof record.filePath === "string" && record.filePath.trim()) ||
    (typeof record.file_path === "string" && record.file_path.trim()) ||
    (typeof record.target_file === "string" && record.target_file.trim()) ||
    (typeof record.uri === "string" && record.uri.trim());
  if (flat && !nextLocations.some((entry) => entry.path === flat)) {
    nextLocations.push({ path: flat });
  }
  return nextLocations.length > 0 ? nextLocations : undefined;
}

function extractAcpEditPreview(
  record: Record<string, unknown>,
  fallbackPath?: string
) {
  for (const payload of extractAcpToolCallEntries(record)) {
    if (inferAcpToolKindFromEntry(payload) !== "edit") {
      continue;
    }
    const preview = extractToolEditPreview(payload.args, payload.result, fallbackPath);
    if (preview) {
      return preview;
    }
  }
  return extractToolEditPreview(record, record, fallbackPath);
}

const ACP_PATH_SCAVENGE_KEYS = [
  "path",
  "filePath",
  "filepath",
  "file_path",
  "target_file",
  "targetPath",
  "relativePath",
  "relative_path",
  "relPath",
  "uri",
  "href",
  "file",
  "workspacePath",
  "workspace_path",
  "cwd",
  "directory",
  "folder",
  "absolutePath",
  "absolute_path",
  "localPath",
  "local_path",
  "fullPath",
  "full_path",
  "source",
  "destination",
  "rootPath",
] as const;

function acpValueLooksLikeFsPath(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 4096) {
    return false;
  }
  if (/^file:/i.test(t)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) {
    return true;
  }
  return t.includes("/") || t.includes("\\");
}

/** Single-segment `foo.ts` style references some agents send without `/`. */
function isLikelyBareFileReferenceString(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes("\n") || t.length > 384 || /\s/.test(t)) {
    return false;
  }
  return /^[\w./%-]+\.[A-Za-z0-9]{1,12}$/.test(t);
}

function pushNormalizedScavengePath(raw: string, out: string[]): void {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      p = p.replace(/^file:\/\//i, "");
    }
  }
  out.push(p);
}

function collectAcpPathsFromUnknown(value: unknown, depth: number, out: string[]): void {
  if (depth > 14 || out.length >= 24) {
    return;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") && (t.includes("path") || t.includes("file"))) {
      const o = parseLooseJsonObjectForAcp(t);
      if (o) {
        collectAcpPathsFromUnknown(o, depth + 1, out);
      }
    } else if (acpValueLooksLikeFsPath(t) || isLikelyBareFileReferenceString(t)) {
      pushNormalizedScavengePath(t, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (x): x is string =>
          typeof x === "string" && x.trim().length > 0 && !x.includes("\n")
      ) &&
      value.every((x) =>
        Boolean(acpValueLooksLikeFsPath(x) || isLikelyBareFileReferenceString(x))
      )
    ) {
      for (const s of value) {
        pushNormalizedScavengePath(s, out);
      }
      return;
    }
    for (const item of value) {
      collectAcpPathsFromUnknown(item, depth + 1, out);
    }
    return;
  }
  const o = value as Record<string, unknown>;
  for (const key of ACP_PATH_SCAVENGE_KEYS) {
    const v = o[key];
    if (
      typeof v === "string" &&
      v.trim() &&
      (acpValueLooksLikeFsPath(v) || isLikelyBareFileReferenceString(v))
    ) {
      pushNormalizedScavengePath(v, out);
    }
  }
  for (const v of Object.values(o)) {
    collectAcpPathsFromUnknown(v, depth + 1, out);
  }
}

function scavengePathStringsFromAcpRecord(record: Record<string, unknown>): string[] {
  const collected: string[] = [];
  collectAcpPathsFromUnknown(record, 0, collected);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of collected) {
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(p);
    }
  }
  return deduped;
}

function mergeScavengedAcpLocations(
  record: Record<string, unknown>
): { path: string; line?: number }[] | undefined {
  const base = extractAcpLocations(record) ?? [];
  const scav = scavengePathStringsFromAcpRecord(record);
  const merged = [...base];
  for (const p of scav) {
    if (!merged.some((e) => e.path === p)) {
      merged.push({ path: p });
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function normalizeAcpSessionUpdateKind(record: Record<string, unknown>): string | undefined {
  const direct = record.sessionUpdate ?? record.session_update;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const alt = record.updateType ?? record.update_type;
  if (typeof alt === "string" && alt.trim()) {
    return alt.trim();
  }
  return undefined;
}

function readOpenCodeSseChildSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const pr = params as Record<string, unknown>;
  const meta = pr._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>).openCodeChildSessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** Avoid collisions when multiple OpenCode child sessions reuse the same callID. */
function namespaceOpenCodeSseToolCallId(baseId: string, childSessionId?: string): string {
  if (!childSessionId || !baseId) {
    return baseId;
  }
  if (baseId.startsWith("opencode-sa:")) {
    return baseId;
  }
  return `opencode-sa:${childSessionId}:${baseId}`;
}

function extractPermissionRequestDetail(
  record: Record<string, unknown>,
  toolCall: Record<string, unknown>
): string | undefined {
  for (const key of [
    "message",
    "description",
    "detail",
    "rationale",
    "reason",
    "summary",
    "prompt",
  ] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  for (const key of ["message", "description", "detail", "reason"] as const) {
    const v = toolCall[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  const args =
    toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args)
      ? (toolCall.args as Record<string, unknown>)
      : undefined;
  if (args) {
    const desc = args.description ?? args.prompt;
    if (typeof desc === "string" && desc.trim()) {
      return desc.trim();
    }
    const cmd = args.command ?? args.cmd;
    if (typeof cmd === "string" && cmd.trim()) {
      return `Command: ${cmd.trim()}`;
    }
  }
  return undefined;
}

const PERMISSION_SIGNATURE_STRING_MAX = 1000;
const PERMISSION_SIGNATURE_DEPTH_MAX = 8;
const PERMISSION_SIGNATURE_IGNORED_KEYS = new Set([
  "id",
  "requestId",
  "request_id",
  "toolCallId",
  "tool_call_id",
  "toolUseId",
  "tool_use_id",
  "callId",
  "call_id",
  "sessionId",
  "session_id",
  "timestamp",
  "createdAt",
  "updatedAt",
]);

function normalizePermissionSignatureValue(value: unknown, depth = 0): unknown {
  if (depth > PERMISSION_SIGNATURE_DEPTH_MAX) {
    return "...";
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > PERMISSION_SIGNATURE_STRING_MAX
      ? `${trimmed.slice(0, PERMISSION_SIGNATURE_STRING_MAX)}...`
      : trimmed;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => normalizePermissionSignatureValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (PERMISSION_SIGNATURE_IGNORED_KEYS.has(key)) {
        continue;
      }
      out[key] = normalizePermissionSignatureValue(record[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

function stablePermissionJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stablePermissionJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stablePermissionJson(record[key])}`)
    .join(",")}}`;
}

function buildPermissionToolSignature(input: {
  record: Record<string, unknown>;
  toolCall: Record<string, unknown>;
  title: string;
  detail?: string;
}): { toolKey: string; toolLabel: string } {
  const entries = extractAcpToolCallEntries(input.toolCall);
  const fallbackEntries = entries.length > 0 ? entries : extractAcpToolCallEntries(input.record);
  const material =
    fallbackEntries.length > 0
      ? {
          entries: fallbackEntries.map((entry) => ({
            name: entry.rawName,
            kind: inferAcpToolKindFromEntry(entry),
            args: normalizePermissionSignatureValue(entry.args ?? {}),
          })),
        }
      : {
          title: normalizePermissionSignatureValue(input.title),
          detail: normalizePermissionSignatureValue(input.detail),
          tool: normalizePermissionSignatureValue(input.toolCall),
        };
  const json = stablePermissionJson(material);
  const digest = createHash("sha256").update(json).digest("hex").slice(0, 40);
  return {
    toolKey: `acp:${digest}`,
    toolLabel:
      summarizeAcpToolCallTitle(input.toolCall) ??
      input.title ??
      input.detail ??
      "Tool permission",
  };
}

class AcpSessionHandle implements AgentSessionHandle {
  readonly sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;

  private readonly pendingPermissionRequestIds = new Map<string, number | string>();
  private readonly pendingPermissionContextById = new Map<
    string,
    {
      options: AgentPermissionOption[];
      toolKey: string;
      toolLabel: string;
    }
  >();
  private currentAssistantMessageId: string | null = null;
  private disposed = false;
  private readonly bridge: AcpSharedBridge;
  private readonly releaseBridge: () => Promise<void>;
  private readonly callbacks: AgentRuntimeCallbacks;
  private readonly backend: AgentBackendInfo;
  private readonly seedConfigOptions: AgentConfigOption[] | undefined;
  private suppressedAssistantChunks: string[] | null = null;
  private currentCursorPromptHints: CursorPromptToolHints | null = null;
  private readonly cursorToolInferences = new Map<string, CursorToolInference>();
  /** Drop identical ACP re-broadcasts of the same tool announcement; avoids duplicate DB + WS. */
  private readonly acpInitialToolCallKeys = new Set<string>();
  private readonly acpToolUpdateKeys = new Set<string>();
  /** Stock `opencode acp` embeds HTTP; we subscribe to `/global/event` for child-session streaming. */
  private readonly openCodeSseDetach: { poolKey: string; regId: string } | null;

  private constructor(input: {
    bridge: AcpSharedBridge;
    releaseBridge: () => Promise<void>;
    callbacks: AgentRuntimeCallbacks;
    backend: AgentBackendInfo;
    sessionId: string;
    configOptions: AgentConfigOption[];
    capabilities: AgentProviderCapabilities;
    seedConfigOptions?: AgentConfigOption[];
    openCodeSse?: {
      poolKey: string;
      regId: string;
      baseUrl: string;
      workspaceRoot: string;
    };
  }) {
    this.bridge = input.bridge;
    this.releaseBridge = input.releaseBridge;
    this.callbacks = input.callbacks;
    this.backend = input.backend;
    this.sessionId = input.sessionId;
    this.configOptions = input.configOptions;
    this.capabilities = input.capabilities;
    this.seedConfigOptions = input.seedConfigOptions;
    this.openCodeSseDetach = input.openCodeSse
      ? { poolKey: input.openCodeSse.poolKey, regId: input.openCodeSse.regId }
      : null;
    this.registerBridgeHandlers();
    if (input.openCodeSse) {
      const ctx = input.openCodeSse;
      attachOpenCodeGlobalSse(ctx.poolKey, ctx.regId, {
        workspaceRoot: ctx.workspaceRoot,
        rootSessionId: input.sessionId,
        baseUrl: ctx.baseUrl,
        onEvent: (directory, payload) => this.deliverOpenCodeSsePayload(directory, payload),
      });
    }
  }

  private beginCursorPromptInference(promptText: string): void {
    if (!backendUsesAcpPromptHints(this.backend.id)) {
      return;
    }
    this.currentCursorPromptHints = buildCursorPromptToolHints(
      this.callbacks.workspace.root,
      promptText
    );
    this.cursorToolInferences.clear();
  }

  private endCursorPromptInference(): void {
    this.currentCursorPromptHints = null;
    this.cursorToolInferences.clear();
  }

  private getCursorToolInference(toolCallId: string): CursorToolInference {
    const existing = this.cursorToolInferences.get(toolCallId);
    if (existing) {
      return existing;
    }
    const created: CursorToolInference = {};
    this.cursorToolInferences.set(toolCallId, created);
    return created;
  }

  private assignCursorPromptHints(toolCallId: string, toolKind: string): CursorToolInference {
    const inference = this.getCursorToolInference(toolCallId);
    if (toolKind && toolKind !== "tool" && !inference.toolKind) {
      inference.toolKind = toolKind;
    }
    const promptHints = this.currentCursorPromptHints;
    if (!promptHints) {
      return inference;
    }
    if (
      toolKind === "read" &&
      !inference.path &&
      promptHints.nextPathIndex < promptHints.explicitPaths.length
    ) {
      const hintedPath = promptHints.explicitPaths[promptHints.nextPathIndex++]!;
      inference.path = hintedPath;
      inference.locations = [{ path: hintedPath }];
    }
    if (
      (toolKind === "search" || toolKind === "grep") &&
      !inference.query &&
      promptHints.nextSearchIndex < promptHints.searches.length
    ) {
      const hint = promptHints.searches[promptHints.nextSearchIndex++]!;
      inference.query = hint.query;
      inference.searchPresentation = hint.presentation;
    }
    return inference;
  }

  private async enrichCursorToolCall(input: {
    toolCallId: string;
    toolKind: string;
    title: string | undefined;
    detail: string | undefined;
    locations: { path: string; line?: number }[] | undefined;
    record: Record<string, unknown>;
    status: AgentToolCallStatus;
  }): Promise<{
    toolKind: string;
    title: string | undefined;
    detail: string | undefined;
    locations: { path: string; line?: number }[] | undefined;
  }> {
    if (!backendUsesAcpPromptHints(this.backend.id)) {
      return {
        toolKind: input.toolKind,
        title: input.title,
        detail: input.detail,
        locations: input.locations,
      };
    }

    const next = {
      toolKind: input.toolKind,
      title: input.title,
      detail: input.detail,
      locations: input.locations,
    };
    const inference = this.assignCursorPromptHints(input.toolCallId, next.toolKind);
    if (next.toolKind === "tool" && inference.toolKind) {
      next.toolKind = inference.toolKind;
    }

    if (
      next.toolKind === "read" &&
      input.status === "completed" &&
      (!inference.path || !next.locations?.length)
    ) {
      const rawOutput =
        parseLooseJsonObjectForAcp(input.record.rawOutput) ??
        parseLooseJsonObjectForAcp(input.record.raw_output) ??
        (input.record.rawOutput &&
        typeof input.record.rawOutput === "object" &&
        !Array.isArray(input.record.rawOutput)
          ? (input.record.rawOutput as Record<string, unknown>)
          : undefined);
      const readContent =
        typeof rawOutput?.content === "string"
          ? rawOutput.content
          : typeof rawOutput?.text === "string"
            ? rawOutput.text
            : undefined;
      if (readContent?.trim()) {
        const promptPaths = this.currentCursorPromptHints?.explicitPaths ?? [];
        const matchedPath = await inferCursorReadPathFromContent(
          this.callbacks.workspace.root,
          readContent,
          inference.path ? [inference.path, ...promptPaths] : promptPaths
        );
        if (matchedPath) {
          inference.path = matchedPath;
          inference.locations = [{ path: matchedPath }];
        }
      }
    }

    if (next.toolKind === "read") {
      if ((!next.locations || next.locations.length === 0) && inference.locations?.length) {
        next.locations = inference.locations;
      }
      if ((!next.locations || next.locations.length === 0) && inference.path) {
        next.locations = [{ path: inference.path }];
      }
      if (
        (isGenericAcpToolTitle(next.title) || next.title === "Read file" || next.title === "Tool call") &&
        inference.path
      ) {
        next.title = formatReadToolTitle(inference.path);
      }
    }

    if (next.toolKind === "search" || next.toolKind === "grep") {
      if (
        input.status === "completed" &&
        inference.query &&
        (!inference.locations || inference.locations.length === 0)
      ) {
        const locations = await inferCursorSearchLocations(
          this.callbacks.workspace.root,
          inference.query
        );
        if (locations.length > 0) {
          inference.locations = locations;
          const uniqueFiles = countUniqueLocationPaths(locations);
          inference.detail = `${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"} matched`;
        }
      }
      if ((!next.locations || next.locations.length === 0) && inference.locations?.length) {
        next.locations = inference.locations;
      }
      if (!next.detail && inference.detail) {
        next.detail = inference.detail;
      }
      if (isGenericCursorSearchTitle(next.title) && inference.query) {
        next.title =
          inference.searchPresentation === "grep"
            ? formatGrepToolTitle(inference.query)
            : formatFindToolTitle(inference.query);
      }
    }

    return next;
  }

  static async create(input: {
    backend: AgentBackendInfo;
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    callbacks: AgentRuntimeCallbacks;
    loadSessionId?: string | null;
    seedConfigOptions?: AgentConfigOption[];
  }): Promise<AcpSessionHandle> {
    let command = input.command;
    let args = input.args;
    let env = input.env ?? process.env;
    let openCodeSse:
      | { poolKey: string; regId: string; baseUrl: string; workspaceRoot: string }
      | undefined;

    if (input.backend.id === "opencode-acp") {
      const port = await getOpenCodeAcpListenPort(input.callbacks.workspace.root);
      const baseUrl = openCodeAcpInternalBaseUrl(port);
      const inv = resolveOpenCodeAcpInvocationWithPort(port);
      if (!inv) {
        throw new Error(`${input.backend.label} is not installed or could not be resolved.`);
      }
      command = inv.command;
      args = inv.args;
      env = inv.env ?? env;
      const poolKeyEarly = makeAcpPoolKey({
        workspaceRoot: input.callbacks.workspace.root,
        backendId: input.backend.id,
        command,
        args,
      });
      openCodeSse = {
        poolKey: poolKeyEarly,
        regId: randomUUID(),
        baseUrl,
        workspaceRoot: input.callbacks.workspace.root,
      };
    }

    const poolKey = makeAcpPoolKey({
      workspaceRoot: input.callbacks.workspace.root,
      backendId: input.backend.id,
      command,
      args,
    });
    const { bridge, release, bootstrapSystemMessages } = await retainAcpSharedBridge({
      poolKey,
      spawn: () =>
        AcpStdioClient.spawn({
          command,
          args,
          cwd: input.callbacks.workspace.root,
          env,
        }),
      afterSpawn: (transport) => runAcpTransportBootstrap(transport),
    });

    const isInvalidParamsError = (error: unknown): boolean => {
      if (error instanceof AcpJsonRpcError) {
        // JSON-RPC: -32602 = Invalid params
        return error.code === -32602;
      }
      const message = error instanceof Error ? error.message : String(error ?? "");
      return /invalid params?/i.test(message);
    };

    const tryOpenSession = async (): Promise<Record<string, unknown> | null | undefined> => {
      if (!input.loadSessionId) {
        return (await bridge.request("session/new", {
          cwd: input.callbacks.workspace.root,
          mcpServers: [],
        })) as Record<string, unknown> | null | undefined;
      }

      // IMPORTANT: Cursor's `session/load` param schema is strict. In practice:
      // - `cwd` and `mcpServers` are required
      // - `mcpServers` must be an array (empty is fine)
      //
      // Do NOT "compat" by dropping keys — that produces unrelated -32603 schema errors
      // and makes retries look like random failures.
      const workspaceRoot = input.callbacks.workspace.root;
      let workspaceRootReal = workspaceRoot;
      try {
        workspaceRootReal = await fs.realpath(workspaceRoot);
      } catch {
        // best-effort; keep logical root
      }

      const loadAttempts: Array<Record<string, unknown>> = [
        {
          sessionId: input.loadSessionId,
          cwd: workspaceRoot,
          mcpServers: [],
        },
        ...(workspaceRootReal !== workspaceRoot
          ? [
              {
                sessionId: input.loadSessionId,
                cwd: workspaceRootReal,
                mcpServers: [],
              },
            ]
          : []),
        {
          sessionId: input.loadSessionId,
          cwd: path.resolve(workspaceRoot),
          mcpServers: [],
        },
      ];

      let lastError: unknown;
      for (let index = 0; index < loadAttempts.length; index += 1) {
        try {
          const result = (await bridge.request(
            "session/load",
            loadAttempts[index]
          )) as Record<string, unknown> | null | undefined;
          if (index > 0) {
            await input.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: input.callbacks.conversation.id,
                kind: "system",
                level: "warning",
                text: `Recovered provider session load using compatibility params fallback (attempt ${index + 1}).`,
              },
            ]);
          }
          return result;
        } catch (error) {
          lastError = error;
          if (!isInvalidParamsError(error)) {
            throw error;
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    };

    bridge.startCreationCapture();
    try {
      const openResult = await tryOpenSession();

      const openResultRecord =
        openResult && typeof openResult === "object"
          ? (openResult as Record<string, unknown>)
          : {};

      const sessionId =
        typeof openResultRecord.sessionId === "string"
          ? openResultRecord.sessionId
          : input.loadSessionId;
      if (!sessionId) {
        throw new Error("ACP session did not return a sessionId.");
      }

      const liveConfigOptions = mergeSessionConfigOptions(
        parseConfigOptions(openResultRecord.configOptions),
        parseLegacySessionConfigOptions(openResultRecord)
      );
      const configOptions =
        input.backend.id === "cursor-acp"
          ? mergeCursorSeedConfigOptions(
              input.seedConfigOptions,
              liveConfigOptions,
              input.callbacks.conversation.config
            )
          : liveConfigOptions;

      const handle = new AcpSessionHandle({
        bridge,
        releaseBridge: release,
        callbacks: input.callbacks,
        backend: input.backend,
        sessionId,
        configOptions,
        capabilities: input.backend.capabilities,
        seedConfigOptions: input.seedConfigOptions,
        openCodeSse: input.backend.id === "opencode-acp" && openCodeSse ? openCodeSse : undefined,
      });

      await input.callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: sessionId,
        configOptions: configOptions.length > 0 ? configOptions : current.configOptions,
        capabilities: input.backend.capabilities,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));

      if (bootstrapSystemMessages.length > 0) {
        await input.callbacks.appendEvents(
          bootstrapSystemMessages.map((text) => ({
            eventId: randomUUID(),
            conversationId: input.callbacks.conversation.id,
            kind: "system" as const,
            level: "info" as const,
            text,
          }))
        );
      }

      if (configOptions.length > 0) {
        await handle.persistConfigOptions(configOptions);
      }
      bridge.endCreationCapture(sessionId, (method, params) => {
        void handle.handleNotification(method, params);
      });
      await handle.applyConversationConfig(input.callbacks.conversation);
      return handle;
    } catch (error) {
      const detail =
        error instanceof AcpJsonRpcError
          ? {
              kind: "acp_jsonrpc_error" as const,
              method: error.method,
              code: error.code,
              message: error.message,
              params: error.params,
              data: error.data,
            }
          : {
              kind: "unknown_error" as const,
              message: error instanceof Error ? error.message : String(error),
            };
      const headline =
        error instanceof AcpJsonRpcError
          ? `ACP JSON-RPC request failed: ${error.method} (${error.code})`
          : "ACP session initialization failed.";

      await input.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: input.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: headline,
          raw: detail,
        },
      ]);
      bridge.cancelCreationCapture();
      await release();
      throw error;
    }
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    const assistantMessageId = randomUUID();
    this.currentAssistantMessageId = assistantMessageId;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));
    this.beginCursorPromptInference(input.text);

    try {
      const promptContent: Record<string, unknown>[] = [];
      if (input.attachments && input.attachments.length > 0) {
        for (const attachment of input.attachments) {
          promptContent.push({
            type: "image",
            mimeType: attachment.mimeType,
            data: attachment.data,
          });
        }
      }
      if (input.text.trim()) {
        promptContent.push({ type: "text", text: input.text });
      }

      const result = (await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: input.userMessageId,
        prompt: promptContent,
      })) as Record<string, unknown> | undefined;

      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason:
            typeof result?.stopReason === "string"
              ? result.stopReason
              : undefined,
          raw: result,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail:
            typeof result?.stopReason === "string"
              ? `Stop reason: ${result.stopReason}`
              : undefined,
        },
      ]);

      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
      }));
      this.endCursorPromptInference();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ACP prompt failed.";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: message,
      }));
      this.endCursorPromptInference();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.bridge.notify("session/cancel", { sessionId: this.sessionId });
    for (const requestId of this.pendingPermissionRequestIds.values()) {
      this.bridge.respond(requestId, {
        outcome: {
          outcome: "cancelled",
        },
      });
    }
    this.pendingPermissionRequestIds.clear();
    this.pendingPermissionContextById.clear();
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Prompt turn cancelled by the client.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "idle",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const modelOption = findPrimaryModelConfigOption(this.configOptions);
    if (
      this.backend.id === "cursor-acp" &&
      modelOption &&
      modelOption.id === configId
    ) {
      const trimmedValue = value.trim();
      if (isCursorCliModelId(trimmedValue)) {
        await this.runCursorModelSlashCommand(trimmedValue);
        await this.persistConfigOptions(
          this.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: trimmedValue } : option
          )
        );
        return;
      }
      if (trimmedValue.includes("[")) {
        await this.bridge.request("session/set_model", {
          sessionId: this.sessionId,
          modelId: trimmedValue,
        });
        await this.persistConfigOptions(
          this.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: trimmedValue } : option
          )
        );
        return;
      }
    }
    if (configId === LEGACY_MODE_CONFIG_ID) {
      await this.bridge.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    if (configId === LEGACY_MODEL_CONFIG_ID) {
      await this.bridge.request("session/set_model", {
        sessionId: this.sessionId,
        modelId: value,
      });
      await this.persistConfigOptions(
        this.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        )
      );
      return;
    }
    const result = (await this.bridge.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    })) as Record<string, unknown> | undefined;
    const parsed = mergeSessionConfigOptions(
      parseConfigOptions(result?.configOptions),
      parseLegacySessionConfigOptions(result ?? {})
    );
    if (parsed.length > 0) {
      await this.persistConfigOptions(parsed);
      return;
    }
    this.configOptions = this.configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option
    );
    await this.callbacks.updateConversation((current) => ({
      ...current,
      configOptions: this.configOptions,
    }));
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    const rawId = this.pendingPermissionRequestIds.get(input.requestId);
    if (rawId === undefined) {
      throw new Error(`Unknown pending permission request: ${input.requestId}`);
    }
    const context = this.pendingPermissionContextById.get(input.requestId);
    const selected = context?.options.find((option) => option.optionId === input.optionId);
    const providerOptionId = providerOptionIdForPermissionSelection(
      context?.options ?? [],
      input.optionId
    );
    this.bridge.respond(rawId, {
      outcome: input.cancelled
        ? { outcome: "cancelled" }
        : {
            outcome: "selected",
            optionId: providerOptionId,
          },
    });
    this.pendingPermissionRequestIds.delete(input.requestId);
    this.pendingPermissionContextById.delete(input.requestId);
    if (
      !input.cancelled &&
      context &&
      selected &&
      (selected.kind === "allow_always" || selected.kind === "reject_always")
    ) {
      const decision = permissionDecisionFromKind(selected.kind);
      if (decision) {
        await saveRememberedAgentPermissionRule({
          workspaceId: this.callbacks.workspace.id,
          backendId: this.backend.id,
          toolKey: context.toolKey,
          toolLabel: context.toolLabel,
          decision,
          optionId: selected.optionId,
          optionKind: selected.kind,
        }).catch(() => undefined);
      }
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.openCodeSseDetach) {
      detachOpenCodeGlobalSse(this.openCodeSseDetach.poolKey, this.openCodeSseDetach.regId);
    }
    this.pendingPermissionContextById.clear();
    this.bridge.unregister(this.sessionId);
    await this.releaseBridge();
  }

  private async deliverOpenCodeSsePayload(
    directory: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (this.disposed || this.backend.id !== "opencode-acp") {
      return;
    }
    try {
      if (directory && path.resolve(directory) !== path.resolve(this.callbacks.workspace.root)) {
        return;
      }
    } catch {
      return;
    }
    const translated = translateOpenCodeGlobalPayload({
      conversationId: this.callbacks.conversation.id,
      rootSessionId: this.sessionId,
      payload,
    });
    if (translated.kind === "none") {
      return;
    }
    if (translated.kind === "append") {
      await this.callbacks.appendEvents(translated.events);
      return;
    }
    await this.handleNotification("session/update", translated.params);
  }

  private async persistConfigOptions(
    nextConfigOptions: AgentConfigOption[]
  ): Promise<void> {
    if (nextConfigOptions.length === 0) {
      return;
    }
    let persistedConfigOptions = nextConfigOptions;
    await this.callbacks.updateConversation((current) => {
      persistedConfigOptions =
        this.backend.id === "cursor-acp"
          ? mergeCursorSeedConfigOptions(this.seedConfigOptions, nextConfigOptions, current.config)
          : nextConfigOptions;
      this.configOptions = persistedConfigOptions;
      const modeOption = findPrimaryModeConfigOption(persistedConfigOptions);
      const modelOption = findPrimaryModelConfigOption(persistedConfigOptions);
      const modelId = modelOption?.currentValue || current.config.modelId;
      const modelName =
        modelOption?.options.find((option) => option.value === modelId)?.name ??
        current.config.modelName;
      return {
        ...current,
        configOptions: persistedConfigOptions,
        config: {
          ...current.config,
          mode: normalizeProviderMode(modeOption?.currentValue, current.config.mode),
          modelId,
          modelName,
        },
      };
    });
    await writeAgentBackendConfigCache(this.backend.id, persistedConfigOptions);
  }

  private async runCursorModelSlashCommand(modelId: string): Promise<void> {
    if (this.suppressedAssistantChunks) {
      throw new Error("Cursor model switch already in progress.");
    }
    this.suppressedAssistantChunks = [];
    try {
      await this.bridge.request("session/prompt", {
        sessionId: this.sessionId,
        messageId: `cursor-model-${randomUUID()}`,
        prompt: [{ type: "text", text: `/model ${modelId}` }],
      });
      const responseText = this.suppressedAssistantChunks.join("").trim();
      if (responseText && /unknown model|invalid model|not found|failed/i.test(responseText)) {
        throw new Error(responseText);
      }
    } finally {
      this.suppressedAssistantChunks = null;
    }
  }

  private registerBridgeHandlers(): void {
    this.bridge.register(this.sessionId, {
      onNotification: (method, params) => {
        void this.handleNotification(method, params);
      },
      onRequest: (id, method, params) => {
        void this.handleRequest(id, method, params);
      },
      onStderr: (line) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `[${this.backend.label}] ${line}`,
          },
        ]);
      },
      onExit: (code) => {
        if (this.disposed) {
          return;
        }
        this.callbacks.markRuntimeStale?.();
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "interrupted",
            detail: `ACP process exited${code == null ? "" : ` with code ${code}`}.`,
            raw: {
              kind: "acp_process_exit",
              code,
            },
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `ACP transport exited${code == null ? "" : ` (code ${code})`}. Clearing stored provider session id to avoid retrying a stale ACP session handle.`,
            raw: { kind: "acp_stale_session_handle", exitCode: code },
          },
        ]);
        void this.callbacks.updateConversation((current) => ({
          ...current,
          providerSessionId: null,
          // Config options are tied to a live ACP session; a dead transport invalidates them.
          configOptions: [],
          lastError: null,
          status:
            current.status === "running" || current.status === "awaiting_permission"
              ? "interrupted"
              : current.status,
        }));
      },
    });
  }

  private async applyConversationConfig(
    conversation: AgentConversationRecord
  ): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(this.configOptions);
    const modelOption = findPrimaryModelConfigOption(this.configOptions);

    const nextModeValue = normalizeConversationModeForProvider(
      conversation.config.mode,
      modeOption
    );
    if (modeOption && nextModeValue && modeOption.currentValue !== nextModeValue) {
      await this.setConfigOption(modeOption.id, nextModeValue);
    }

    if (
      modelOption &&
      modelOption.options.some(
        (option) =>
          option.value === conversation.config.modelId ||
          option.name === conversation.config.modelName
      )
    ) {
      const modelValue =
        modelOption.options.find(
          (option) => option.value === conversation.config.modelId
        )?.value ??
        modelOption.options.find(
          (option) => option.name === conversation.config.modelName
        )?.value;
      if (modelValue && modelOption.currentValue !== modelValue) {
        await this.setConfigOption(modelOption.id, modelValue);
      }
    } else if (
      modelOption &&
      conversation.config.backendId === "cursor-acp" &&
      conversation.config.modelId &&
      modelOption.currentValue !== conversation.config.modelId
    ) {
      await this.setConfigOption(modelOption.id, conversation.config.modelId);
    }
  }

  private trimAcpDedupSet(s: Set<string>, cap: number) {
    if (s.size < cap) {
      return;
    }
    const chunk = 900;
    let removed = 0;
    for (const k of s) {
      s.delete(k);
      removed += 1;
      if (removed >= chunk) {
        break;
      }
    }
  }

  private shouldAppendNewAcpInitialTool(
    toolCallId: string,
    record: Record<string, unknown>,
    params: unknown
  ): boolean {
    const key = acpSessionInitialToolCallKey(toolCallId, record, params);
    if (this.acpInitialToolCallKeys.has(key)) {
      return false;
    }
    this.trimAcpDedupSet(this.acpInitialToolCallKeys, 5000);
    this.acpInitialToolCallKeys.add(key);
    return true;
  }

  private shouldAppendNewAcpToolUpdate(
    toolCallId: string,
    record: Record<string, unknown>,
    params: unknown,
    status: string
  ): boolean {
    const key = acpSessionToolUpdateKey(toolCallId, record, params, status);
    if (this.acpToolUpdateKeys.has(key)) {
      return false;
    }
    this.trimAcpDedupSet(this.acpToolUpdateKeys, 8000);
    this.acpToolUpdateKeys.add(key);
    return true;
  }

  private async handleNotification(
    method: string,
    params: unknown
  ): Promise<void> {
    if (method !== "session/update") {
      return;
    }
    const paramsRecord = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
    const update = paramsRecord?.update;
    if (!update || typeof update !== "object") {
      return;
    }
    const record = update as Record<string, unknown>;
    const sessionUpdate = normalizeAcpSessionUpdateKind(record);
    if (typeof sessionUpdate !== "string") {
      return;
    }
    const sseChildSessionId = readOpenCodeSseChildSessionId(params);
    const sseChildToolMeta =
      sseChildSessionId != null
        ? { openCodeSubagentSessionId: sseChildSessionId }
        : undefined;

    switch (sessionUpdate) {
 case "agent_message_chunk": {
 const text =
 record.content &&
 typeof record.content === "object" &&
 typeof (record.content as Record<string, unknown>).text === "string"
 ? ((record.content as Record<string, unknown>).text as string)
 : null;
 if (!text) {
 return;
 }
 if (this.suppressedAssistantChunks) {
 this.suppressedAssistantChunks.push(text);
 return;
 }
 if (!this.currentAssistantMessageId) {
 return;
 }
 if (this.capabilities.supportsInlineReasoning) {
 const { reasoning, text: cleaned } = extractInlineReasoning(text, {
 normalizeEdges: false,
 });
 if (reasoning.length > 0) {
 await this.callbacks.appendEvents(
 reasoning.map((block) => ({
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "reasoning" as const,
 messageId: this.currentAssistantMessageId!,
 text: block.text,
 raw: block.raw,
 }))
 );
 }
 if (cleaned) {
 await this.callbacks.appendEvents([
 {
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "assistant_message_chunk",
 messageId: this.currentAssistantMessageId,
 text: cleaned,
 raw: params,
 },
 ]);
 }
 return;
 }
 await this.callbacks.appendEvents([
 {
 eventId: randomUUID(),
 conversationId: this.callbacks.conversation.id,
 kind: "assistant_message_chunk",
 messageId: this.currentAssistantMessageId,
 text,
 raw: params,
 },
 ]);
 return;
 }
      case "tool_call": {
        const normalizedStatus = normalizeAcpToolCallStatus(record, "pending");
        const toolCallId = namespaceOpenCodeSseToolCallId(
          normalizeToolCallId(record),
          sseChildSessionId
        );
        let detail = summarizeAcpToolCallDetail(record);
        let locations = mergeScavengedAcpLocations(record);
        let title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record) ?? "Tool call";
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        const enriched = await this.enrichCursorToolCall({
          toolCallId,
          toolKind,
          title,
          detail,
          locations,
          record,
          status: normalizedStatus,
        });
        title = enriched.title ?? title;
        detail = enriched.detail ?? detail;
        locations = enriched.locations ?? locations;
        let enrichedToolKind = enriched.toolKind;
        const editPreview =
          extractAcpEditPreview(record, locations?.[0]?.path) ??
          extractToolEditPreview(params, params, locations?.[0]?.path);
        if (editPreview?.path && !locations?.some((entry) => entry.path === editPreview.path)) {
          locations = [{ path: editPreview.path }, ...(locations ?? [])];
        }
        if (
          enrichedToolKind === "read" &&
          (isGenericAcpToolTitle(title) || title === "Read file") &&
          locations?.[0]?.path
        ) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (record.subtype === "completed") {
          if (
            !this.shouldAppendNewAcpToolUpdate(
              toolCallId,
              record,
              params,
              String(normalizedStatus)
            )
          ) {
            return;
          }
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "tool_call_update",
              toolCallId,
              title,
              toolKind: enrichedToolKind,
              status: normalizedStatus,
              detail,
              locations,
              editPreview,
              raw: params,
              ...sseChildToolMeta,
            },
          ]);
          await appendOpenCodeTodoPlanIfNeeded(
            this.callbacks,
            params,
            record,
            enrichedToolKind,
            normalizedStatus,
            title
          );
          return;
        }
        if (!this.shouldAppendNewAcpInitialTool(toolCallId, record, params)) {
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call",
            toolCallId,
            title,
            toolKind: enrichedToolKind,
            status: normalizedStatus,
            detail,
            locations,
            editPreview,
            raw: params,
            ...sseChildToolMeta,
          },
        ]);
        return;
      }
      case "tool_call_update": {
        const updateToolCallId = namespaceOpenCodeSseToolCallId(
          normalizeToolCallId(record),
          sseChildSessionId
        );
        let locations = mergeScavengedAcpLocations(record);
        let title =
          typeof record.title === "string" &&
          record.title.trim() &&
          !isGenericAcpToolTitle(record.title)
            ? record.title
            : summarizeAcpToolCallTitle(record);
        const toolKind =
          typeof record.kind === "string" && record.kind !== "tool"
            ? record.kind
            : inferAcpToolKindFromEntry(extractAcpToolCallPayload(record));
        let detail = summarizeAcpToolCallDetail(record);
        const normalizedStatus = normalizeAcpToolCallStatus(record, "in_progress");
        const enriched = await this.enrichCursorToolCall({
          toolCallId: updateToolCallId,
          toolKind,
          title,
          detail,
          locations,
          record,
          status: normalizedStatus,
        });
        title = enriched.title ?? title;
        detail = enriched.detail ?? detail;
        locations = enriched.locations ?? locations;
        let enrichedToolKind = enriched.toolKind;
        const editPreview =
          extractAcpEditPreview(record, locations?.[0]?.path) ??
          extractToolEditPreview(params, params, locations?.[0]?.path);
        if (editPreview?.path && !locations?.some((entry) => entry.path === editPreview.path)) {
          locations = [{ path: editPreview.path }, ...(locations ?? [])];
        }
        if (
          enrichedToolKind === "read" &&
          title &&
          (isGenericAcpToolTitle(title) || title === "Read file") &&
          locations?.[0]?.path
        ) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (!title && enrichedToolKind === "read" && locations?.[0]?.path) {
          title = formatReadToolTitle(locations[0].path);
        }
        if (
          !this.shouldAppendNewAcpToolUpdate(
            updateToolCallId,
            record,
            params,
            String(normalizedStatus)
          )
        ) {
          return;
        }
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "tool_call_update",
            toolCallId: updateToolCallId,
            title,
            toolKind: enrichedToolKind,
            status: normalizedStatus,
            detail,
            locations,
            editPreview,
            raw: params,
            ...sseChildToolMeta,
          },
        ]);
        await appendOpenCodeTodoPlanIfNeeded(
          this.callbacks,
          params,
          record,
          enrichedToolKind,
          normalizedStatus,
          title
        );
        return;
      }
      case "plan": {
        const list = parseTodoLikeArrayFromPlanRecord(record);
        const entries = agentPlanEntriesFromTodoLikeList(
          list,
          this.callbacks.conversation.id,
          "plan"
        );
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "plan",
            planId: `${this.callbacks.conversation.id}-plan`,
            entries,
            raw: params,
          },
        ]);
        return;
      }
      case "config_option_update": {
        const nextConfigOptions = mergeSessionConfigOptions(
          parseConfigOptions(record.configOptions),
          parseLegacySessionConfigOptions(record)
        );
        if (nextConfigOptions.length > 0) {
          await this.persistConfigOptions(nextConfigOptions);
        }
        return;
      }
      case "current_mode_update": {
        const modeId = parseConfigOptionString(record.modeId);
        if (!modeId) {
          return;
        }
        const nextConfigOptions = this.configOptions.map((option) =>
          option.id === LEGACY_MODE_CONFIG_ID ? { ...option, currentValue: modeId } : option
        );
        await this.persistConfigOptions(nextConfigOptions);
        return;
      }
      default:
        return;
    }
  }

  private async handleRequest(
    requestId: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    if (method === "session/request_permission") {
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const requestKey = String(requestId);
      this.pendingPermissionRequestIds.set(requestKey, requestId);
      const toolCall =
        record.toolCall && typeof record.toolCall === "object"
          ? (record.toolCall as Record<string, unknown>)
          : record.tool_call && typeof record.tool_call === "object"
            ? (record.tool_call as Record<string, unknown>)
          : {};
      const toolCallId = normalizeToolCallId(toolCall);
      const summarizedToolTitle = summarizeAcpToolCallTitle(toolCall);
      const hasConcreteToolCallId = toolCallId !== "tool-call";
      let title = "Permission required";
      if (
        typeof toolCall.title === "string" &&
        !isGenericAcpToolTitle(toolCall.title)
      ) {
        title = toolCall.title;
      } else if (summarizedToolTitle) {
        title = `Permission required for ${summarizedToolTitle}`;
      } else if (hasConcreteToolCallId) {
        title = `Permission required for ${toolCallId}`;
      }
      let detail = extractPermissionRequestDetail(record, toolCall);
      const options = parsePermissionOptions(
        Array.isArray(record.options)
          ? record.options
          : Array.isArray(record.choices)
            ? record.choices
            : Array.isArray(record.actions)
              ? record.actions
              : Array.isArray(record.permissions)
                ? record.permissions
                : []
      );
      const normalizedOptions = withPersistentPermissionOptions(
        options.length > 0 ? options : buildFallbackPermissionOptions(this.backend.id)
      );
      const permissionSignature = buildPermissionToolSignature({
        record,
        toolCall,
        title,
        detail,
      });
      const settings = await getGlobalSettings().catch(() => undefined);
      const remembered = settings?.agents.rememberedPermissions.find(
        (rule) =>
          rule.workspaceId === this.callbacks.workspace.id &&
          rule.backendId === this.backend.id &&
          rule.toolKey === permissionSignature.toolKey
      );
      if (remembered) {
        const providerOptionId = providerOptionIdForRememberedPermission(
          normalizedOptions,
          remembered.decision
        );
        this.bridge.respond(requestId, {
          outcome: providerOptionId
            ? {
                outcome: "selected",
                optionId: providerOptionId,
              }
            : { outcome: "cancelled" },
        });
        this.pendingPermissionRequestIds.delete(requestKey);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "permission_resolved",
            requestId: requestKey,
            outcome: providerOptionId ? "selected" : "cancelled",
            optionId: remembered.optionId,
            raw: {
              rememberedPermission: {
                id: remembered.id,
                decision: remembered.decision,
                toolLabel: remembered.toolLabel,
              },
            },
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail: `Used remembered permission for ${remembered.toolLabel}.`,
          },
        ]);
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "running",
          pendingPermission: null,
        }));
        return;
      }
      if (settings?.agents.autoAcceptAllAgentPermissions) {
        const providerOptionId = providerOptionIdForRememberedPermission(
          normalizedOptions,
          "allow"
        );
        if (providerOptionId) {
          this.bridge.respond(requestId, {
            outcome: { outcome: "selected", optionId: providerOptionId },
          });
          this.pendingPermissionRequestIds.delete(requestKey);
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "permission_resolved",
              requestId: requestKey,
              outcome: "selected",
              optionId: providerOptionId,
              raw: { autoAcceptedAll: true },
            },
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "status",
              status: "running",
              detail: "Auto-accepted (Agents → auto-approve all).",
            },
          ]);
          await this.callbacks.updateConversation((current) => ({
            ...current,
            status: "running",
            pendingPermission: null,
          }));
          return;
        }
      }
      this.pendingPermissionContextById.set(requestKey, {
        options: normalizedOptions,
        toolKey: permissionSignature.toolKey,
        toolLabel: permissionSignature.toolLabel,
      });
      const statusDetail = detail ? `${title} — ${detail}` : title;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_request",
          requestId: requestKey,
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
          raw: params,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "awaiting_permission",
          detail: statusDetail,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId: requestKey,
          requestedAt: Date.now(),
          title,
          detail,
          toolCallId: hasConcreteToolCallId ? toolCallId : undefined,
          options: normalizedOptions,
        },
      }));
      return;
    }

    const paramsRecord =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    if (method === "cursor/update_todos") {
      const todos =
        tryParseJsonArrayString(paramsRecord.todos) ??
        tryParseJsonArrayString(paramsRecord.items) ??
        [];
      const entries = agentPlanEntriesFromTodoLikeList(
        todos,
        this.callbacks.conversation.id,
        "todo"
      );
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "plan",
          planId: `${this.callbacks.conversation.id}-todos`,
          entries,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/task" || method === "cursor/generate_image") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "info",
          text: `${method} extension event received.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    if (method === "cursor/create_plan" || method === "cursor/ask_question") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `${method} is not fully interactive yet; applying fallback response.`,
          raw: params,
        },
      ]);
      this.bridge.respond(requestId, {});
      return;
    }

    this.bridge.respond(requestId, {});
  }
}

export async function createAgentProvider(
  backendId: AgentBackendId
): Promise<AgentProvider> {
  const backend = AGENT_BACKENDS[backendId];
  if (!backend) {
    throw new Error(`Unknown backend: ${backendId}`);
  }

  if (backendId === "cursor-acp") {
    if (!CURSOR_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    const cursorSeedConfigOptions = await readAgentBackendConfigCache(backendId);
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: CURSOR_RUNTIME.command,
          args: CURSOR_RUNTIME.args,
          env: CURSOR_RUNTIME.env,
          callbacks,
          seedConfigOptions: cursorSeedConfigOptions,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: CURSOR_RUNTIME.command,
          args: CURSOR_RUNTIME.args,
          env: CURSOR_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
          seedConfigOptions: cursorSeedConfigOptions,
        });
      },
    };
  }

  if (backendId === "opencode-acp") {
    if (!OPENCODE_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: OPENCODE_RUNTIME.command,
          args: OPENCODE_RUNTIME.args,
          env: OPENCODE_RUNTIME.env,
          callbacks,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: OPENCODE_RUNTIME.command,
          args: OPENCODE_RUNTIME.args,
          env: OPENCODE_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
        });
      },
    };
  }

  if (backendId === "gemini-acp") {
    if (!GEMINI_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return {
      backend,
      startSession(callbacks) {
        return AcpSessionHandle.create({
          backend,
          command: GEMINI_RUNTIME.command,
          args: GEMINI_RUNTIME.args,
          env: GEMINI_RUNTIME.env,
          callbacks,
        });
      },
      loadSession(callbacks, providerSessionId) {
        return AcpSessionHandle.create({
          backend,
          command: GEMINI_RUNTIME.command,
          args: GEMINI_RUNTIME.args,
          env: GEMINI_RUNTIME.env,
          callbacks,
          loadSessionId: providerSessionId,
        });
      },
    };
  }

  if (backendId === "codex-adapter") {
    if (!CODEX_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return createCodexAdapterProvider({
      backend,
      runtime: CODEX_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
      capabilities: basicCliCapabilities,
    });
  }

  if (backendId === "claude-adapter") {
    if (!CLAUDE_RUNTIME) {
      throw new Error(`${backend.label} is not installed or could not be resolved.`);
    }
    return createClaudeAdapterProvider({
      backend,
      runtime: CLAUDE_RUNTIME,
      configOptions: await readAgentBackendConfigCache(backendId),
      capabilities: basicCliCapabilities,
    });
  }

  throw new Error(`${backend.label} is not implemented yet.`);
}
