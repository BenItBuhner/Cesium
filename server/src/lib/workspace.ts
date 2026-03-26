import { promises as fs } from "node:fs";
import path from "node:path";

function resolveInitialWorkspaceRoot(): string {
  const configuredRoot = process.env.WORKSPACE_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === "server") {
    return path.resolve(cwd, "..");
  }

  return path.resolve(cwd);
}

let workspaceRoot = resolveInitialWorkspaceRoot();

const DIMMED_NAMES = new Set(["node_modules", ".git", ".next", "dist"]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  ["dockerfile", "dockerfile"],
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".bmp", "plaintext"],
  [".cjs", "javascript"],
  [".cts", "typescript"],
  [".css", "css"],
  [".gif", "plaintext"],
  [".html", "html"],
  [".ico", "plaintext"],
  [".java", "java"],
  [".js", "javascript"],
  [".jpeg", "plaintext"],
  [".jpg", "plaintext"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".md", "markdown"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".png", "plaintext"],
  [".py", "python"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svg", "xml"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".txt", "plaintext"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ts", "text/typescript; charset=utf-8"],
  [".tsx", "text/typescript; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".yaml", "application/yaml; charset=utf-8"],
  [".yml", "application/yaml; charset=utf-8"],
]);

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function getWorkspaceName(): string {
  return path.basename(workspaceRoot);
}

export async function changeWorkspaceRoot(newRoot: string): Promise<string> {
  const resolved = path.resolve(newRoot);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${resolved}`);
  }
  workspaceRoot = resolved;
  return workspaceRoot;
}

export function resolveSafePath(relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const resolved = path.resolve(workspaceRoot, normalizedRelative);
  const relative = path.relative(workspaceRoot, resolved);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }

  return resolved;
}

export function toRelativePath(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}

export function inferLanguage(fileName: string): string {
  const lowerName = path.basename(fileName).toLowerCase();
  if (lowerName.startsWith(".env")) {
    return "shell";
  }

  const basenameLanguage = LANGUAGE_BY_BASENAME.get(lowerName);
  if (basenameLanguage) {
    return basenameLanguage;
  }

  const extension = path.extname(lowerName);
  return LANGUAGE_BY_EXTENSION.get(extension) ?? "plaintext";
}

export function inferFileKind(fileName: string): "text" | "svg" | "image" {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".svg") {
    return "svg";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  return "text";
}

export function inferMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
}

export function isDimmed(name: string): boolean {
  return DIMMED_NAMES.has(name);
}

export function shouldIgnorePath(relativePath: string): boolean {
  return relativePath.length === 0;
}
