/**
 * Browser tool executor for the Cesium harness: files, grep, edits (with
 * edit previews), the shell-backed terminal tool, todo, and git branch
 * switching. Mirrors the server tools' observable behavior.
 */
import type {
  AgentPlanEntry,
  AgentToolEditPreview,
  AgentToolEditPreviewLine,
  WorkspaceRecord,
} from "@cesium/core";
import { basename, resolveSafePath, toRelativePath } from "../paths";
import type { Vfs } from "../vfs";
import type { BrowserGit } from "../git/browser-git";
import type { ShellRuntime } from "../shell/runtime";
import { isDimmed } from "../lang";

export type ToolExecution = {
  /** Text result fed back to the model. */
  result: string;
  /** Optional UI detail override (defaults to result). */
  detail?: string;
  editPreview?: AgentToolEditPreview;
  locations?: Array<{ path: string; line?: number }>;
  isError?: boolean;
};

const MAX_READ_LINES = 1200;
const MAX_GREP_RESULTS = 100;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildEditPreview(
  path: string,
  oldText: string,
  newText: string
): AgentToolEditPreview {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: AgentToolEditPreviewLine[] = [];
  let added = 0;
  let removed = 0;
  // Simple prefix/suffix diff: find common head/tail, mark the middle.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const contextBefore = Math.max(0, head - 2);
  for (let i = contextBefore; i < head; i += 1) {
    lines.push({ kind: "context", text: oldLines[i] ?? "", oldLineNumber: i + 1, newLineNumber: i + 1 });
  }
  for (let i = head; i < oldLines.length - tail; i += 1) {
    lines.push({ kind: "remove", text: oldLines[i] ?? "", oldLineNumber: i + 1 });
    removed += 1;
  }
  for (let i = head; i < newLines.length - tail; i += 1) {
    lines.push({ kind: "add", text: newLines[i] ?? "", newLineNumber: i + 1 });
    added += 1;
  }
  const afterStart = oldLines.length - tail;
  for (let i = afterStart; i < Math.min(afterStart + 2, oldLines.length); i += 1) {
    lines.push({
      kind: "context",
      text: oldLines[i] ?? "",
      oldLineNumber: i + 1,
      newLineNumber: i + (newLines.length - oldLines.length) + 1,
    });
  }
  return {
    path,
    source: "before_after",
    addedLines: added,
    removedLines: removed,
    truncated: lines.length > 400,
    lines: lines.slice(0, 400),
  };
}

export class BrowserToolExecutor {
  private readonly todoLists = new Map<string, AgentPlanEntry[]>();

  constructor(
    private readonly vfs: Vfs,
    private readonly git: BrowserGit,
    private readonly shell: ShellRuntime
  ) {}

  getTodoList(conversationId: string): AgentPlanEntry[] {
    return this.todoLists.get(conversationId) ?? [];
  }

  async execute(input: {
    conversationId: string;
    workspace: WorkspaceRecord;
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ToolExecution> {
    const { workspace, args, conversationId } = input;
    switch (input.name) {
      case "read_file":
        return this.readFile(workspace, args);
      case "grep":
        return this.grep(workspace, args);
      case "write_file":
        return this.writeFile(workspace, args);
      case "edit_file":
        return this.editFile(workspace, args);
      case "terminal":
        return this.terminal(workspace, args, input.signal);
      case "todo":
        return this.todo(conversationId, args);
      case "wait": {
        const seconds = Math.min(Math.max(asNumber(args.seconds) ?? 1, 0), 300);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return { result: `Waited ${seconds} seconds.` };
      }
      case "switch_branch": {
        const branch = asString(args.branch ?? args.target ?? args.name);
        if (!branch) return { result: "switch_branch requires a branch name.", isError: true };
        await this.git.checkout(workspace.root, branch).catch(async (error) => {
          // Try creating the branch if checkout failed because it is new.
          const branches = await this.git.listBranches(workspace.root);
          if (!branches.includes(branch)) {
            await this.git.createBranch(workspace.root, branch, true);
            return;
          }
          throw error;
        });
        return { result: `Switched to branch ${branch}.` };
      }
      default:
        return {
          result: `Tool ${input.name} is not available on the browser machine.`,
          isError: true,
        };
    }
  }

  private readFile(workspace: WorkspaceRecord, args: Record<string, unknown>): ToolExecution {
    const path = asString(args.path);
    if (!path) return { result: "read_file requires a path.", isError: true };
    const absolute = resolveSafePath(workspace.root, path);
    let text: string;
    try {
      text = this.vfs.readTextFile(absolute);
    } catch {
      return { result: `File not found: ${path}`, isError: true };
    }
    const lines = text.split("\n");
    const offset = Math.max(1, asNumber(args.offset) ?? 1);
    const limit = Math.min(asNumber(args.limit) ?? MAX_READ_LINES, MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((line, index) => `${String(offset + index).padStart(6)}|${line}`)
      .join("\n");
    const remaining = lines.length - (offset - 1 + slice.length);
    return {
      result:
        numbered +
        (remaining > 0
          ? `\n… ${remaining} more lines. Use offset=${offset + slice.length} to continue.`
          : ""),
      detail: path,
      locations: [{ path, line: offset }],
    };
  }

  private grep(workspace: WorkspaceRecord, args: Record<string, unknown>): ToolExecution {
    const pattern = asString(args.pattern);
    if (!pattern) return { result: "grep requires a pattern.", isError: true };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      return {
        result: `Invalid pattern: ${error instanceof Error ? error.message : error}`,
        isError: true,
      };
    }
    const scope = asString(args.path);
    const root = scope ? resolveSafePath(workspace.root, scope) : workspace.root;
    const context = Math.min(asNumber(args.context) ?? 0, 5);
    const maxResults = Math.min(asNumber(args.maxResults) ?? MAX_GREP_RESULTS, 300);
    const results: string[] = [];
    let total = 0;

    const walk = (dir: string): void => {
      if (total >= maxResults) return;
      const record = this.vfs.getRecord(dir);
      if (!record) return;
      if (record.type === "file") {
        scanFile(dir);
        return;
      }
      for (const child of this.vfs.listChildren(dir)) {
        if (total >= maxResults) return;
        if (child.type === "dir") {
          if (isDimmed(basename(child.path))) continue;
          walk(child.path);
        } else if (child.type === "file") {
          scanFile(child.path);
        }
      }
    };
    const scanFile = (path: string): void => {
      const record = this.vfs.getRecord(path);
      if (!record || record.type !== "file") return;
      const bytes = record.data ?? new Uint8Array(0);
      if (bytes.byteLength > 2_000_000) return;
      if (bytes.subarray(0, 512).includes(0)) return;
      const lines = new TextDecoder().decode(bytes).split("\n");
      const relative = toRelativePath(workspace.root, path);
      for (let i = 0; i < lines.length && total < maxResults; i += 1) {
        if (regex.test(lines[i] ?? "")) {
          total += 1;
          if (context > 0) {
            for (let c = Math.max(0, i - context); c < Math.min(lines.length, i + context + 1); c += 1) {
              results.push(`${relative}:${c + 1}${c === i ? ":" : "-"}${lines[c]}`);
            }
            results.push("--");
          } else {
            results.push(`${relative}:${i + 1}:${lines[i]}`);
          }
        }
      }
    };
    walk(root);
    if (results.length === 0) {
      return { result: `No matches for /${pattern}/ in ${scope || "workspace"}.` };
    }
    return {
      result:
        results.join("\n") + (total >= maxResults ? `\n… capped at ${maxResults} matches.` : ""),
      detail: `${total} match${total === 1 ? "" : "es"}`,
    };
  }

  private writeFile(workspace: WorkspaceRecord, args: Record<string, unknown>): ToolExecution {
    const path = asString(args.path);
    const content = asString(args.content);
    if (!path) return { result: "write_file requires a path.", isError: true };
    const absolute = resolveSafePath(workspace.root, path);
    const existing = this.vfs.exists(absolute) ? this.vfs.readTextFile(absolute) : "";
    const parent = absolute.slice(0, absolute.lastIndexOf("/")) || "/";
    if (!this.vfs.exists(parent)) this.vfs.mkdir(parent, { recursive: true });
    this.vfs.writeFile(absolute, content);
    return {
      result: `Wrote ${content.length} chars to ${path}.`,
      detail: path,
      editPreview: buildEditPreview(path, existing, content),
      locations: [{ path }],
    };
  }

  private editFile(workspace: WorkspaceRecord, args: Record<string, unknown>): ToolExecution {
    const path = asString(args.path);
    const oldString = asString(args.oldString ?? args.old_string);
    const newString = asString(args.newString ?? args.new_string);
    if (!path || !oldString) {
      return { result: "edit_file requires path and oldString.", isError: true };
    }
    const absolute = resolveSafePath(workspace.root, path);
    let text: string;
    try {
      text = this.vfs.readTextFile(absolute);
    } catch {
      return { result: `File not found: ${path}`, isError: true };
    }
    const first = text.indexOf(oldString);
    if (first === -1) {
      return {
        result: `oldString not found in ${path}. Read the file again - the content may have changed.`,
        isError: true,
      };
    }
    if (text.indexOf(oldString, first + 1) !== -1) {
      return {
        result: `oldString matches multiple locations in ${path}; provide more surrounding context.`,
        isError: true,
      };
    }
    const next = text.slice(0, first) + newString + text.slice(first + oldString.length);
    this.vfs.writeFile(absolute, next);
    const line = text.slice(0, first).split("\n").length;
    return {
      result: `Edited ${path}.`,
      detail: path,
      editPreview: buildEditPreview(path, text, next),
      locations: [{ path, line }],
    };
  }

  private async terminal(
    workspace: WorkspaceRecord,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecution> {
    const command = asString(args.command);
    if (!command) return { result: "terminal requires a command.", isError: true };
    const result = await this.shell.exec(command, {
      cwd: workspace.root,
      signal,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      result:
        `Exit code: ${result.exitCode}\n\n${output || "(no output)"}`.slice(0, 60_000),
      detail: command,
      isError: result.exitCode !== 0,
    };
  }

  private todo(conversationId: string, args: Record<string, unknown>): ToolExecution {
    const action = asString(args.action) || "list";
    const current = this.todoLists.get(conversationId) ?? [];
    if (action === "list") {
      return {
        result:
          current.length === 0
            ? "Todo list is empty."
            : current.map((item) => `[${item.status}] ${item.id}: ${item.content}`).join("\n"),
      };
    }
    const items = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
    const normalized: AgentPlanEntry[] = items.map((item, index) => ({
      id: asString(item.id) || `todo-${index + 1}`,
      content: asString(item.content ?? item.title ?? item.text),
      status: (["pending", "in_progress", "blocked", "completed"].includes(asString(item.status))
        ? asString(item.status)
        : "pending") as AgentPlanEntry["status"],
    }));
    let next: AgentPlanEntry[];
    if (action === "replace") {
      next = normalized;
    } else {
      next = [...current];
      for (const item of normalized) {
        const index = next.findIndex((existing) => existing.id === item.id);
        if (index >= 0) {
          next[index] = { ...next[index], ...item };
        } else {
          next.push(item);
        }
      }
    }
    this.todoLists.set(conversationId, next);
    return {
      result: `Todo list updated (${next.length} item${next.length === 1 ? "" : "s"}).`,
      detail: `${next.filter((item) => item.status === "completed").length}/${next.length} completed`,
    };
  }
}
