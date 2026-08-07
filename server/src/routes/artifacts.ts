import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  listArtifacts,
  readArtifact,
  resolveArtifactFilePath,
} from "../lib/artifacts/store.js";
import { inferMimeType } from "../lib/workspace.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";

export const artifactRoutes = new Hono();

/** JSON APIs (header-authenticated like the rest of /api). */

artifactRoutes.get("/api/workspaces/:workspaceId/artifacts", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const artifacts = await listArtifacts({
    workspaceRoot: workspace.root,
    workspaceId: workspace.id,
  });
  return c.json({ artifacts });
});

artifactRoutes.get("/api/workspaces/:workspaceId/artifacts/:artifactId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const artifact = await readArtifact({
    workspaceRoot: workspace.root,
    workspaceId: workspace.id,
    artifactId: c.req.param("artifactId"),
  });
  if (!artifact) {
    return c.json({ error: "Artifact not found." }, 404);
  }
  return c.json({ artifact });
});

/**
 * Iframe-navigable content routes. These cannot attach auth headers, so when
 * auth is enabled they accept `?access_token=` the same way `/browser/*` does
 * (see `isBrowserSurfacePath` in lib/auth.ts).
 */

const require_ = createRequire(import.meta.url);

function chartRuntimeCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "../../node_modules/chart.js/dist/chart.umd.js"),
    path.resolve(here, "../../../node_modules/chart.js/dist/chart.umd.js"),
  ];
}

let cachedChartRuntime: Buffer | null = null;

async function loadChartRuntime(): Promise<Buffer | null> {
  if (cachedChartRuntime) {
    return cachedChartRuntime;
  }
  try {
    cachedChartRuntime = await fs.readFile(require_.resolve("chart.js/dist/chart.umd.js"));
    return cachedChartRuntime;
  } catch {
    // exports-map or hoisting differences — fall back to direct node_modules paths
  }
  for (const candidate of chartRuntimeCandidates()) {
    try {
      cachedChartRuntime = await fs.readFile(candidate);
      return cachedChartRuntime;
    } catch {
      // try next candidate
    }
  }
  return null;
}

artifactRoutes.get("/artifacts/_runtime/chart.umd.js", async (c) => {
  const runtime = await loadChartRuntime();
  if (!runtime) {
    return c.json({ error: "Chart.js runtime is not installed on this server." }, 404);
  }
  return new Response(new Uint8Array(runtime), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
});

artifactRoutes.get("/artifacts/:workspaceId/:artifactId", (c) => {
  const url = new URL(c.req.url);
  return c.redirect(`${url.pathname}/${url.search}`, 301);
});

async function serveArtifactFile(input: {
  workspaceId: string;
  artifactId: string;
  filePath: string | null;
}): Promise<Response> {
  const workspace = await getWorkspaceById(input.workspaceId);
  if (!workspace) {
    return Response.json({ error: "Unknown workspace." }, { status: 404 });
  }
  const artifact = await readArtifact({
    workspaceRoot: workspace.root,
    workspaceId: workspace.id,
    artifactId: input.artifactId,
  });
  if (!artifact) {
    return Response.json({ error: "Artifact not found." }, { status: 404 });
  }
  const relativePath = input.filePath?.trim() || artifact.entry;
  let absolutePath: string;
  try {
    absolutePath = resolveArtifactFilePath(workspace.root, artifact.id, relativePath);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid path." },
      { status: 400 }
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolutePath);
  } catch {
    return Response.json({ error: `File not found: ${relativePath}` }, { status: 404 });
  }
  const mimeType =
    path.extname(absolutePath) === ""
      ? "application/octet-stream"
      : inferMimeType(absolutePath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mimeType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

artifactRoutes.get("/artifacts/:workspaceId/:artifactId/", async (c) =>
  serveArtifactFile({
    workspaceId: c.req.param("workspaceId"),
    artifactId: c.req.param("artifactId"),
    filePath: null,
  })
);

artifactRoutes.get("/artifacts/:workspaceId/:artifactId/*", async (c) => {
  const url = new URL(c.req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const rest = segments.slice(3).map((segment) => decodeURIComponent(segment)).join("/");
  return serveArtifactFile({
    workspaceId: c.req.param("workspaceId"),
    artifactId: c.req.param("artifactId"),
    filePath: rest || null,
  });
});
