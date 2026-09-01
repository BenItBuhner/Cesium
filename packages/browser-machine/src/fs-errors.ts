/**
 * Node-style filesystem errors with `.code` so isomorphic-git (and any code
 * ported from the server) can branch on ENOENT/EEXIST exactly like it does
 * against a real `fs`.
 */
export type FsErrorCode =
  | "ENOENT"
  | "EEXIST"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EINVAL";

export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;

  constructor(code: FsErrorCode, path: string, syscall?: string) {
    super(`${code}: ${syscall ?? "fs"} '${path}'`);
    this.name = "FsError";
    this.code = code;
    this.path = path;
  }
}

export function isFsErrorCode(error: unknown, code: FsErrorCode): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === code
  );
}
