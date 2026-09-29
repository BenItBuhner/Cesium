import type { CesiumToolDefinition } from "./agent-harness";
import { asRecord, parseJsonArgs, pickFirstString } from "./cesium-coerce";

/** Server id of the built-in browser MCP server (`call_mcp_tool` routing). */
export const CESIUM_BROWSER_MCP_SERVER_ID = "browser";

const CALL_MCP_SERVER_ID_KEYS = [
  "serverId",
  "server_id",
  "server",
  "mcpServerId",
  "mcp_server_id",
] as const;

const CALL_MCP_TOOL_NAME_KEYS = [
  "toolName",
  "tool_name",
  "tool",
  "mcpTool",
  "mcp_tool",
] as const;

function omitCallMcpRoutingFields(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const key of [
    ...CALL_MCP_SERVER_ID_KEYS,
    ...CALL_MCP_TOOL_NAME_KEYS,
    "arguments",
  ]) {
    delete next[key];
  }
  return next;
}

export type NormalizedCallMcpToolArgs = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/** Accept common LLM/provider shapes for call_mcp_tool routing and MCP tool args. */
export function normalizeCallMcpToolArgs(raw: Record<string, unknown>): NormalizedCallMcpToolArgs {
  const nested = asRecord(raw.arguments);
  const rawServerId =
    pickFirstString(raw, CALL_MCP_SERVER_ID_KEYS) ??
    pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS) ??
    "";
  const serverId =
    rawServerId.toLowerCase() === CESIUM_BROWSER_MCP_SERVER_ID ? CESIUM_BROWSER_MCP_SERVER_ID : rawServerId;
  const toolName =
    pickFirstString(raw, CALL_MCP_TOOL_NAME_KEYS) ??
    pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS) ??
    "";

  let toolArgs: Record<string, unknown> = {};
  if (nested) {
    const nestedServerId = pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS);
    const nestedToolName = pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS);
    if (nestedServerId || nestedToolName) {
      toolArgs = omitCallMcpRoutingFields(nested);
    } else if (Object.keys(nested).length > 0) {
      toolArgs = nested;
    }
  }
  if (Object.keys(toolArgs).length === 0) {
    toolArgs = omitCallMcpRoutingFields(raw);
  }

  return { serverId, toolName, arguments: toolArgs };
}

function callMcpToolArgsToRecord(normalized: NormalizedCallMcpToolArgs): Record<string, unknown> {
  return {
    serverId: normalized.serverId,
    toolName: normalized.toolName,
    arguments: normalized.arguments,
  };
}

export function normalizeCesiumToolRequestArguments(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (name !== "call_mcp_tool") {
    return args;
  }
  return callMcpToolArgsToRecord(normalizeCallMcpToolArgs(args));
}

export function inferCesiumToolNameFromTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^refresh mcp servers$/i.test(trimmed)) {
    return "refresh_mcp_servers";
  }
  if (/^(MCP|Browser)\s+/i.test(trimmed)) {
    return "call_mcp_tool";
  }
  return undefined;
}

export function serializeToolCallArguments(
  name: string,
  args: unknown,
  detail?: string | null
): string {
  const parsed =
    typeof args === "string"
      ? parseJsonArgs(args)
      : asRecord(args) ?? {};
  const normalizedArgs =
    name === "call_mcp_tool"
      ? callMcpToolArgsToRecord(normalizeCallMcpToolArgs(parsed))
      : parsed;
  if (Object.keys(normalizedArgs).length > 0) {
    return JSON.stringify(normalizedArgs);
  }
  if (name === "call_mcp_tool" && detail?.trim()) {
    const fromDetail = normalizeCallMcpToolArgs(parseJsonArgs(detail));
    if (fromDetail.serverId && fromDetail.toolName) {
      return JSON.stringify(callMcpToolArgsToRecord(fromDetail));
    }
  }
  if (detail?.trim()) {
    const fromDetail = asRecord(parseJsonArgs(detail)) ?? {};
    if (Object.keys(fromDetail).length > 0) {
      return JSON.stringify(fromDetail);
    }
  }
  return "{}";
}

export const CESIUM_GREP_DEFAULT_RESULTS = 100;
export const CESIUM_GREP_MAX_RESULTS = 5000;

export type CesiumSharedToolName =
  | "read_file"
  | "grep"
  | "write_file"
  | "edit_file"
  | "terminal"
  | "wait"
  | "todo"
  | "ask_question"
  | "switch_branch";

/**
 * Canonical schemas for the tools both harness engines expose, as the server
 * advertises them. Their JSON is part of the cached prompt prefix, so any edit
 * here changes every server conversation's tool block. The browser machine
 * uses an entry as is only where it describes the browser's behaviour.
 */
export const CESIUM_SHARED_TOOL_DEFINITIONS: Record<CesiumSharedToolName, CesiumToolDefinition> = {
  read_file: {
    name: "read_file",
    description: "Read all or part of a workspace file. Use offset and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  grep: {
    name: "grep",
    description:
      "Search file contents with ripgrep. Returns path:line headers followed by numbered lines, in path order. Skips .gitignore'd files, binary files, .git, node_modules, .next, and .docker. Case-sensitive unless ignoreCase is true. Read-only; use glob to find files by name.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regular expression in ripgrep (Rust regex) syntax, e.g. \"fn\\s+\\w+\" or \"TODO|FIXME\"; lookaround and backreferences also work. Escape literal ( ) [ ] { } . * + ? | ^ $ \\. Hosts without ripgrep evaluate it as a JavaScript RegExp.",
        },
        path: {
          type: "string",
          description: "File or directory to search, relative to the workspace root. Defaults to the root.",
        },
        glob: {
          type: "string",
          description:
            "Only search files matching this glob, e.g. \"*.ts\" (file names at any depth) or \"src/**/*.tsx\" (relative to path). Prefix with ! to exclude.",
        },
        ignoreCase: { type: "boolean", description: "Match case-insensitively. Defaults to false." },
        context: { type: "number", description: "Lines of context around each match (0-20, default 0)." },
        maxResults: {
          type: "number",
          description: `Maximum matches to return (default ${CESIUM_GREP_DEFAULT_RESULTS}, max ${CESIUM_GREP_MAX_RESULTS}).`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  write_file: {
    name: "write_file",
    description:
      "Create a new workspace file or overwrite an existing one with the full content. Parent directories are created automatically. Prefer edit_file for targeted changes inside existing files.",
    requiresPermission: "editFile",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  edit_file: {
    name: "edit_file",
    description:
      "Replace one exact string in an existing file (set replaceAll to true to replace every occurrence). Use write_file to create new files or fully rewrite one. Returns a precise, actionable error if the match is missing or ambiguous.",
    requiresPermission: "editFile",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: {
          type: "boolean",
          description: "Replace every occurrence of oldString instead of requiring a unique match.",
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
  terminal: {
    name: "terminal",
    description:
      "Run a shell command in the workspace root. waitUntil: complete (default) waits for exit, pattern returns once the output contains pattern, background returns immediately. Long output keeps its head and tail. A command still running when the call returns (background, pattern, or past timeoutMs) keeps running under the returned id: poll it with terminal_read and stop it with terminal_kill. Use background plus terminal_read for dev servers, watchers, and builds longer than two minutes.",
    requiresPermission: "terminal",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        waitUntil: { type: "string", enum: ["complete", "background", "pattern"] },
        pattern: { type: "string" },
        timeoutMs: {
          type: "number",
          description: "How long to wait before returning while the command keeps running (default 30000, max 120000).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  wait: {
    name: "wait",
    description:
      "Pause this agent for a fixed number of seconds before continuing. Use for timed delays (seconds, minutes, or hours) when you do not need to poll terminals, spawn subagents, or wait on orchestration board conditions. Prefer this over shell sleep. Cancel stops the wait early.",
    parameters: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          description:
            "How long to wait. Fractional values are allowed (e.g. 0.5). Large values are fine for multi-minute or multi-hour delays (capped at 24 hours).",
        },
        reason: {
          type: "string",
          description: "Optional short reason shown in status heartbeats while waiting.",
        },
      },
      required: ["seconds"],
      additionalProperties: false,
    },
  },
  todo: {
    name: "todo",
    description: "Replace or patch the current todo list.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "replace", "patch"] },
        items: {
          type: "array",
          description:
            "Todo items. Each item may use content, title, text, or description plus status pending/in_progress/blocked/completed. Use blocked only when progress cannot continue without removing a material blocker.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  ask_question: {
    name: "ask_question",
    description:
      'Ask the user a question. Pass prompt (the question text) plus optional options (array of strings or {id,label}); omit options for an open-ended question - the user always gets a free-text answer field. Multi-step: questions: [{prompt, options}]. Example: {"prompt":"Which approach?","options":["Refactor now","Ship as-is"]}.',
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question to show the user." },
        question: { type: "string", description: "Alias of prompt." },
        options: {
          type: "array",
          description: "Selectable answers: strings or {id,label}. Optional.",
        },
        choices: { type: "array", description: "Alias of options." },
        allowMultiple: { type: "boolean" },
        allow_multiple: { type: "boolean" },
        questions: {
          type: "array",
          description: "Multiple question steps, each {prompt, options?}.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              question: { type: "string" },
              title: { type: "string" },
              options: { type: "array" },
              choices: { type: "array" },
              allowMultiple: { type: "boolean" },
              allow_multiple: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  switch_branch: {
    name: "switch_branch",
    description:
      "Switch this workspace's checked-out git branch (set create=true to branch off the current HEAD). Refuses when the tree is dirty; use create_worktree instead for parallel work. The next reminder reflects the new location - re-verify paths after switching.",
    parameters: {
      type: "object",
      properties: {
        branch: { type: "string" },
        create: { type: "boolean", description: "Create the branch if it does not exist." },
      },
      required: ["branch"],
      additionalProperties: false,
    },
  },
};
