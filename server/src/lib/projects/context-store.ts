import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PROJECT_CONTEXT_FOLDERS,
  projectContextContentType,
  projectContextKindFromPath,
  type ProjectContextFileKind,
} from "@cesium/core/projects";
import { getProjectContextDir } from "./paths.js";
import type { ProjectContextFile } from "./types.js";

/** Text read and written through tools and the JSON routes. */
export const CONTEXT_FILE_MAX_BYTES = 1024 * 1024;
/** Uploads (screenshots, recordings, logs). Matches the engine's request body limit. */
export const CONTEXT_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const CONTEXT_TOTAL_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const CONTEXT_MAX_DEPTH = 8;
const CONTEXT_MAX_ENTRIES = 5_000;
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
  return resolveContextPathIn(getProjectContextDir(projectId), relativePath);
}

/** `resolveContextPath` for any context folder (a peer's mirror of one, say). */
export function resolveContextPathIn(root: string, relativePath: string): {
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
  const relative = segments.join("/");
  const absolute = path.resolve(root, relative);
  const check = path.relative(root, absolute);
  if (!check || check.startsWith("..") || path.isAbsolute(check)) {
    throw new ProjectContextError(`Context path escapes the Project folder: ${relativePath}`);
  }
  return { absolute, relative };
}

async function assertNoSymlinkEscape(projectId: string, absolute: string): Promise<void> {
  await assertNoSymlinkEscapeIn(getProjectContextDir(projectId), absolute);
}

/** The nearest existing ancestor of `absolute` must really be inside `contextRoot`. */
export async function assertNoSymlinkEscapeIn(contextRoot: string, absolute: string): Promise<void> {
  const root = await fs.realpath(contextRoot);
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

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/** Kind from the extension, else from the first bytes (unknown extensions). */
async function fileKind(absolute: string, relative: string): Promise<ProjectContextFileKind> {
  const byPath = projectContextKindFromPath(relative);
  if (byPath) {
    return byPath;
  }
  const handle = await fs.open(absolute, "r").catch(() => null);
  if (!handle) {
    return "binary";
  }
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return looksBinary(head.subarray(0, bytesRead)) ? "binary" : "text";
  } finally {
    await handle.close();
  }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: { files: ProjectContextFile[]; folders: string[] }
): Promise<void> {
  if (depth > CONTEXT_MAX_DEPTH || out.files.length >= CONTEXT_MAX_ENTRIES) {
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || out.files.length >= CONTEXT_MAX_ENTRIES) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.folders.push(relative);
      await walk(root, absolute, depth + 1, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat) continue;
      out.files.push({
        path: relative,
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
        kind: await fileKind(absolute, relative),
      });
    }
  }
}

/** Every file and folder in the Project context (hidden entries excluded). */
export async function listContextEntries(
  projectId: string
): Promise<{ files: ProjectContextFile[]; folders: string[] }> {
  return listContextEntriesIn(getProjectContextDir(projectId));
}

export async function listContextEntriesIn(
  root: string
): Promise<{ files: ProjectContextFile[]; folders: string[] }> {
  const out = { files: [] as ProjectContextFile[], folders: [] as string[] };
  await walk(root, root, 1, out);
  return out;
}

export async function listContextFiles(projectId: string): Promise<ProjectContextFile[]> {
  return (await listContextEntries(projectId)).files;
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
  const kind = projectContextKindFromPath(relative);
  if (kind === "image" || kind === "video") {
    throw new ProjectContextError(`${relative} is ${kind === "image" ? "an image" : "a video"}, not a text file.`);
  }
  if (stat.size > CONTEXT_FILE_MAX_BYTES) {
    throw new ProjectContextError(
      `${relative} is ${stat.size} bytes; text is read up to ${CONTEXT_FILE_MAX_BYTES} bytes.`
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

/** Where a context file is and how to serve it, for the raw route. */
export async function statContextFile(
  projectId: string,
  relativePath: string
): Promise<{ absolute: string; path: string; size: number; updatedAt: number; kind: ProjectContextFileKind; contentType: string }> {
  const { absolute, relative } = resolveContextPath(projectId, relativePath);
  await assertNoSymlinkEscape(projectId, absolute);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new ProjectContextError(`No context file at ${relative}.`);
  }
  const kind = await fileKind(absolute, relative);
  return {
    absolute,
    path: relative,
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
    kind,
    contentType: projectContextContentType(relative, kind),
  };
}

export async function assertTotalFits(projectId: string, relative: string, nextBytes: number): Promise<void> {
  const files = await listContextFiles(projectId);
  const otherBytes = files
    .filter((file) => file.path !== relative)
    .reduce((sum, file) => sum + file.size, 0);
  if (otherBytes + nextBytes > CONTEXT_TOTAL_MAX_BYTES) {
    throw new ProjectContextError(
      `Project context would exceed ${CONTEXT_TOTAL_MAX_BYTES} bytes. Trim or delete files first.`
    );
  }
}

async function atomicWrite(absolute: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, absolute);
}

/** Stores uploaded bytes (any type) in the Project context. */
export async function writeContextUpload(
  projectId: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<ProjectContextFile> {
  const { absolute, relative } = resolveContextPath(projectId, relativePath);
  await assertNoSymlinkEscape(projectId, absolute);
  if (bytes.byteLength > CONTEXT_UPLOAD_MAX_BYTES) {
    throw new ProjectContextError(
      `${relative} is ${bytes.byteLength} bytes; uploads are capped at ${CONTEXT_UPLOAD_MAX_BYTES}.`
    );
  }
  const existing = await fs.stat(absolute).catch(() => null);
  if (existing && !existing.isFile()) {
    throw new ProjectContextError(`${relative} is a directory.`);
  }
  await assertTotalFits(projectId, relative, bytes.byteLength);
  await atomicWrite(absolute, bytes);
  const stat = await fs.stat(absolute);
  return {
    path: relative,
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
    kind: await fileKind(absolute, relative),
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
      `${relative} would be ${nextBytes} bytes; text files are capped at ${CONTEXT_FILE_MAX_BYTES}.`
    );
  }
  await assertTotalFits(projectId, relative, nextBytes);
  await atomicWrite(absolute, next);
  const stat = await fs.stat(absolute);
  return {
    path: relative,
    size: stat.size,
    updatedAt: Math.round(stat.mtimeMs),
    kind: await fileKind(absolute, relative),
  };
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
    "The coordinator keeps this file a short, live checklist of the Project: what is",
    "being worked on and by whom, with links to agents, pull requests and docs.",
    "",
    "- [ ] Nothing started yet.",
    "",
  ].join("\n");
}

/** Creates `notes.md` and the standard folders (docs, internal, media) when missing. */
export async function seedProjectContext(projectId: string, projectName: string): Promise<void> {
  const root = getProjectContextDir(projectId);
  await fs.mkdir(root, { recursive: true });
  await Promise.all(
    PROJECT_CONTEXT_FOLDERS.map((folder) => fs.mkdir(path.join(root, folder), { recursive: true }))
  );
  const notes = path.join(root, PROJECT_NOTES_FILE);
  const exists = await fs.stat(notes).catch(() => null);
  if (!exists) {
    await fs.writeFile(notes, initialNotesMarkdown(projectName), "utf8");
  }
}
