/**
 * POSIX-style path helpers for the browser virtual filesystem. The engine
 * runs in the browser where `node:path` does not exist, so the tiny subset
 * the VFS and route shims need is implemented here. All VFS paths are
 * absolute, `/`-separated, with no trailing slash (root is `"/"`).
 */

export function normalizePath(input: string): string {
  const raw = input.replace(/\\/g, "/");
  const absolute = raw.startsWith("/");
  const parts = raw.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) {
    return `/${joined}`.replace(/\/+$/, "") || "/";
  }
  return joined;
}

export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter(Boolean).join("/"));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : "";
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "";
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}

/**
 * Resolve a workspace-relative path against a workspace root and refuse
 * escapes, mirroring the server's `resolveSafePath`.
 */
export function resolveSafePath(workspaceRoot: string, relativePath: string): string {
  const root = normalizePath(workspaceRoot);
  const resolved = normalizePath(`${root}/${relativePath.replace(/\\/g, "/")}`);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return resolved;
}

export function toRelativePath(workspaceRoot: string, absolutePath: string): string {
  const root = normalizePath(workspaceRoot);
  const target = normalizePath(absolutePath);
  if (target === root) return "";
  if (target.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  return target.replace(/^\//, "");
}
