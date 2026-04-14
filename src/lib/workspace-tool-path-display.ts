/**
 * Workspace-scoped labels for tool paths: hide absolute paths outside the workspace,
 * use basename-only for root-level files, and keep subdirs as relative segments.
 */

function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathUnderRoot(absRaw: string, rootRaw: string): string | undefined {
  const abs = normalizeSep(absRaw).replace(/\/+$/, "") || "/";
  const root = normalizeSep(rootRaw).replace(/\/+$/, "") || "/";
  if (abs === root) {
    return "";
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!abs.startsWith(prefix)) {
    return undefined;
  }
  return abs.slice(prefix.length);
}

export function resolveWorkspaceToolPath(
  path: string,
  workspaceRoot: string | undefined
): string | null {
  const raw = path.trim();
  if (!raw) {
    return null;
  }
  const norm = normalizeSep(raw.replace(/^file:\/\//i, ""));
  if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) {
    if (!workspaceRoot?.trim()) {
      return null;
    }
    const rel = pathUnderRoot(norm, workspaceRoot.trim());
    return rel === undefined ? null : rel || toolPathBasename(norm);
  }
  return norm.replace(/^\.?\//, "");
}

export function toolPathBasename(p: string): string {
  const cleaned = normalizeSep(p.replace(/^file:\/\//i, "").split("?")[0] ?? p);
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

/**
 * User-visible path for tool file lists and titles.
 * When an absolute path is outside `workspaceRoot`, falls back to basename so
 * tool rows still show a name (ACP paths often use a different mount prefix than the UI root).
 */
export function formatToolFileLabel(
  path: string,
  workspaceRoot: string | undefined
): string | null {
  const raw = path.trim();
  if (!raw) {
    return null;
  }
  const norm = normalizeSep(raw.replace(/^file:\/\//i, ""));

  if (!workspaceRoot?.trim()) {
    if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) {
      return toolPathBasename(norm);
    }
    const rel = norm.replace(/^\.?\//, "");
    if (!rel.includes("/")) {
      return rel;
    }
    return rel;
  }

  const root = workspaceRoot.trim();

  if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) {
    const rel = pathUnderRoot(norm, root);
    if (rel === undefined) {
      return toolPathBasename(norm);
    }
    if (!rel) {
      return toolPathBasename(norm);
    }
    return rel;
  }

  const rel = norm.replace(/^\.?\//, "");
  if (!rel.includes("/")) {
    return rel;
  }
  return rel;
}
