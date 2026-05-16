import { promises as fs } from "node:fs";
import path from "node:path";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import {
  DATA_DIR,
  readJsonFile,
  writeJsonFile,
} from "./persistence.js";
import {
  assertGitRemoteUrlAllowed,
  inferCloneDirectoryName,
} from "./git-workspace.js";
import {
  ensureWorkspaceRegistered,
  getWorkspaceById,
  setDefaultWorkspace,
  type WorkspaceRecord,
} from "./workspace-registry.js";

const REMOTE_GIT_CLONE_TIMEOUT_MS = 900_000;

const SSH_WORKSPACE_STORE = path.join(DATA_DIR, "ssh-workspaces.json");
const SSH_MIRROR_ROOT = path.join(DATA_DIR, "ssh-workspaces");
const SYNC_DEBOUNCE_MS = 2_000;

export type SshWorkspaceMetadata = {
  schemaVersion: 1;
  workspaceId: string;
  target: string;
  user: string | null;
  host: string;
  port: number | null;
  remotePath: string;
  localRoot: string;
  keyPath: string | null;
  createdAt: number;
  updatedAt: number;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
};

type StoredSshWorkspaceMetadata = SshWorkspaceMetadata & {
  password: string | null;
};

type SshWorkspaceStore = {
  schemaVersion: 1;
  workspaces: StoredSshWorkspaceMetadata[];
};

type ParsedSshTarget = {
  target: string;
  user: string | null;
  host: string;
  port: number | null;
};

type SshConnectionInput = {
  target: string;
  port?: number;
  keyPath?: string;
  password?: string;
};

export type CreateSshWorkspaceInput = SshConnectionInput & {
  remotePath: string;
  name?: string;
  mirrorName?: string;
  setDefault?: boolean;
};

export type BrowseSshWorkspaceInput = SshConnectionInput & {
  remotePath?: string;
};

export type ProbeSshConnectionResult = {
  ok: true;
  target: string;
  username: string;
  host: string;
  port: number | null;
};

export type CloneRemoteGitOverSshInput = SshConnectionInput & {
  repoUrl: string;
  /** Remote directory that will contain the cloned folder (pwd-relative `.` ok). */
  parentRemotePath: string;
  directoryName?: string;
};

export type SshDirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: Array<{ name: string; path: string }>;
};

const pendingPushes = new Map<string, NodeJS.Timeout>();

function defaultStore(): SshWorkspaceStore {
  return {
    schemaVersion: 1,
    workspaces: [],
  };
}

function toPublicMetadata(
  metadata: StoredSshWorkspaceMetadata
): SshWorkspaceMetadata {
  const { password, ...publicMetadata } = metadata;
  void password;
  return publicMetadata;
}

function normalizePort(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return null;
  }
  if (raw <= 0 || raw > 65535) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  return raw;
}

function parseSshTarget(rawTarget: string, explicitPort?: number): ParsedSshTarget {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    throw new Error("SSH target is required.");
  }

  if (/\s/.test(trimmed)) {
    throw new Error("SSH target must not contain spaces.");
  }

  if (trimmed.startsWith("ssh://")) {
    const url = new URL(trimmed);
    const host = url.hostname.trim();
    if (!host) {
      throw new Error("SSH target is missing a host.");
    }
    const user = decodeURIComponent(url.username || "").trim() || null;
    const port = explicitPort ?? (url.port ? Number.parseInt(url.port, 10) : null);
    return {
      target: user ? `${user}@${host}` : host,
      user,
      host,
      port: normalizePort(port),
    };
  }

  const atIndex = trimmed.lastIndexOf("@");
  const user = atIndex > 0 ? trimmed.slice(0, atIndex) : null;
  const host = atIndex > 0 ? trimmed.slice(atIndex + 1) : trimmed;
  if (!host || host.includes("@")) {
    throw new Error("SSH target must look like user@host or ssh://user@host.");
  }
  if (host.includes(":")) {
    throw new Error("Use the Port field for non-standard SSH ports.");
  }

  return {
    target: user ? `${user}@${host}` : host,
    user,
    host,
    port: normalizePort(explicitPort),
  };
}

function normalizeRemotePath(rawPath: string | undefined): string {
  const trimmed = rawPath?.trim() || ".";
  return path.posix.normalize(trimmed.replace(/\\/g, "/"));
}

function remoteParentPath(remotePath: string): string | null {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === "/" || normalized === ".") {
    return null;
  }
  const parent = path.posix.dirname(normalized);
  return parent === normalized ? null : parent;
}

function remoteJoin(parent: string, child: string): string {
  if (parent === "/") {
    return `/${child}`;
  }
  return path.posix.join(parent, child);
}

function sanitizePathSegment(raw: string): string {
  return (
    raw
      .trim()
      .replace(/\\/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "remote"
  );
}

function deriveMirrorName(input: {
  target: string;
  remotePath: string;
  mirrorName?: string;
}): string {
  const preferred = input.mirrorName?.trim();
  if (preferred) {
    return sanitizePathSegment(preferred);
  }
  const base = path.posix.basename(input.remotePath.replace(/\\/g, "/")) || "workspace";
  return sanitizePathSegment(`${input.target}-${base}`);
}

async function readStore(): Promise<SshWorkspaceStore> {
  const raw = await readJsonFile<SshWorkspaceStore>(
    SSH_WORKSPACE_STORE,
    defaultStore()
  );
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.workspaces)) {
    return defaultStore();
  }
  return {
    schemaVersion: 1,
    workspaces: raw.workspaces.flatMap((item): StoredSshWorkspaceMetadata[] => {
      if (!item || item.schemaVersion !== 1 || typeof item.workspaceId !== "string") {
        return [];
      }
      return [
        {
          ...item,
          password: typeof item.password === "string" ? item.password : null,
        },
      ];
    }),
  };
}

async function writeStore(store: SshWorkspaceStore): Promise<void> {
  await writeJsonFile(SSH_WORKSPACE_STORE, store);
}

async function saveStoredMetadata(
  metadata: StoredSshWorkspaceMetadata
): Promise<StoredSshWorkspaceMetadata> {
  const store = await readStore();
  const next = {
    schemaVersion: 1 as const,
    workspaces: [
      ...store.workspaces.filter((item) => item.workspaceId !== metadata.workspaceId),
      metadata,
    ],
  };
  await writeStore(next);
  return metadata;
}

async function getStoredMetadata(
  workspaceId: string
): Promise<StoredSshWorkspaceMetadata | null> {
  const store = await readStore();
  return store.workspaces.find((item) => item.workspaceId === workspaceId) ?? null;
}

export async function getSshWorkspaceMetadata(
  workspaceId: string
): Promise<SshWorkspaceMetadata | null> {
  const metadata = await getStoredMetadata(workspaceId);
  return metadata ? toPublicMetadata(metadata) : null;
}

async function buildConnectConfig(input: {
  parsedTarget: ParsedSshTarget;
  keyPath?: string | null;
  password?: string | null;
}): Promise<ConnectConfig> {
  const username = resolveConfiguredUsername(input.parsedTarget);

  const config: ConnectConfig = {
    host: input.parsedTarget.host,
    username,
    port: input.parsedTarget.port ?? 22,
    readyTimeout: 20_000,
    keepaliveInterval: 30_000,
  };

  if (input.keyPath) {
    config.privateKey = await fs.readFile(input.keyPath, "utf8");
  }
  if (input.password) {
    config.password = input.password;
  }
  if (!config.privateKey && !config.password) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }

  return config;
}

async function withSsh<T>(
  input: {
    parsedTarget: ParsedSshTarget;
    keyPath?: string | null;
    password?: string | null;
  },
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const config = await buildConnectConfig(input);
  const client = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      client
        .once("ready", resolve)
        .once("error", reject)
        .connect(config);
    });
    return await fn(client);
  } finally {
    client.end();
  }
}

function resolveConfiguredUsername(parsedTarget: ParsedSshTarget): string {
  const username = parsedTarget.user ?? process.env.USER ?? process.env.USERNAME;
  if (!username) {
    throw new Error("SSH username is required.");
  }
  return username;
}

function posixShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshExec(
  client: Client,
  command: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const execPromise = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on(
          "close",
          (
            code: number | undefined | null,
            _signal: NodeJS.Signals | undefined
          ) => {
            resolve({ code: code ?? null, stdout, stderr });
          }
        );
        stream.on("data", (data: Buffer) => {
          stdout += data.toString("utf8");
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf8");
        });
      });
    }
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(`Remote command timed out after ${Math.round(timeoutMs / 1000)}s.`)
      );
    }, timeoutMs);
  });

  return await Promise.race([execPromise, timeoutPromise]);
}

async function openSftp(client: Client): Promise<SFTPWrapper> {
  return await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(sftp);
    });
  });
}

async function sftpStat(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ isDirectory: () => boolean } | null> {
  return await new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOENT" || code === "2" || code === 2) {
          resolve(null);
          return;
        }
        reject(error);
        return;
      }
      resolve(stats);
    });
  });
}

async function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "EEXIST" || code === "4" || code === 4) {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function ensureRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<void> {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === "." || normalized === "/") {
    return;
  }
  const parent = remoteParentPath(normalized);
  if (parent) {
    await ensureRemoteDirectory(sftp, parent);
  }
  const stat = await sftpStat(sftp, normalized);
  if (stat?.isDirectory()) {
    return;
  }
  await sftpMkdir(sftp, normalized);
}

async function sftpReaddir(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<Array<{ filename: string; attrs: { isDirectory: () => boolean } }>> {
  return await new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(list);
    });
  });
}

async function sftpFastGet(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sftpFastPut(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function sftpRmdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function emptyLocalDirectory(localPath: string): Promise<void> {
  await fs.rm(localPath, { recursive: true, force: true });
  await fs.mkdir(localPath, { recursive: true });
}

async function emptyRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<void> {
  await ensureRemoteDirectory(sftp, remotePath);
  const entries = await sftpReaddir(sftp, remotePath);
  await Promise.all(
    entries
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map(async (entry) => {
        const child = remoteJoin(remotePath, entry.filename);
        if (entry.attrs.isDirectory()) {
          await emptyRemoteDirectory(sftp, child);
          await sftpRmdir(sftp, child);
          return;
        }
        await sftpUnlink(sftp, child);
      })
  );
}

async function downloadRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string
): Promise<void> {
  await fs.mkdir(localPath, { recursive: true });
  const entries = await sftpReaddir(sftp, remotePath);
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") {
      continue;
    }
    const remoteChild = remoteJoin(remotePath, entry.filename);
    const localChild = path.join(localPath, entry.filename);
    if (entry.attrs.isDirectory()) {
      await downloadRemoteDirectory(sftp, remoteChild, localChild);
      continue;
    }
    await fs.mkdir(path.dirname(localChild), { recursive: true });
    await sftpFastGet(sftp, remoteChild, localChild);
  }
}

async function uploadLocalDirectory(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string
): Promise<void> {
  await ensureRemoteDirectory(sftp, remotePath);
  const entries = await fs.readdir(localPath, { withFileTypes: true });
  for (const entry of entries) {
    const localChild = path.join(localPath, entry.name);
    const remoteChild = remoteJoin(remotePath, entry.name);
    if (entry.isDirectory()) {
      await uploadLocalDirectory(sftp, localChild, remoteChild);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await sftpFastPut(sftp, localChild, remoteChild);
  }
}

function parseMetadataTarget(metadata: StoredSshWorkspaceMetadata): ParsedSshTarget {
  return {
    target: metadata.target,
    user: metadata.user,
    host: metadata.host,
    port: metadata.port,
  };
}

async function listSshDirectories(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<SshDirectoryListing> {
  const stat = await sftpStat(sftp, remotePath);
  if (!stat?.isDirectory()) {
    throw new Error(`Remote path is not a directory: ${remotePath}`);
  }
  const entries = await sftpReaddir(sftp, remotePath);
  return {
    currentPath: remotePath,
    parentPath: remoteParentPath(remotePath),
    entries: entries
      .filter(
        (entry) =>
          entry.filename !== "." &&
          entry.filename !== ".." &&
          entry.attrs.isDirectory()
      )
      .map((entry) => ({
        name: entry.filename,
        path: remoteJoin(remotePath, entry.filename),
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      ),
  };
}

async function pullRemoteToLocal(metadata: StoredSshWorkspaceMetadata): Promise<void> {
  await withSsh(
    {
      parsedTarget: parseMetadataTarget(metadata),
      keyPath: metadata.keyPath,
      password: metadata.password,
    },
    async (client) => {
      const sftp = await openSftp(client);
      const remotePath = normalizeRemotePath(metadata.remotePath);
      const stat = await sftpStat(sftp, remotePath);
      if (!stat?.isDirectory()) {
        throw new Error(`Remote path is not a directory: ${remotePath}`);
      }
      await emptyLocalDirectory(metadata.localRoot);
      await downloadRemoteDirectory(sftp, remotePath, metadata.localRoot);
    }
  );
}

async function pushLocalToRemote(metadata: StoredSshWorkspaceMetadata): Promise<void> {
  await withSsh(
    {
      parsedTarget: parseMetadataTarget(metadata),
      keyPath: metadata.keyPath,
      password: metadata.password,
    },
    async (client) => {
      const sftp = await openSftp(client);
      const remotePath = normalizeRemotePath(metadata.remotePath);
      await emptyRemoteDirectory(sftp, remotePath);
      await uploadLocalDirectory(sftp, metadata.localRoot, remotePath);
    }
  );
}

function buildMetadata(input: {
  workspace: WorkspaceRecord;
  parsedTarget: ParsedSshTarget;
  remotePath: string;
  localRoot: string;
  keyPath: string | null;
  password: string | null;
  previous?: StoredSshWorkspaceMetadata | null;
}): StoredSshWorkspaceMetadata {
  const now = Date.now();
  return {
    schemaVersion: 1,
    workspaceId: input.workspace.id,
    target: input.parsedTarget.target,
    user: input.parsedTarget.user,
    host: input.parsedTarget.host,
    port: input.parsedTarget.port,
    remotePath: input.remotePath,
    localRoot: input.localRoot,
    keyPath: input.keyPath,
    password: input.password ?? input.previous?.password ?? null,
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
    lastPulledAt: now,
    lastPushedAt: input.previous?.lastPushedAt ?? null,
  };
}

export async function probeSshConnection(
  input: SshConnectionInput
): Promise<ProbeSshConnectionResult> {
  const parsedTarget = parseSshTarget(input.target, input.port);
  const username = resolveConfiguredUsername(parsedTarget);
  const keyPath = input.keyPath?.trim() ? path.resolve(input.keyPath.trim()) : null;
  const password = input.password?.trim() || null;
  await withSsh(
    { parsedTarget, keyPath, password },
    async (client) => {
      const sftp = await openSftp(client);
      await sftpReaddir(sftp, ".");
    }
  );
  return {
    ok: true,
    target: parsedTarget.target,
    username,
    host: parsedTarget.host,
    port: parsedTarget.port,
  };
}

export async function cloneRemoteGitDirectoryOverSsh(
  input: CloneRemoteGitOverSshInput
): Promise<SshDirectoryListing> {
  assertGitRemoteUrlAllowed(input.repoUrl);

  let dirName = input.directoryName?.trim() ?? "";
  if (!dirName) {
    dirName = inferCloneDirectoryName(input.repoUrl);
  }
  if (
    !dirName ||
    dirName.includes("/") ||
    dirName.includes("\\") ||
    dirName === "." ||
    dirName === ".."
  ) {
    throw new Error("Clone folder name must be a single path segment (no slashes).");
  }

  const parsedTarget = parseSshTarget(input.target, input.port);
  const parentRemotePath = normalizeRemotePath(input.parentRemotePath);
  const keyPath = input.keyPath?.trim() ? path.resolve(input.keyPath.trim()) : null;
  const password = input.password?.trim() || null;

  return await withSsh(
    {
      parsedTarget,
      keyPath,
      password,
    },
    async (client) => {
      const sftp = await openSftp(client);
      const parentStat = await sftpStat(sftp, parentRemotePath);
      if (!parentStat?.isDirectory()) {
        throw new Error(`Remote parent is not a directory: ${parentRemotePath}`);
      }
      const destPath = remoteJoin(parentRemotePath, dirName);
      const existing = await sftpStat(sftp, destPath);
      if (existing) {
        throw new Error(`Remote path already exists: ${destPath}`);
      }

      const cdTarget =
        parentRemotePath === "." ? posixShellSingleQuote(".") : posixShellSingleQuote(parentRemotePath);

      const command = [
        `cd -- ${cdTarget} || exit 2`,
        `if ! command -v git >/dev/null 2>&1; then echo "git not found on remote host" >&2; exit 127; fi`,
        `export GIT_TERMINAL_PROMPT=0`,
        `git clone --depth 1 -- ${posixShellSingleQuote(input.repoUrl.trim())} ${posixShellSingleQuote(dirName)}`,
      ].join("; ");

      const { code, stderr, stdout } = await sshExec(
        client,
        command,
        REMOTE_GIT_CLONE_TIMEOUT_MS
      );

      if (code !== 0) {
        const detail =
          stderr.trim() || stdout.trim() || `git clone failed (exit ${code ?? "unknown"})`;
        throw new Error(detail);
      }

      return listSshDirectories(sftp, parentRemotePath);
    }
  );
}

export async function browseSshDirectories(
  input: BrowseSshWorkspaceInput
): Promise<SshDirectoryListing> {
  const parsedTarget = parseSshTarget(input.target, input.port);
  const remotePath = normalizeRemotePath(input.remotePath);
  const keyPath = input.keyPath?.trim() ? path.resolve(input.keyPath.trim()) : null;
  const password = input.password?.trim() || null;
  return await withSsh(
    {
      parsedTarget,
      keyPath,
      password,
    },
    async (client) => {
      const sftp = await openSftp(client);
      return listSshDirectories(sftp, remotePath);
    }
  );
}

export async function createRemoteSshDirectory(
  input: BrowseSshWorkspaceInput & { directoryName: string }
): Promise<SshDirectoryListing> {
  const name = input.directoryName.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error("Remote directory name must not contain path separators.");
  }
  const parsedTarget = parseSshTarget(input.target, input.port);
  const remotePath = normalizeRemotePath(input.remotePath);
  const keyPath = input.keyPath?.trim() ? path.resolve(input.keyPath.trim()) : null;
  const password = input.password?.trim() || null;
  return await withSsh(
    {
      parsedTarget,
      keyPath,
      password,
    },
    async (client) => {
      const sftp = await openSftp(client);
      await ensureRemoteDirectory(sftp, remoteJoin(remotePath, name));
      return listSshDirectories(sftp, remotePath);
    }
  );
}

export async function createSshWorkspace(input: CreateSshWorkspaceInput): Promise<{
  workspace: WorkspaceRecord;
  metadata: SshWorkspaceMetadata;
}> {
  const parsedTarget = parseSshTarget(input.target, input.port);
  const remotePath = normalizeRemotePath(input.remotePath);
  const keyPath = input.keyPath?.trim() ? path.resolve(input.keyPath.trim()) : null;
  const password = input.password?.trim() || null;
  const localRoot = path.join(
    SSH_MIRROR_ROOT,
    deriveMirrorName({
      target: parsedTarget.target,
      remotePath,
      mirrorName: input.mirrorName,
    })
  );
  await fs.mkdir(localRoot, { recursive: true });

  const temporaryMetadata = buildMetadata({
    workspace: {
      id: "pending",
      name: input.name?.trim() || `${parsedTarget.target}:${remotePath}`,
      root: localRoot,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    },
    parsedTarget,
    remotePath,
    localRoot,
    keyPath,
    password,
  });
  await pullRemoteToLocal(temporaryMetadata);

  const workspace = await ensureWorkspaceRegistered(
    localRoot,
    input.name?.trim() || `${parsedTarget.target}:${remotePath}`
  );
  if (input.setDefault) {
    await setDefaultWorkspace(workspace.id);
  }
  const previous = await getStoredMetadata(workspace.id);
  const metadata = await saveStoredMetadata(
    buildMetadata({
      workspace,
      parsedTarget,
      remotePath,
      localRoot,
      keyPath,
      password,
      previous,
    })
  );
  return { workspace, metadata: toPublicMetadata(metadata) };
}

export async function pullSshWorkspace(workspaceId: string): Promise<SshWorkspaceMetadata> {
  const metadata = await getStoredMetadata(workspaceId);
  if (!metadata) {
    throw new Error(`Workspace is not SSH-backed: ${workspaceId}`);
  }
  await pullRemoteToLocal(metadata);
  const next = await saveStoredMetadata({
    ...metadata,
    updatedAt: Date.now(),
    lastPulledAt: Date.now(),
  });
  return toPublicMetadata(next);
}

export async function pushSshWorkspace(workspaceId: string): Promise<SshWorkspaceMetadata> {
  const metadata = await getStoredMetadata(workspaceId);
  if (!metadata) {
    throw new Error(`Workspace is not SSH-backed: ${workspaceId}`);
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  await pushLocalToRemote({
    ...metadata,
    localRoot: workspace.root,
  });
  const next = await saveStoredMetadata({
    ...metadata,
    localRoot: workspace.root,
    updatedAt: Date.now(),
    lastPushedAt: Date.now(),
  });
  return toPublicMetadata(next);
}

export function scheduleSshWorkspacePush(workspaceId: string): void {
  const existing = pendingPushes.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }
  pendingPushes.set(
    workspaceId,
    setTimeout(() => {
      pendingPushes.delete(workspaceId);
      void pushSshWorkspace(workspaceId).catch((error) => {
        if (
          error instanceof Error &&
          error.message.includes("not SSH-backed")
        ) {
          return;
        }
        console.warn(
          "[ssh-workspace] push failed:",
          error instanceof Error ? error.message : error
        );
      });
    }, SYNC_DEBOUNCE_MS)
  );
}
