import { promises as fs } from "node:fs";
import path from "node:path";

/** Relative paths resolve in the workspace; absolute ones may also point into `extraRoots`. */
export function resolveWorkspacePath(workspaceRoot: string, inputPath: string, extraRoots: readonly string[] = []): string {
  const resolved = path.resolve(workspaceRoot, inputPath);
  for (const root of [workspaceRoot, ...extraRoots]) {
    const relative = path.relative(root, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return resolved;
    }
  }
  throw new Error(`Path escapes workspace: ${inputPath}`);
}

/** `null` when the file does not exist; other filesystem errors still throw. */
export async function readWorkspaceFileIfExists(resolvedPath: string): Promise<string | null> {
  try {
    return await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export const MAX_READ_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function imageMimeTypeForPath(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}
