import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import {
  changeWorkspaceRoot,
  inferFileKind,
  getWorkspaceName,
  getWorkspaceRoot,
  inferLanguage,
  inferMimeType,
  isDimmed,
  resolveSafePath,
  shouldIgnorePath,
  toRelativePath,
} from "../lib/workspace.js";
import { broadcastWorkspaceChanged } from "../ws/filewatcher.js";

type FileNode = {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  dimmed?: boolean;
  hasChildren?: boolean;
  childrenLoaded?: boolean;
};

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

async function readDirectoryChildren(
  absoluteDir: string,
  depth: number
): Promise<FileNode[]> {
  const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
  const children = await Promise.all(
    dirents.map(async (dirent): Promise<FileNode | null> => {
      const absoluteChildPath = path.join(absoluteDir, dirent.name);
      const relativeChildPath = toRelativePath(absoluteChildPath);
      if (shouldIgnorePath(relativeChildPath)) {
        return null;
      }

      if (dirent.isDirectory()) {
        const dimmed = isDimmed(dirent.name);
        if (dimmed || depth <= 0) {
          return {
            name: dirent.name,
            type: "folder",
            dimmed,
            children: [],
            hasChildren: true,
            childrenLoaded: false,
          };
        }

        const children = await readDirectoryChildren(absoluteChildPath, depth - 1);
        return {
          name: dirent.name,
          type: "folder",
          dimmed,
          children,
          hasChildren: children.length > 0,
          childrenLoaded: true,
        };
      }

      return {
        name: dirent.name,
        type: "file",
        language: inferLanguage(relativeChildPath),
        dimmed: isDimmed(dirent.name),
      };
    })
  );

  return children.filter((child): child is FileNode => child !== null).sort(compareEntries);
}

async function buildTree(absoluteDir: string, depth: number): Promise<FileNode> {
  const relativePath = toRelativePath(absoluteDir);
  const name = relativePath === "" ? path.basename(getWorkspaceRoot()) : path.basename(absoluteDir);
  const children = depth > 0 ? await readDirectoryChildren(absoluteDir, depth - 1) : [];

  return {
    name,
    type: "folder",
    children,
    hasChildren: children.length > 0 || depth <= 0,
    childrenLoaded: depth > 0,
  };
}

async function collectFileMatches(
  absoluteDir: string,
  query: string,
  glob?: string
): Promise<Array<{ path: string; name: string; language: string }>> {
  const normalizedQuery = query.trim().toLowerCase();
  const globPattern = glob?.trim() ? globToRegExp(glob.trim()) : null;
  const matches: Array<{ path: string; name: string; language: string; score: number }> = [];

  async function walk(currentDir: string): Promise<void> {
    const dirents = await fs.readdir(currentDir, { withFileTypes: true });
    await Promise.all(
      dirents.map(async (dirent) => {
        const absoluteChildPath = path.join(currentDir, dirent.name);
        const relativeChildPath = toRelativePath(absoluteChildPath);
        if (shouldIgnorePath(relativeChildPath)) {
          return;
        }

        if (dirent.isDirectory()) {
          if (isDimmed(dirent.name)) {
            return;
          }
          await walk(absoluteChildPath);
          return;
        }

        const lowerName = dirent.name.toLowerCase();
        const lowerPath = relativeChildPath.toLowerCase();
        const queryMatch =
          normalizedQuery.length === 0 ||
          lowerName.includes(normalizedQuery) ||
          lowerPath.includes(normalizedQuery);
        const globMatch = !globPattern || globPattern.test(relativeChildPath);

        if (!queryMatch || !globMatch) {
          return;
        }

        let score = 0;
        if (lowerName === normalizedQuery) score += 1000;
        if (lowerName.startsWith(normalizedQuery)) score += 500;
        if (lowerName.includes(normalizedQuery)) score += 200;
        if (lowerPath.includes(normalizedQuery)) score += 50;
        score -= lowerPath.length;

        matches.push({
          path: relativeChildPath,
          name: dirent.name,
          language: inferLanguage(relativeChildPath),
          score,
        });
      })
    );
  }

  await walk(absoluteDir);
  return matches
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 200)
    .map(({ score: _score, ...rest }) => rest);
}

export const fsRoutes = new Hono();

fsRoutes.get("/api/fs/tree", async (c) => {
  const depth = Number.parseInt(c.req.query("depth") ?? "10", 10);
  const tree = await buildTree(getWorkspaceRoot(), Number.isFinite(depth) ? depth : 10);
  return c.json({
    root: getWorkspaceRoot(),
    tree,
  });
});

fsRoutes.get("/api/fs/tree/children", async (c) => {
  const relativePath = c.req.query("path");
  if (!relativePath) {
    return c.json({ error: "Missing path query parameter" }, 400);
  }

  const depth = Number.parseInt(c.req.query("depth") ?? "1", 10);
  const absolutePath = resolveSafePath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    return c.json({ error: "Path is not a directory" }, 400);
  }

  const normalizedDepth = Math.max(1, Number.isFinite(depth) ? depth : 1);
  const children = await readDirectoryChildren(
    absolutePath,
    normalizedDepth - 1
  );
  return c.json({
    path: relativePath.replace(/\\/g, "/"),
    children,
  });
});

fsRoutes.get("/api/fs/read", async (c) => {
  const relativePath = c.req.query("path");
  if (!relativePath) {
    return c.json({ error: "Missing path query parameter" }, 400);
  }

  const absolutePath = resolveSafePath(relativePath);
  const stat = await fs.stat(absolutePath);
  const fileKind = inferFileKind(absolutePath);
  const mimeType = inferMimeType(absolutePath);
  const previewPath = `/api/fs/raw?path=${encodeURIComponent(relativePath)}`;

  if (fileKind === "image") {
    return c.json({
      content: "",
      language: inferLanguage(absolutePath),
      size: stat.size,
      fileKind,
      mimeType,
      previewPath,
    });
  }

  const content = await fs.readFile(absolutePath, "utf8");
  return c.json({
    content,
    language: inferLanguage(absolutePath),
    size: stat.size,
    fileKind,
    mimeType,
    previewPath: fileKind === "svg" ? previewPath : undefined,
  });
});

fsRoutes.get("/api/fs/raw", async (c) => {
  const relativePath = c.req.query("path");
  if (!relativePath) {
    return c.json({ error: "Missing path query parameter" }, 400);
  }

  const absolutePath = resolveSafePath(relativePath);
  const bytes = await fs.readFile(absolutePath);
  return new Response(bytes, {
    headers: {
      "content-type": inferMimeType(absolutePath),
      "cache-control": "no-store",
    },
  });
});

fsRoutes.post("/api/fs/write", async (c) => {
  const body = await c.req.json<{ path?: string; content?: string }>();
  if (!body.path || typeof body.content !== "string") {
    return c.json({ error: "Expected path and content" }, 400);
  }

  const absolutePath = resolveSafePath(body.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body.content, "utf8");
  return c.json({ ok: true, size: Buffer.byteLength(body.content, "utf8") });
});

fsRoutes.get("/api/fs/stat", async (c) => {
  const relativePath = c.req.query("path");
  if (!relativePath) {
    return c.json({ error: "Missing path query parameter" }, 400);
  }

  try {
    const absolutePath = resolveSafePath(relativePath);
    const stat = await fs.stat(absolutePath);
    return c.json({
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  } catch {
    return c.json({
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
      mtime: null,
    });
  }
});

fsRoutes.post("/api/fs/mkdir", async (c) => {
  const body = await c.req.json<{ path?: string }>();
  if (!body.path) {
    return c.json({ error: "Expected path" }, 400);
  }

  const absolutePath = resolveSafePath(body.path);
  await fs.mkdir(absolutePath, { recursive: true });
  return c.json({ ok: true });
});

fsRoutes.post("/api/fs/delete", async (c) => {
  const body = await c.req.json<{ path?: string }>();
  if (!body.path) {
    return c.json({ error: "Expected path" }, 400);
  }

  const absolutePath = resolveSafePath(body.path);
  await fs.rm(absolutePath, { recursive: true, force: true });
  return c.json({ ok: true });
});

fsRoutes.post("/api/fs/rename", async (c) => {
  const body = await c.req.json<{ from?: string; to?: string }>();
  if (!body.from || !body.to) {
    return c.json({ error: "Expected from and to" }, 400);
  }

  const fromAbsolutePath = resolveSafePath(body.from);
  const toAbsolutePath = resolveSafePath(body.to);
  await fs.mkdir(path.dirname(toAbsolutePath), { recursive: true });
  await fs.rename(fromAbsolutePath, toAbsolutePath);
  return c.json({ ok: true });
});

fsRoutes.get("/api/fs/search", async (c) => {
  const query = c.req.query("q") ?? "";
  const glob = c.req.query("glob") ?? undefined;
  const matches = await collectFileMatches(getWorkspaceRoot(), query, glob);
  return c.json({ matches });
});

fsRoutes.get("/api/workspace", (c) => {
  return c.json({
    root: getWorkspaceRoot(),
    name: getWorkspaceName(),
  });
});

fsRoutes.post("/api/workspace/open", async (c) => {
  const body = await c.req.json<{ root?: string }>();
  if (!body.root) {
    return c.json({ error: "Expected root" }, 400);
  }

  const root = await changeWorkspaceRoot(body.root);
  await broadcastWorkspaceChanged();
  const tree = await buildTree(root, 10);
  return c.json({
    root,
    name: getWorkspaceName(),
    tree,
  });
});
