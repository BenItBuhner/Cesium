/**
 * `/api/fs/*` implemented against the VFS with response shapes identical to
 * `server/src/routes/fs.ts` (tree nodes, read payloads, search results).
 */
import type { WorkspaceRecord } from "@cesium/core";
import { errorResponse, jsonResponse, type EngineRequest, type EngineRouter } from "../http";
import { inferFileKind, inferLanguage, inferMimeType, isDimmed } from "../lang";
import { basename, resolveSafePath, toRelativePath } from "../paths";
import type { Vfs, VfsRecord } from "../vfs";
import type { WorkspaceStore } from "../stores/workspaces";

type FileNode = {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  dimmed?: boolean;
  hasChildren?: boolean;
  childrenLoaded?: boolean;
};

const MAX_CHILDREN_PER_DIR = 2000;
const LARGE_FILE_BYTES = 512 * 1024;

function compareEntries(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) {
    return a.type === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function readDirectoryChildren(
  vfs: Vfs,
  workspaceRoot: string,
  absoluteDir: string,
  depth: number
): FileNode[] {
  let records: VfsRecord[];
  try {
    records = vfs.listChildren(absoluteDir);
  } catch {
    return [];
  }
  const truncated = records.length > MAX_CHILDREN_PER_DIR;
  const slice = truncated ? records.slice(0, MAX_CHILDREN_PER_DIR) : records;

  const children: FileNode[] = [];
  for (const record of slice) {
    const name = basename(record.path);
    const relativeChildPath = toRelativePath(workspaceRoot, record.path);
    if (relativeChildPath.length === 0) continue;

    if (record.type === "dir") {
      const dimmed = isDimmed(name);
      if (dimmed || depth <= 0) {
        children.push({
          name,
          type: "folder",
          dimmed,
          children: [],
          hasChildren: true,
          childrenLoaded: false,
        });
        continue;
      }
      const grandChildren = readDirectoryChildren(vfs, workspaceRoot, record.path, depth - 1);
      children.push({
        name,
        type: "folder",
        dimmed,
        children: grandChildren,
        hasChildren: grandChildren.length > 0,
        childrenLoaded: true,
      });
      continue;
    }

    children.push({
      name,
      type: "file",
      language: inferLanguage(relativeChildPath),
      dimmed: isDimmed(name),
    });
  }

  const resolved = children.sort(compareEntries);
  if (truncated) {
    resolved.push({
      name: `… (${records.length - MAX_CHILDREN_PER_DIR} more entries hidden)`,
      type: "folder",
      dimmed: true,
      children: [],
      hasChildren: false,
      childrenLoaded: true,
    });
  }
  return resolved;
}

function buildTree(vfs: Vfs, workspaceRoot: string, depth: number): FileNode {
  const children = depth > 0 ? readDirectoryChildren(vfs, workspaceRoot, workspaceRoot, depth - 1) : [];
  return {
    name: basename(workspaceRoot),
    type: "folder",
    children,
    hasChildren: children.length > 0 || depth <= 0,
    childrenLoaded: depth > 0,
  };
}

function collectFileMatches(
  vfs: Vfs,
  workspaceRoot: string,
  query: string,
  glob?: string
): Array<{ path: string; name: string; language: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  const globPattern = glob?.trim() ? globToRegExp(glob.trim()) : null;
  const matches: Array<{ path: string; name: string; language: string; score: number }> = [];

  const walk = (dir: string): void => {
    for (const record of vfs.listChildren(dir)) {
      const name = basename(record.path);
      const relativeChildPath = toRelativePath(workspaceRoot, record.path);
      if (relativeChildPath.length === 0) continue;
      if (record.type === "dir") {
        if (isDimmed(name)) continue;
        walk(record.path);
        continue;
      }
      const lowerName = name.toLowerCase();
      const lowerPath = relativeChildPath.toLowerCase();
      const queryMatch =
        normalizedQuery.length === 0 ||
        lowerName.includes(normalizedQuery) ||
        lowerPath.includes(normalizedQuery);
      const globMatch = !globPattern || globPattern.test(relativeChildPath);
      if (!queryMatch || !globMatch) continue;

      let score = 0;
      if (lowerName === normalizedQuery) score += 1000;
      if (lowerName.startsWith(normalizedQuery)) score += 500;
      if (lowerName.includes(normalizedQuery)) score += 200;
      if (lowerPath.includes(normalizedQuery)) score += 50;
      score -= lowerPath.length;

      matches.push({
        path: relativeChildPath,
        name,
        language: inferLanguage(relativeChildPath),
        score,
      });
    }
  };

  walk(workspaceRoot);
  return matches
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 200)
    .map(({ score, ...rest }) => {
      void score;
      return rest;
    });
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function registerFsRoutes(
  router: EngineRouter,
  deps: { vfs: Vfs; workspaces: WorkspaceStore }
): void {
  const { vfs, workspaces } = deps;

  async function requireWorkspace(request: EngineRequest): Promise<WorkspaceRecord> {
    if (!request.workspaceId) {
      throw new Error("Missing x-opencursor-workspace-id header");
    }
    const workspace = await workspaces.getById(request.workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${request.workspaceId}`);
    }
    return workspace;
  }

  router.get("/api/fs/tree", async (request) => {
    const depthRaw = Number.parseInt(request.url.searchParams.get("depth") ?? "2", 10);
    const depth = Number.isFinite(depthRaw) ? Math.max(0, Math.min(depthRaw, 6)) : 2;
    const workspace = await requireWorkspace(request);
    const tree = buildTree(vfs, workspace.root, depth);
    return jsonResponse({ root: workspace.root, tree });
  });

  router.get("/api/fs/tree/children", async (request) => {
    const workspace = await requireWorkspace(request);
    const relativePath = request.url.searchParams.get("path");
    if (!relativePath) {
      return errorResponse("Missing path query parameter");
    }
    const depthRaw = Number.parseInt(request.url.searchParams.get("depth") ?? "1", 10);
    const depth = Math.max(1, Number.isFinite(depthRaw) ? depthRaw : 1);
    const absolutePath = resolveSafePath(workspace.root, relativePath);
    const stat = vfs.stat(absolutePath);
    if (!stat.isDirectory()) {
      return errorResponse("Path is not a directory");
    }
    const children = readDirectoryChildren(vfs, workspace.root, absolutePath, depth - 1);
    return jsonResponse({ path: relativePath.replace(/\\/g, "/"), children });
  });

  router.get("/api/fs/read", async (request) => {
    const workspace = await requireWorkspace(request);
    const relativePath = request.url.searchParams.get("path");
    if (!relativePath) {
      return errorResponse("Missing path query parameter");
    }
    const absolutePath = resolveSafePath(workspace.root, relativePath);
    const bytes = vfs.readFile(absolutePath);
    const size = bytes.byteLength;
    const fileKind = inferFileKind(absolutePath);
    const mimeType = inferMimeType(absolutePath);
    const previewPath = `/api/fs/raw?path=${encodeURIComponent(relativePath)}`;

    if (fileKind === "image") {
      return jsonResponse({
        content: "",
        language: inferLanguage(absolutePath),
        size,
        fileKind,
        mimeType,
        previewPath,
        readByteOffset: 0,
        readByteLength: 0,
        truncated: false,
        totalSize: size,
      });
    }

    const readFull = request.url.searchParams.get("full") === "1";
    const byteOffsetRaw = request.url.searchParams.get("byteOffset");
    const byteLengthRaw = request.url.searchParams.get("byteLength");

    let start = 0;
    let readLen = size;
    let truncated = false;
    if (
      !readFull &&
      byteOffsetRaw != null &&
      byteLengthRaw != null &&
      Number.isFinite(Number(byteOffsetRaw)) &&
      Number.isFinite(Number(byteLengthRaw))
    ) {
      start = Math.max(0, Math.min(size, Math.floor(Number(byteOffsetRaw))));
      const requested = Math.max(0, Math.floor(Number(byteLengthRaw)));
      readLen = Math.min(requested, size - start);
      truncated = start + readLen < size;
    } else if (!readFull && size > LARGE_FILE_BYTES) {
      readLen = LARGE_FILE_BYTES;
      truncated = true;
    }

    const slice = start === 0 && readLen === size ? bytes : bytes.subarray(start, start + readLen);
    const content = new TextDecoder().decode(slice);
    return jsonResponse({
      content,
      language: inferLanguage(absolutePath),
      size,
      fileKind,
      mimeType,
      previewPath: fileKind === "svg" ? previewPath : undefined,
      readByteOffset: start,
      readByteLength: readLen,
      truncated: start === 0 && readLen === size ? false : truncated,
      totalSize: size,
    });
  });

  router.get("/api/fs/raw", async (request) => {
    const workspace = await requireWorkspace(request);
    const relativePath = request.url.searchParams.get("path");
    if (!relativePath) {
      return errorResponse("Missing path query parameter");
    }
    const absolutePath = resolveSafePath(workspace.root, relativePath);
    const bytes = vfs.readFile(absolutePath);
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body, {
      headers: {
        "content-type": inferMimeType(absolutePath),
        "cache-control": "no-store",
      },
    });
  });

  router.post("/api/fs/write", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<{ path?: string; content?: string; base64?: string }>();
    if (!body.path || (typeof body.content !== "string" && typeof body.base64 !== "string")) {
      return errorResponse("Expected path and content");
    }
    const absolutePath = resolveSafePath(workspace.root, body.path);
    const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/";
    if (!vfs.exists(parent)) {
      vfs.mkdir(parent, { recursive: true });
    }
    const data =
      typeof body.base64 === "string" ? decodeBase64(body.base64) : (body.content as string);
    vfs.writeFile(absolutePath, data);
    const size = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    return jsonResponse({ ok: true, size });
  });

  router.get("/api/fs/stat", async (request) => {
    const workspace = await requireWorkspace(request);
    const relativePath = request.url.searchParams.get("path");
    if (!relativePath) {
      return errorResponse("Missing path query parameter");
    }
    try {
      const absolutePath = resolveSafePath(workspace.root, relativePath);
      const stat = vfs.stat(absolutePath);
      return jsonResponse({
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    } catch {
      return jsonResponse({
        exists: false,
        isFile: false,
        isDirectory: false,
        size: 0,
        mtime: null,
      });
    }
  });

  router.post("/api/fs/mkdir", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<{ path?: string }>();
    if (!body.path) {
      return errorResponse("Expected path");
    }
    const absolutePath = resolveSafePath(workspace.root, body.path);
    vfs.mkdir(absolutePath, { recursive: true });
    return jsonResponse({ ok: true });
  });

  router.post("/api/fs/delete", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<{ path?: string }>();
    if (!body.path) {
      return errorResponse("Expected path");
    }
    const absolutePath = resolveSafePath(workspace.root, body.path);
    vfs.rm(absolutePath);
    return jsonResponse({ ok: true });
  });

  router.post("/api/fs/rename", async (request) => {
    const workspace = await requireWorkspace(request);
    const body = await request.json<{ from?: string; to?: string }>();
    if (!body.from || !body.to) {
      return errorResponse("Expected from and to");
    }
    const fromAbsolutePath = resolveSafePath(workspace.root, body.from);
    const toAbsolutePath = resolveSafePath(workspace.root, body.to);
    const parent = toAbsolutePath.slice(0, toAbsolutePath.lastIndexOf("/")) || "/";
    if (!vfs.exists(parent)) {
      vfs.mkdir(parent, { recursive: true });
    }
    vfs.rename(fromAbsolutePath, toAbsolutePath);
    return jsonResponse({ ok: true });
  });

  router.post("/api/fs/upload", async (request) => {
    const workspace = await requireWorkspace(request);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return errorResponse("Invalid multipart body");
    }
    const relPath = form.get("path");
    const file = form.get("file");
    if (typeof relPath !== "string" || !relPath.trim()) {
      return errorResponse("Expected path field");
    }
    if (!file || typeof file === "string") {
      return errorResponse("Expected file field");
    }
    const absolutePath = resolveSafePath(workspace.root, relPath.trim());
    const parent = absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/";
    if (!vfs.exists(parent)) {
      vfs.mkdir(parent, { recursive: true });
    }
    const bytes = new Uint8Array(await (file as File).arrayBuffer());
    vfs.writeFile(absolutePath, bytes);
    return jsonResponse({ ok: true, size: bytes.byteLength });
  });

  router.get("/api/fs/search", async (request) => {
    const workspace = await requireWorkspace(request);
    const query = request.url.searchParams.get("q") ?? "";
    const glob = request.url.searchParams.get("glob") ?? undefined;
    const matches = collectFileMatches(vfs, workspace.root, query, glob);
    return jsonResponse({ matches, root: workspace.root, name: workspace.name });
  });
}
