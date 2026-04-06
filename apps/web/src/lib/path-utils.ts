/** Workspace-relative POSIX-style segments (e.g. `src/app`). */
export function parentDir(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

export function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}
