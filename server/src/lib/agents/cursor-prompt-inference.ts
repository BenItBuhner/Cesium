import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { inferFileKind, isDimmed } from "../workspace.js";
import { isGenericAcpToolTitle } from "./acp/acp-tool-parse.js";

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

export type CursorPromptSearchHint = {
  query: string;
  presentation: "find" | "grep";
};

export type CursorPromptToolHints = {
  explicitPaths: string[];
  searches: CursorPromptSearchHint[];
  nextPathIndex: number;
  nextSearchIndex: number;
};

export type CursorToolInference = {
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

export function buildCursorPromptToolHints(
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

export function countUniqueLocationPaths(locations: readonly { path: string; line?: number }[]): number {
  return new Set(locations.map((entry) => entry.path)).size;
}

export function isGenericCursorSearchTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "grep" ||
    normalized === "find" ||
    normalized === "search" ||
    isGenericAcpToolTitle(value)
  );
}
