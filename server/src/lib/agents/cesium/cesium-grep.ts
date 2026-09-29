import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GLOB_SKIPPED_DIRECTORIES, globToRegExp } from "./cesium-glob.js";
import { resolveRipgrepBinary } from "./cesium-ripgrep.js";

/** Files larger than this are skipped by both search paths. */
export const GREP_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Rendered lines are clipped so one minified line cannot flood the result. */
export const GREP_MAX_LINE_CHARS = 500;

export type GrepInput = {
  workspaceRoot: string;
  /** Absolute file or directory to search, already validated against the workspace. */
  searchPath: string;
  pattern: string;
  ignoreCase: boolean;
  /** File filter: without "/" it matches file names at any depth, with "/" paths relative to searchPath. */
  glob?: string;
  context: number;
  maxResults: number;
};

type GrepHit = {
  file: string;
  line: number;
  /** The match line plus up to `context` lines on each side, in order. */
  block: Array<[number, string]>;
};

export type GrepResult = {
  hits: GrepHit[];
  truncated: boolean;
  engine: "ripgrep" | "javascript";
};

class GrepCollector {
  readonly hits: GrepHit[] = [];
  truncated = false;

  constructor(private readonly maxResults: number) {}

  /** Adds one file's matches; `lines` must hold every line the blocks need. */
  addFile(file: string, matchLines: number[], lines: Map<number, string>, context: number): void {
    for (const line of matchLines) {
      if (this.hits.length >= this.maxResults) {
        this.truncated = true;
        return;
      }
      const block: Array<[number, string]> = [];
      for (let n = Math.max(1, line - context); n <= line + context; n += 1) {
        const text = lines.get(n);
        if (text !== undefined) block.push([n, text]);
      }
      this.hits.push({ file, line, block });
    }
  }
}

function stripLineTerminator(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function decodeRgData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { text?: unknown; bytes?: unknown };
  if (typeof record.text === "string") return record.text;
  if (typeof record.bytes === "string") return Buffer.from(record.bytes, "base64").toString("utf8");
  return null;
}

class RipgrepPatternError extends Error {}

async function searchWithRipgrep(binary: string, input: GrepInput, isFile: boolean): Promise<GrepResult> {
  const cwd = isFile ? path.dirname(input.searchPath) : input.searchPath;
  const target = isFile ? path.basename(input.searchPath) : ".";
  const args = [
    "--json",
    "--no-config",
    "--sort",
    "path",
    "--hidden",
    "--no-require-git",
    "--no-messages",
    "--engine",
    "auto",
    input.ignoreCase ? "--ignore-case" : "--case-sensitive",
    "--max-filesize",
    String(GREP_MAX_FILE_BYTES),
    "--context",
    String(input.context),
    ...(input.glob ? ["--glob", input.glob] : []),
    // Later globs win, so the shared exclusions hold even against a broad user glob.
    ...[...GLOB_SKIPPED_DIRECTORIES].flatMap((dir) => ["--glob", `!${dir}/`]),
    "--regexp",
    input.pattern,
    "--",
    target,
  ];
  const collector = new GrepCollector(input.maxResults);
  return await new Promise<GrepResult>((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buffered = "";
    let stderr = "";
    let stopped = false;
    let fileLines = new Map<number, string>();
    let fileMatches: number[] = [];
    const handleMessage = (message: { type?: string; data?: Record<string, unknown> }) => {
      const data = message.data ?? {};
      if (message.type === "begin") {
        fileLines = new Map();
        fileMatches = [];
        return;
      }
      if (message.type === "match" || message.type === "context") {
        const lineNumber = typeof data.line_number === "number" ? data.line_number : null;
        const text = decodeRgData(data.lines);
        if (lineNumber == null || text == null) return;
        fileLines.set(lineNumber, stripLineTerminator(text));
        if (message.type === "match") fileMatches.push(lineNumber);
        return;
      }
      if (message.type === "end") {
        const printed = decodeRgData(data.path);
        if (printed != null && fileMatches.length > 0) {
          collector.addFile(path.resolve(cwd, printed), fileMatches, fileLines, input.context);
        }
        fileLines = new Map();
        fileMatches = [];
        if (collector.truncated && !stopped) {
          stopped = true;
          child.kill();
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0 && !stopped) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            // Not a JSON message; ignore.
          }
        }
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (stopped || code === 0 || code === 1 || collector.hits.length > 0) {
        resolve({ hits: collector.hits, truncated: collector.truncated, engine: "ripgrep" });
        return;
      }
      const message = stderr.trim();
      if (!message) {
        resolve({ hits: [], truncated: false, engine: "ripgrep" });
        return;
      }
      reject(/regex|look-?around|backreference/i.test(message) ? new RipgrepPatternError(message) : new Error(message));
    });
  });
}

type IgnoreRule = { regex: RegExp; anchored: boolean; dirOnly: boolean; negate: boolean };
type IgnoreScope = { base: string; rules: IgnoreRule[] };

/** gitignore syntax: plain, anchored, directory-only and `!` re-include patterns, with `\!` / `\#` escapes. */
function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) {
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const anchored = line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    try {
      rules.push({ regex: globToRegExp(line), anchored, dirOnly, negate });
    } catch {
      // Unsupported pattern; skip it.
    }
  }
  return rules;
}

/** A directory's `.gitignore`, then its `.ignore`, whose rules take precedence as in ripgrep. */
async function loadIgnoreScope(dir: string): Promise<IgnoreScope | null> {
  const rules: IgnoreRule[] = [];
  for (const name of [".gitignore", ".ignore"]) {
    const text = await fs.readFile(path.join(dir, name), "utf8").catch(() => null);
    if (text != null) rules.push(...parseIgnoreRules(text));
  }
  return rules.length ? { base: dir, rules } : null;
}

/** The repository's `.git/info/exclude`, including through a linked worktree's `.git` file. */
async function loadGitExcludeScope(repoRoot: string): Promise<IgnoreScope | null> {
  const dotGit = path.join(repoRoot, ".git");
  const stat = await fs.stat(dotGit).catch(() => null);
  if (!stat) return null;
  let gitDir = dotGit;
  if (stat.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
    if (!pointer) return null;
    gitDir = path.resolve(repoRoot, pointer);
    const common = (await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => null))?.trim();
    if (common) gitDir = path.resolve(gitDir, common);
  }
  const text = await fs.readFile(path.join(gitDir, "info", "exclude"), "utf8").catch(() => null);
  const rules = text == null ? [] : parseIgnoreRules(text);
  return rules.length ? { base: repoRoot, rules } : null;
}

/** Scopes run from lowest to highest precedence; the last rule that matches decides, as in git. */
function isIgnored(scopes: IgnoreScope[], absolute: string, isDirectory: boolean): boolean {
  const name = path.basename(absolute);
  let ignored = false;
  for (const scope of scopes) {
    const relative = path.relative(scope.base, absolute).split(path.sep).join("/");
    if (!relative || relative.startsWith("..")) continue;
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(rule.anchored ? relative : name)) ignored = !rule.negate;
    }
  }
  return ignored;
}

function compileGlobFilter(glob: string | undefined): ((relative: string) => boolean) | null {
  const trimmed = glob?.trim();
  if (!trimmed) return null;
  const negated = trimmed.startsWith("!");
  const body = negated ? trimmed.slice(1) : trimmed;
  const regex = globToRegExp(body);
  const byName = !body.replace(/\/+$/, "").includes("/");
  return (relative) => {
    const subject = byName ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
    return regex.test(subject) !== negated;
  };
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function searchWithJavaScript(input: GrepInput, isFile: boolean): Promise<GrepResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
  } catch (error) {
    throw new Error(`grep.pattern is not a valid regular expression: ${(error as Error).message}`);
  }
  const collector = new GrepCollector(input.maxResults);
  const globFilter = compileGlobFilter(input.glob);

  const scanFile = async (file: string): Promise<void> => {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size > GREP_MAX_FILE_BYTES) return;
    const buffer = await fs.readFile(file).catch(() => null);
    if (!buffer || buffer.includes(0)) return;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const matches: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index]!)) matches.push(index + 1);
    }
    if (matches.length === 0) return;
    const byNumber = new Map<number, string>();
    lines.forEach((line, index) => byNumber.set(index + 1, line));
    collector.addFile(file, matches, byNumber, input.context);
  };

  if (isFile) {
    await scanFile(input.searchPath);
    return { hits: collector.hits, truncated: collector.truncated, engine: "javascript" };
  }

  // .git/info/exclude and the ignore files between the workspace root and the search root apply too.
  const ancestorScopes: IgnoreScope[] = [];
  const excludeScope = await loadGitExcludeScope(input.workspaceRoot);
  if (excludeScope) ancestorScopes.push(excludeScope);
  const fromRoot = path.relative(input.workspaceRoot, input.searchPath);
  if (fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot)) {
    let dir = input.workspaceRoot;
    for (const segment of fromRoot.split(path.sep)) {
      const scope = await loadIgnoreScope(dir);
      if (scope) ancestorScopes.push(scope);
      dir = path.join(dir, segment);
    }
  }

  const visit = async (dir: string, scopes: IgnoreScope[]): Promise<void> => {
    const own = await loadIgnoreScope(dir);
    const active = own ? [...scopes, own] : scopes;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => compareCodePoints(a.name, b.name));
    for (const entry of entries) {
      if (collector.truncated) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (GLOB_SKIPPED_DIRECTORIES.has(entry.name) || isIgnored(active, absolute, true)) continue;
        await visit(absolute, active);
        continue;
      }
      if (!entry.isFile() || isIgnored(active, absolute, false)) continue;
      const relative = path.relative(input.searchPath, absolute).split(path.sep).join("/");
      if (globFilter && !globFilter(relative)) continue;
      await scanFile(absolute);
    }
  };
  await visit(input.searchPath, ancestorScopes);
  return { hits: collector.hits, truncated: collector.truncated, engine: "javascript" };
}

/**
 * Searches with ripgrep when a binary is available and falls back to a JS
 * walker otherwise. Patterns ripgrep rejects (even with its PCRE2 engine) are
 * retried as JavaScript regular expressions before reporting the error.
 */
export async function searchWorkspace(input: GrepInput): Promise<GrepResult> {
  const stat = await fs.stat(input.searchPath).catch(() => null);
  if (!stat) {
    throw new Error(`grep.path does not exist: ${path.relative(input.workspaceRoot, input.searchPath) || "."}`);
  }
  const isFile = stat.isFile();
  const binary = await resolveRipgrepBinary();
  if (binary) {
    try {
      return await searchWithRipgrep(binary, input, isFile);
    } catch (error) {
      if (!(error instanceof RipgrepPatternError)) throw error;
      try {
        return await searchWithJavaScript(input, isFile);
      } catch {
        throw new Error(`grep.pattern is not a valid regular expression:\n${error.message}`);
      }
    }
  }
  return await searchWithJavaScript(input, isFile);
}

function clipLine(text: string): string {
  return text.length > GREP_MAX_LINE_CHARS
    ? `${text.slice(0, GREP_MAX_LINE_CHARS)}...[+${text.length - GREP_MAX_LINE_CHARS} chars]`
    : text;
}

export function formatGrepResult(result: GrepResult, workspaceRoot: string, maxResultsCap: number): string {
  if (result.hits.length === 0) {
    return "No matches.";
  }
  const blocks = result.hits.map((hit) => {
    const relative = path.relative(workspaceRoot, hit.file).split(path.sep).join("/");
    return `${relative}:${hit.line}\n${hit.block.map(([n, text]) => `${n}|${clipLine(text)}`).join("\n")}`;
  });
  if (result.truncated) {
    blocks.push(
      `...[${result.hits.length} matches shown; more exist - raise maxResults (max ${maxResultsCap}) or narrow pattern, path, or glob]`
    );
  }
  return blocks.join("\n\n");
}
