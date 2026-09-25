import { promises as fs } from "node:fs";
import path from "node:path";

export const GLOB_DEFAULT_RESULTS = 200;
export const GLOB_MAX_RESULTS = 2_000;
/** Directory-visit cap so a pathological tree cannot pin the event loop. */
export const GLOB_MAX_DIRECTORIES = 20_000;

/** Same directories the `grep` tool skips: never useful, always enormous. */
export const GLOB_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".docker",
  ".next",
]);

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function translateGlobPart(glob: string): string {
  let out = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          // "**/" matches zero or more whole path segments.
          out += "(?:[^/]*/)*";
          index += 3;
        } else {
          out += ".*";
          index += 2;
        }
      } else {
        out += "[^/]*";
        index += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      index += 1;
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) {
        out += "\\{";
        index += 1;
      } else {
        const parts = glob.slice(index + 1, end).split(",");
        out += `(?:${parts.map(translateGlobPart).join("|")})`;
        index = end + 1;
      }
    } else if (char === "[") {
      const end = glob.indexOf("]", index);
      if (end < 0) {
        out += "\\[";
        index += 1;
      } else {
        out += glob.slice(index, end + 1);
        index = end + 1;
      }
    } else {
      out += char.replace(/[.+^$()|\\]/g, "\\$&");
      index += 1;
    }
  }
  return out;
}

/**
 * Glob → anchored RegExp over "/"-separated relative paths. Supports `*`
 * (within one segment), `**` (across segments), `?`, `{a,b}` alternation, and
 * `[...]` classes. A leading "./" is ignored; backslashes are treated as "/".
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return new RegExp(`^${translateGlobPart(normalized)}$`);
}

export type GlobEntry = {
  /** Path relative to the workspace root, "/"-separated; directories end with "/". */
  path: string;
  isDirectory: boolean;
};

export type GlobWorkspaceEntriesResult = {
  entries: GlobEntry[];
  /** True when more matches exist beyond `maxResults`. */
  truncated: boolean;
  /** True when the directory-visit cap stopped the walk early. */
  directoryCapReached: boolean;
};

/**
 * Walk `searchRoot` (inside `workspaceRoot`) and return every file and
 * directory whose path relative to `searchRoot` matches `pattern`, sorted.
 * Directories are included so `pattern: "*"` doubles as a directory listing.
 */
export async function globWorkspaceEntries(input: {
  workspaceRoot: string;
  searchRoot: string;
  pattern: string;
  maxResults?: number;
}): Promise<GlobWorkspaceEntriesResult> {
  const regex = globToRegExp(input.pattern);
  const maxResults = Math.max(
    1,
    Math.min(GLOB_MAX_RESULTS, Math.floor(input.maxResults ?? GLOB_DEFAULT_RESULTS))
  );
  const matches: GlobEntry[] = [];
  let truncated = false;
  let directoryCapReached = false;
  let visitedDirectories = 0;
  const stack: string[] = [input.searchRoot];
  while (stack.length > 0) {
    if (visitedDirectories >= GLOB_MAX_DIRECTORIES) {
      directoryCapReached = true;
      break;
    }
    const directory = stack.pop()!;
    visitedDirectories += 1;
    const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    // Code-point order (not localeCompare) so identical trees list identically
    // on every machine regardless of the runtime locale.
    dirents.sort((a, b) => compareCodePoints(a.name, b.name));
    for (const dirent of dirents) {
      const absolute = path.join(directory, dirent.name);
      const isDirectory = dirent.isDirectory();
      if (isDirectory && GLOB_SKIPPED_DIRECTORIES.has(dirent.name)) {
        continue;
      }
      if (!isDirectory && !dirent.isFile()) {
        continue;
      }
      const relativeToSearch = path.relative(input.searchRoot, absolute).split(path.sep).join("/");
      if (regex.test(relativeToSearch)) {
        const relativeToWorkspace = path
          .relative(input.workspaceRoot, absolute)
          .split(path.sep)
          .join("/");
        matches.push({
          path: isDirectory ? `${relativeToWorkspace}/` : relativeToWorkspace,
          isDirectory,
        });
      }
      if (isDirectory) {
        stack.push(absolute);
      }
    }
  }
  matches.sort((a, b) => compareCodePoints(a.path, b.path));
  if (matches.length > maxResults) {
    truncated = true;
    matches.length = maxResults;
  }
  return { entries: matches, truncated, directoryCapReached };
}

export function formatGlobResult(
  result: GlobWorkspaceEntriesResult,
  input: { pattern: string; searchPath: string }
): string {
  if (result.entries.length === 0) {
    return result.directoryCapReached
      ? `No matches for ${input.pattern} under ${input.searchPath} before the ${GLOB_MAX_DIRECTORIES}-directory walk limit; narrow the path.`
      : `No matches for ${input.pattern} under ${input.searchPath}.`;
  }
  const lines = result.entries.map((entry) => entry.path);
  if (result.truncated) {
    lines.push(
      `...[${result.entries.length} shown; more matches exist - raise maxResults (max ${GLOB_MAX_RESULTS}) or narrow the pattern]`
    );
  }
  if (result.directoryCapReached) {
    lines.push(`...[stopped after visiting ${GLOB_MAX_DIRECTORIES} directories; narrow the path]`);
  }
  return lines.join("\n");
}
