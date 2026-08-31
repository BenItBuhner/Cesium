/**
 * Browser virtual filesystem.
 *
 * The full tree (metadata + file bytes) lives in memory for fast synchronous
 * traversal; every mutation is queued and flushed to IndexedDB in batched
 * transactions. This mirrors the LightningFS approach that isomorphic-git is
 * known to perform well against, while staying dependency-free.
 *
 * All paths are absolute POSIX paths. Workspace roots live under
 * `/workspaces/<workspaceId>` and engine-internal data under `/data`.
 */
import { FsError } from "./fs-errors";
import { basename, dirname, normalizePath } from "./paths";
import { FILES_STORE, idbBulk, idbGetAll } from "./idb";

export type VfsNodeType = "file" | "dir" | "symlink";

export type VfsRecord = {
  path: string;
  parent: string;
  type: VfsNodeType;
  /** File contents. Present only for `type === "file"`. */
  data?: Uint8Array;
  /** Symlink target. Present only for `type === "symlink"`. */
  target?: string;
  mode: number;
  mtimeMs: number;
};

export type VfsStats = {
  type: VfsNodeType;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export type VfsChange = {
  kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
};

const DEFAULT_FILE_MODE = 0o100644;
const DEFAULT_DIR_MODE = 0o40755;
const DEFAULT_SYMLINK_MODE = 0o120000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toStats(record: VfsRecord): VfsStats {
  const size = record.type === "file" ? (record.data?.byteLength ?? 0) : 0;
  return {
    type: record.type,
    mode: record.mode,
    size,
    mtimeMs: record.mtimeMs,
    ctimeMs: record.mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    ino: 0,
    isFile: () => record.type === "file",
    isDirectory: () => record.type === "dir",
    isSymbolicLink: () => record.type === "symlink",
  };
}

export class Vfs {
  private readonly nodes = new Map<string, VfsRecord>();
  private readonly children = new Map<string, Set<string>>();
  private readonly dirtyPuts = new Set<string>();
  private readonly dirtyDeletes = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<(changes: VfsChange[]) => void>();
  private pendingChanges: VfsChange[] = [];
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const records = await idbGetAll<VfsRecord>(FILES_STORE);
    for (const record of records) {
      this.indexRecord(record);
    }
    this.ensureRootDir();
    this.hydrated = true;
  }

  private ensureRootDir(): void {
    if (!this.nodes.has("/")) {
      this.nodes.set("/", {
        path: "/",
        parent: "",
        type: "dir",
        mode: DEFAULT_DIR_MODE,
        mtimeMs: Date.now(),
      });
    }
  }

  private indexRecord(record: VfsRecord): void {
    this.nodes.set(record.path, record);
    if (record.path !== "/") {
      const set = this.children.get(record.parent) ?? new Set<string>();
      set.add(record.path);
      this.children.set(record.parent, set);
    }
  }

  private unindexRecord(path: string): void {
    const record = this.nodes.get(path);
    if (!record) return;
    this.nodes.delete(path);
    const set = this.children.get(record.parent);
    set?.delete(path);
    if (set && set.size === 0) {
      this.children.delete(record.parent);
    }
  }

  private markDirty(path: string, deleted: boolean): void {
    if (deleted) {
      this.dirtyPuts.delete(path);
      this.dirtyDeletes.add(path);
    } else {
      this.dirtyDeletes.delete(path);
      this.dirtyPuts.add(path);
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, 25);
    }
  }

  /** Persist queued mutations. Chained so flushes never interleave. */
  flush(): Promise<void> {
    const puts = [...this.dirtyPuts]
      .map((path) => this.nodes.get(path))
      .filter((record): record is VfsRecord => Boolean(record));
    const deletes = [...this.dirtyDeletes];
    this.dirtyPuts.clear();
    this.dirtyDeletes.clear();
    if (puts.length === 0 && deletes.length === 0) {
      return this.flushChain;
    }
    this.flushChain = this.flushChain
      .catch(() => undefined)
      .then(() => idbBulk(FILES_STORE, puts, deletes))
      .catch((error) => {
        console.error("[browser-machine] VFS flush failed:", error);
      });
    return this.flushChain;
  }

  onChanges(listener: (changes: VfsChange[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(change: VfsChange): void {
    this.pendingChanges.push(change);
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null;
        const changes = this.pendingChanges;
        this.pendingChanges = [];
        for (const listener of this.changeListeners) {
          listener(changes);
        }
      }, 10);
    }
  }

  getRecord(path: string): VfsRecord | null {
    return this.nodes.get(normalizePath(path)) ?? null;
  }

  exists(path: string): boolean {
    return this.nodes.has(normalizePath(path));
  }

  stat(path: string): VfsStats {
    const record = this.resolveSymlinks(normalizePath(path));
    if (!record) throw new FsError("ENOENT", path, "stat");
    return toStats(record);
  }

  lstat(path: string): VfsStats {
    const record = this.nodes.get(normalizePath(path));
    if (!record) throw new FsError("ENOENT", path, "lstat");
    return toStats(record);
  }

  private resolveSymlinks(path: string, depth = 0): VfsRecord | null {
    if (depth > 16) return null;
    const record = this.nodes.get(path);
    if (!record) return null;
    if (record.type !== "symlink") return record;
    const target = record.target ?? "";
    const resolved = target.startsWith("/")
      ? normalizePath(target)
      : normalizePath(`${dirname(path)}/${target}`);
    return this.resolveSymlinks(resolved, depth + 1);
  }

  readDir(path: string): string[] {
    const normalized = normalizePath(path);
    const record = this.resolveSymlinks(normalized);
    if (!record) throw new FsError("ENOENT", path, "readdir");
    if (record.type !== "dir") throw new FsError("ENOTDIR", path, "readdir");
    const childPaths = this.children.get(record.path);
    if (!childPaths) return [];
    return [...childPaths].map((childPath) => basename(childPath)).sort();
  }

  readFile(path: string): Uint8Array {
    const record = this.resolveSymlinks(normalizePath(path));
    if (!record) throw new FsError("ENOENT", path, "read");
    if (record.type === "dir") throw new FsError("EISDIR", path, "read");
    return record.data ?? new Uint8Array(0);
  }

  readTextFile(path: string): string {
    return decoder.decode(this.readFile(path));
  }

  writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): void {
    const normalized = normalizePath(path);
    const parent = dirname(normalized);
    const parentRecord = this.resolveSymlinks(parent);
    if (!parentRecord || parentRecord.type !== "dir") {
      throw new FsError("ENOENT", parent, "write");
    }
    const existing = this.nodes.get(normalized);
    if (existing && existing.type === "dir") {
      throw new FsError("EISDIR", path, "write");
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const record: VfsRecord = {
      path: normalized,
      parent: parentRecord.path,
      type: "file",
      data: bytes,
      mode: options?.mode ?? existing?.mode ?? DEFAULT_FILE_MODE,
      mtimeMs: Date.now(),
    };
    this.indexRecord(record);
    this.markDirty(normalized, false);
    this.emitChange({ kind: existing ? "change" : "add", path: normalized });
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    const normalized = normalizePath(path);
    if (this.nodes.has(normalized)) {
      const existing = this.nodes.get(normalized);
      if (existing?.type === "dir") {
        if (options?.recursive) return;
        throw new FsError("EEXIST", path, "mkdir");
      }
      throw new FsError("EEXIST", path, "mkdir");
    }
    const parent = dirname(normalized);
    if (!this.nodes.has(parent)) {
      if (!options?.recursive) {
        throw new FsError("ENOENT", parent, "mkdir");
      }
      this.mkdir(parent, { recursive: true });
    }
    const parentRecord = this.nodes.get(parent);
    if (!parentRecord || parentRecord.type !== "dir") {
      throw new FsError("ENOTDIR", parent, "mkdir");
    }
    const record: VfsRecord = {
      path: normalized,
      parent,
      type: "dir",
      mode: DEFAULT_DIR_MODE,
      mtimeMs: Date.now(),
    };
    this.indexRecord(record);
    this.markDirty(normalized, false);
    this.emitChange({ kind: "addDir", path: normalized });
  }

  unlink(path: string): void {
    const normalized = normalizePath(path);
    const record = this.nodes.get(normalized);
    if (!record) throw new FsError("ENOENT", path, "unlink");
    if (record.type === "dir") throw new FsError("EISDIR", path, "unlink");
    this.unindexRecord(normalized);
    this.markDirty(normalized, true);
    this.emitChange({ kind: "unlink", path: normalized });
  }

  rmdir(path: string): void {
    const normalized = normalizePath(path);
    const record = this.nodes.get(normalized);
    if (!record) throw new FsError("ENOENT", path, "rmdir");
    if (record.type !== "dir") throw new FsError("ENOTDIR", path, "rmdir");
    const childPaths = this.children.get(normalized);
    if (childPaths && childPaths.size > 0) {
      throw new FsError("ENOTEMPTY", path, "rmdir");
    }
    this.unindexRecord(normalized);
    this.markDirty(normalized, true);
    this.emitChange({ kind: "unlinkDir", path: normalized });
  }

  /** Recursive delete matching `fs.rm(path, { recursive: true, force: true })`. */
  rm(path: string): void {
    const normalized = normalizePath(path);
    const record = this.nodes.get(normalized);
    if (!record) return;
    if (record.type === "dir") {
      const childPaths = this.children.get(normalized);
      if (childPaths) {
        for (const childPath of [...childPaths]) {
          this.rm(childPath);
        }
      }
      this.rmdir(normalized);
      return;
    }
    this.unlink(normalized);
  }

  symlink(target: string, path: string): void {
    const normalized = normalizePath(path);
    if (this.nodes.has(normalized)) throw new FsError("EEXIST", path, "symlink");
    const parent = dirname(normalized);
    const parentRecord = this.nodes.get(parent);
    if (!parentRecord || parentRecord.type !== "dir") {
      throw new FsError("ENOENT", parent, "symlink");
    }
    const record: VfsRecord = {
      path: normalized,
      parent,
      type: "symlink",
      target,
      mode: DEFAULT_SYMLINK_MODE,
      mtimeMs: Date.now(),
    };
    this.indexRecord(record);
    this.markDirty(normalized, false);
    this.emitChange({ kind: "add", path: normalized });
  }

  readlink(path: string): string {
    const record = this.nodes.get(normalizePath(path));
    if (!record) throw new FsError("ENOENT", path, "readlink");
    if (record.type !== "symlink") throw new FsError("EINVAL", path, "readlink");
    return record.target ?? "";
  }

  rename(fromPath: string, toPath: string): void {
    const from = normalizePath(fromPath);
    const to = normalizePath(toPath);
    const record = this.nodes.get(from);
    if (!record) throw new FsError("ENOENT", fromPath, "rename");
    const toParent = dirname(to);
    const toParentRecord = this.resolveSymlinks(toParent);
    if (!toParentRecord || toParentRecord.type !== "dir") {
      throw new FsError("ENOENT", toParent, "rename");
    }
    const moveTree = (sourcePath: string, targetPath: string): void => {
      const source = this.nodes.get(sourcePath);
      if (!source) return;
      const childPaths = this.children.get(sourcePath);
      const moved: VfsRecord = {
        ...source,
        path: targetPath,
        parent: dirname(targetPath),
        mtimeMs: Date.now(),
      };
      this.unindexRecord(sourcePath);
      this.markDirty(sourcePath, true);
      this.indexRecord(moved);
      this.markDirty(targetPath, false);
      if (childPaths) {
        for (const childPath of [...childPaths]) {
          moveTree(childPath, `${targetPath}/${basename(childPath)}`);
        }
      }
    };
    const replaced = this.nodes.get(to);
    if (replaced) {
      this.rm(to);
    }
    moveTree(from, to);
    this.emitChange({ kind: record.type === "dir" ? "unlinkDir" : "unlink", path: from });
    this.emitChange({ kind: record.type === "dir" ? "addDir" : "add", path: to });
  }

  listChildren(path: string): VfsRecord[] {
    const normalized = normalizePath(path);
    const childPaths = this.children.get(normalized);
    if (!childPaths) return [];
    const records: VfsRecord[] = [];
    for (const childPath of childPaths) {
      const record = this.nodes.get(childPath);
      if (record) records.push(record);
    }
    return records;
  }

  /** Approximate recursive byte size for quota reporting. */
  du(path: string): number {
    const normalized = normalizePath(path);
    const record = this.nodes.get(normalized);
    if (!record) return 0;
    if (record.type === "file") return record.data?.byteLength ?? 0;
    let total = 0;
    for (const child of this.listChildren(normalized)) {
      total += this.du(child.path);
    }
    return total;
  }
}

/**
 * `fs.promises`-shaped facade over the VFS, compatible with isomorphic-git's
 * `PromiseFsClient` contract (plus a couple of extras our shims use).
 */
export type PromisesFs = {
  readFile(
    path: string,
    options?: { encoding?: "utf8" } | "utf8"
  ): Promise<Uint8Array | string>;
  writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { mode?: number; encoding?: "utf8" } | "utf8"
  ): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rmdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<VfsStats>;
  lstat(path: string): Promise<VfsStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
};

export function createPromisesFs(vfs: Vfs): { promises: PromisesFs } {
  const promises: PromisesFs = {
    async readFile(path, options) {
      const encoding = typeof options === "string" ? options : options?.encoding;
      const bytes = vfs.readFile(path);
      return encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes;
    },
    async writeFile(path, data, options) {
      const mode = typeof options === "object" && options ? options.mode : undefined;
      vfs.writeFile(path, data, mode !== undefined ? { mode } : undefined);
    },
    async unlink(path) {
      vfs.unlink(path);
    },
    async readdir(path) {
      return vfs.readDir(path);
    },
    async mkdir(path, options) {
      vfs.mkdir(path, options?.recursive ? { recursive: true } : undefined);
    },
    async rmdir(path) {
      vfs.rmdir(path);
    },
    async rm(path, options) {
      if (options?.recursive) {
        vfs.rm(path);
        return;
      }
      const record = vfs.getRecord(path);
      if (!record) {
        if (options?.force) return;
        throw new FsError("ENOENT", path, "rm");
      }
      if (record.type === "dir") {
        vfs.rmdir(path);
      } else {
        vfs.unlink(path);
      }
    },
    async stat(path) {
      return vfs.stat(path);
    },
    async lstat(path) {
      return vfs.lstat(path);
    },
    async readlink(path) {
      return vfs.readlink(path);
    },
    async symlink(target, path) {
      vfs.symlink(target, path);
    },
    async rename(from, to) {
      vfs.rename(from, to);
    },
  };
  return { promises };
}
