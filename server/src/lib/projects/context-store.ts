import { promises as fs } from "node:fs";
import path from "node:path";
import { getProjectContextDir } from "./paths.js";
import type { ProjectContextFile } from "./types.js";

export const CONTEXT_FILE_MAX_BYTES = 256 * 1024;
export const CONTEXT_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const CONTEXT_MAX_DEPTH = 6;
const CONTEXT_MAX_ENTRIES = 500;
export const PROJECT_NOTES_FILE = "notes.md";

export class ProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectContextError";
  }
}

/**
 * Validates a context-relative path and returns its absolute location. Hidden
 * segments are refused: engine-managed mirrors (`.cesium/…`) live beside the
 * user's files and are not Project context.
 */
export function resolveContextPath(projectId: string, relativePath: string): {
  absolute: string;
  relative: string;
} {
  const raw = relativePath.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new ProjectContextError("Context path is required.");
  }
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new ProjectContextError(`Context paths are relative to the Project folder: ${relativePath}`);
  }
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0) {
    throw new ProjectContextError("Context path is required.");
  }
  if (segments.length > CONTEXT_MAX_DEPTH) {
    throw new ProjectContextError(`Context paths may be at most ${CONTEXT_MAX_DEPTH} levels deep.`);
  }
  for (const segment of segments) {
    if (segment === ".." || segment.startsWith(".")) {
      throw new ProjectContextError(`Context path is not allowed: ${relativePath}`);
    }
  }
  const root = getProjectContextDir(projectId);
  const relative = segments.join("/");
  const absolute = path.resolve(root, relative);
  const check = path.relative(root, absolute);
  if (!check || check.startsWith("..") || path.isAbsolute(check)) {
    throw new ProjectContextError(`Context path escapes the Project folder: ${relativePath}`);
  }
  return { absolute, relative };
}

async function assertNoSymlinkEscape(projectId: string, absolute: string): Promise<void> {
  const root = await fs.realpath(getProjectContextDir(projectId));
  let probe = absolute;
  // Walk up to the nearest existing ancestor; its real path must stay inside.
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const check = path.relative(root, real);
      if (check.startsWith("..") || path.isAbsolute(check)) {
        throw new ProjectContextError("Context path resolves outside the Project folder.");
      }
      return;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return;
      }
      probe = parent;
    }
  }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: ProjectContextFile[]
): Promise<void> {
  if (depth > CONTEXT_MAX_DEPTH || out.length >= CONTEXT_MAX_ENTRIES) {
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || out.length >= CONTEXT_MAX_ENTRIES) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, depth + 1, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat) continue;
      out.push({
        path: path.relative(root, absolute).replace(/\\/g, "/"),
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
      });
    }
  }
}

export async function listContextFiles(projectId: string): Promise<ProjectContextFile[]> {
  const root = getProjectContextDir(projectId);
  const out: ProjectContextFile[] = [];
  await walk(root, root, 1, out);
  return out;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

export async function readContextFile(
  projectId: string,
  relativePath: string
): Promise<{ path: string; content: string; size: number; updatedAt: number }> {
  const { absolute, relative } = resolveContextPath(projectId, relativePath);
  await assertNoSymlinkEscape(projectId, absolute);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new ProjectContextError(`No context file at ${relative}.`);
  }
  if (stat.size > CONTEXT_FILE_MAX_BYTES) {
    throw new ProjectContextError(
      `${relative} is ${stat.size} bytes; context files are capped at ${CONTEXT_FILE_MAX_BYTES}.`
    );
  }
  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer)) {
    throw new ProjectContextError(`${relative} is not a text file.`);
  }
  return {
    path: relative,
    content: buffer.toString("utf8"),
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
  };
}

export async function writeContextFile(
  projectId: string,
  relativePath: string,
  content: string,
  mode: "replace" | "append" = "replace"
): Promise<ProjectContextFile> {
  const { absolute, relative } = resolveContextPath(projectId, relativePath);
  await assertNoSymlinkEscape(projectId, absolute);
  if (content.includes("\u0000")) {
    throw new ProjectContextError("Context files must be text.");
  }
  const existing = await fs.stat(absolute).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new ProjectContextError(`${relative} is a directory.`);
  }
  const previous =
    mode === "append" && existing ? await fs.readFile(absolute, "utf8") : "";
  const next =
    mode === "append" && previous
      ? `${previous}${previous.endsWith("\n") ? "" : "\n"}${content}`
      : content;
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (nextBytes > CONTEXT_FILE_MAX_BYTES) {
    throw new ProjectContextError(
      `${relative} would be ${nextBytes} bytes; context files are capped at ${CONTEXT_FILE_MAX_BYTES}.`
    );
  }
  const files = await listContextFiles(projectId);
  const otherBytes = files
    .filter((file) => file.path !== relative)
    .reduce((sum, file) => sum + file.size, 0);
  if (otherBytes + nextBytes > CONTEXT_TOTAL_MAX_BYTES) {
    throw new ProjectContextError(
      `Project context would exceed ${CONTEXT_TOTAL_MAX_BYTES} bytes. Trim or delete files first.`
    );
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, next, "utf8");
  await fs.rename(temp, absolute);
  const stat = await fs.stat(absolute);
  return { path: relative, size: stat.size, updatedAt: Math.round(stat.mtimeMs) };
}

export async function deleteContextFile(projectId: string, relativePath: string): Promise<void> {
  const { absolute, relative } = resolveContextPath(projectId, relativePath);
  await assertNoSymlinkEscape(projectId, absolute);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new ProjectContextError(`No context file at ${relative}.`);
  }
  await fs.unlink(absolute);
}

export function initialNotesMarkdown(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "Shared notes for this Project. The orchestrator keeps this file a short index:",
    "current goals, who is working on what, open decisions, and links to longer docs",
    "in this folder.",
    "",
    "## Status",
    "",
    "- Nothing started yet.",
    "",
  ].join("\n");
}

export async function seedProjectContext(projectId: string, projectName: string): Promise<void> {
  const root = getProjectContextDir(projectId);
  await fs.mkdir(root, { recursive: true });
  const notes = path.join(root, PROJECT_NOTES_FILE);
  const exists = await fs.stat(notes).catch(() => null);
  if (!exists) {
    await fs.writeFile(notes, initialNotesMarkdown(projectName), "utf8");
  }
}
