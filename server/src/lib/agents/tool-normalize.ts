import type { AgentToolLocation } from "./types.js";
import {
  asRecord as asToolRecord,
  compactJson as compactToolJson,
  firstString as firstToolString,
} from "./json-coerce.js";
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

export type NormalizedToolPayload = {
  name: string;
  input?: unknown;
  result?: unknown;
};

export const TOOL_PATH_KEYS = [
  "path",
  "file",
  "file_path",
  "filepath",
  "filePath",
  "targetFile",
  "target_file",
  "absolutePath",
  "relativePath",
] as const;

export { asToolRecord, compactToolJson, firstToolString };

export function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function normalizeToolNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

function shellSearchPattern(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const match =
    command.match(/\b(?:rg|grep)\b\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s|&;]+))/i) ??
    command.match(/\b(?:rg|grep)\b.*?(?:"([^"]+)"|'([^']+)')/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function inferCanonicalToolKind(payload: NormalizedToolPayload): string {
  const lowered = payload.name.toLowerCase();
  const key = normalizeToolNameKey(payload.name);
  const input = asToolRecord(payload.input);
  const command = firstToolString(input, ["command", "cmd", "script"]);
  const haystack = `${lowered} ${compactToolJson(payload.input, 240) ?? ""} ${
    compactToolJson(payload.result, 240) ?? ""
  }`.toLowerCase();

  if (key.includes("todo")) return "todo";
  if (key === "task" || key.includes("subagent") || key.includes("agent")) return "task";
  if (key.includes("question") || key.includes("askuser")) return "question";
  if (key.includes("mcp") || /^mcp__/.test(lowered)) return "mcp";
  if (key.includes("webfetch") || key.includes("fetchurl")) return "fetch";
  if (key.includes("grep")) return "grep";
  if (key.includes("semsearch") || key.includes("semantic")) return "search";
  // "web" must outrank the generic "search" check or WebSearch/search_web
  // tools get misclassified as workspace search.
  if (key.includes("web")) return "search_web";
  if (key.includes("glob") || key.includes("search") || key.includes("find")) return "search";
  if (command && /\b(?:rg|grep)\b/i.test(command)) return "grep";
  if (key.includes("bash") || key.includes("shell") || key.includes("terminal")) return "terminal";
  if (/\b(delete|remove|rm)\b/.test(haystack)) return "delete";
  if (/\b(write|edit|multiedit|patch|replace|update|create)\b/.test(haystack)) return "edit";
  if (/\b(read|open|view|cat)\b/.test(haystack)) return "read";
  return "tool";
}

export function locationsForToolPayload(payload: {
  input?: unknown;
  result?: unknown;
}): AgentToolLocation[] | undefined {
  const result = asToolRecord(payload.result);
  const nestedValue = asToolRecord(result?.value);
  const records = [asToolRecord(payload.input), result, nestedValue].filter(
    (value): value is Record<string, unknown> => value != null
  );
  const paths = new Set<string>();
  for (const record of records) {
    const path = firstToolString(record, TOOL_PATH_KEYS);
    if (path) {
      paths.add(path);
    }
    for (const key of ["files", "paths", "matchedFiles", "results"]) {
      const value = record[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          paths.add(item.trim());
        } else {
          const itemPath = firstToolString(asToolRecord(item), TOOL_PATH_KEYS);
          if (itemPath) {
            paths.add(itemPath);
          }
        }
      }
    }
  }
  const locations = [...paths].slice(0, 24).map((path) => ({ path }));
  return locations.length > 0 ? locations : undefined;
}

export function detailForToolPayload(payload: {
  input?: unknown;
  result?: unknown;
}): string | undefined {
  const result = asToolRecord(payload.result);
  const value = asToolRecord(result?.value);
  const input = asToolRecord(payload.input);
  const totalFiles =
    typeof value?.totalFiles === "number"
      ? value.totalFiles
      : typeof result?.totalFiles === "number"
        ? result.totalFiles
        : undefined;
  if (totalFiles != null) {
    return `${totalFiles} files matched`;
  }
  const totalLines =
    typeof value?.totalLines === "number"
      ? value.totalLines
      : typeof result?.totalLines === "number"
        ? result.totalLines
        : undefined;
  if (totalLines != null) {
    return `${totalLines} lines`;
  }
  return (
    firstToolString(result, ["message", "summary", "error", "stderr", "stdout", "output", "content", "text"]) ??
    firstToolString(value, ["message", "summary", "error", "stderr", "stdout", "output", "content", "text"]) ??
    firstToolString(input, ["description", "prompt", "query", "command"]) ??
    compactToolJson(payload.result ?? payload.input)
  );
}

export function titleForCanonicalTool(input: {
  name: string;
  kind: string;
  payload: { input?: unknown; result?: unknown };
}): string {
  const args = asToolRecord(input.payload.input);
  const result = asToolRecord(input.payload.result);
  const path = firstToolString(args, TOOL_PATH_KEYS) ?? firstToolString(result, TOOL_PATH_KEYS);
  const query =
    firstToolString(args, ["query", "pattern", "regex", "glob", "search", "term", "globPattern"]) ??
    firstToolString(result, ["query", "pattern", "regex", "glob", "search", "term", "globPattern"]) ??
    shellSearchPattern(firstToolString(args, ["command", "cmd", "script"]));
  const command = firstToolString(args, ["command", "cmd", "script"]);
  switch (input.kind) {
    case "read":
      return formatReadToolTitle(path);
    case "edit":
      return formatUpdateToolTitle(path, "Update file");
    case "delete":
      return formatDeleteToolTitle(path, "Delete file");
    case "grep":
      return formatGrepToolTitle(query);
    case "search":
      return formatFindToolTitle(query);
    case "fetch":
      return firstToolString(args, ["url", "uri", "href"]) ? "Fetch URL" : "Fetch";
    case "search_web":
      return formatWebSearchTitle(query);
    case "terminal":
      return command ? formatTerminalCommandTitle(command) : "Run command";
    case "todo":
      return "Update todos";
    case "task":
      return "Task";
    case "question":
      return "Ask question";
    case "mcp":
      return truncateGenericToolTitle(input.name, "MCP tool");
    default:
      return humanizeToolName(input.name) || "Tool";
  }
}
