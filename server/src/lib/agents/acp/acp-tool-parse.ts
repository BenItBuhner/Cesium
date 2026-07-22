import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeOpenCodeToolKey } from "../opencode-global-sse.js";
import { extractToolEditPreview } from "../tool-edit-preview.js";
import { formatRejectedToolDetail } from "../tool-rejection-utils.js";
import {
  formatDeleteToolTitle,
  formatFindToolTitle,
  formatGrepToolTitle,
  formatReadToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  formatWebSearchTitle,
  truncateGenericToolTitle,
} from "../tool-display-labels.js";
import type {
  AgentPermissionOption,
  AgentToolCallStatus,
} from "../types.js";

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

export function isGenericAcpToolTitle(value: string | undefined): boolean {
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

export type AcpToolCallEntry = {
  rawName: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export function parseLooseJsonObjectForAcp(value: unknown): Record<string, unknown> | undefined {
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

export function extractAcpToolCallPayload(record: Record<string, unknown>): {
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

export function inferAcpToolKindFromEntry(payload: {
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

export function summarizeAcpToolCallTitle(record: Record<string, unknown>): string | undefined {
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

export function summarizeAcpToolCallDetail(record: Record<string, unknown>): string | undefined {
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

export function normalizeAcpToolCallStatus(
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

export function parsePermissionOptions(raw: unknown): AgentPermissionOption[] {
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

export {
  buildFallbackPermissionOptions,
  permissionDecisionFromKind,
  providerOptionIdForPermissionSelection,
  providerOptionIdForRememberedPermission,
  withPersistentPermissionOptions,
} from "../permission-options.js";

export function normalizeToolCallId(record: Record<string, unknown>): string {
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

export function extractAcpEditPreview(
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

export function mergeScavengedAcpLocations(
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

export function normalizeAcpSessionUpdateKind(record: Record<string, unknown>): string | undefined {
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

export function readOpenCodeSseChildSessionId(params: unknown): string | undefined {
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
export function namespaceOpenCodeSseToolCallId(baseId: string, childSessionId?: string): string {
  if (!childSessionId || !baseId) {
    return baseId;
  }
  if (baseId.startsWith("opencode-sa:")) {
    return baseId;
  }
  return `opencode-sa:${childSessionId}:${baseId}`;
}

export function extractPermissionRequestDetail(
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

export function buildPermissionToolSignature(input: {
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
