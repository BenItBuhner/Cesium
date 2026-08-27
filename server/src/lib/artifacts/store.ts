import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Agent-generated artifacts (charts, HTML pages, mini web projects) live under
 * the per-workspace `.cesium/` data directory so they persist across sessions
 * and stay out of version control (`.cesium/` is auto-gitignored).
 */
export const CESIUM_ARTIFACTS_DIR = ".cesium/artifacts";

export type ArtifactKind = "chart" | "html" | "project";

export type ArtifactMeta = {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: ArtifactKind;
  description?: string;
  /** Entry file served at the artifact root URL (relative to files/). */
  entry: string;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactSummary = ArtifactMeta & {
  /** Server-relative view path, e.g. `/artifacts/<workspaceId>/<artifactId>/`. */
  serverPath: string;
  files: string[];
};

const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_FILES_PER_ARTIFACT = 128;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

/** Chart.js runtime is served locally by the Cesium server (no CDN needed). */
export const ARTIFACT_CHART_RUNTIME_PATH = "/artifacts/_runtime/chart.umd.js";

export function artifactServerPath(workspaceId: string, artifactId: string): string {
  return `/artifacts/${encodeURIComponent(workspaceId)}/${encodeURIComponent(artifactId)}/`;
}

export function isValidArtifactId(id: string): boolean {
  return ARTIFACT_ID_PATTERN.test(id);
}

function slugifyArtifactTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "artifact";
}

export function newArtifactId(title: string): string {
  return `${slugifyArtifactTitle(title)}-${randomBytes(3).toString("hex")}`;
}

function artifactsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, CESIUM_ARTIFACTS_DIR);
}

export function artifactDir(workspaceRoot: string, artifactId: string): string {
  if (!isValidArtifactId(artifactId)) {
    throw new Error(`Invalid artifact id: ${artifactId}`);
  }
  return path.join(artifactsRoot(workspaceRoot), artifactId);
}

function artifactFilesDir(workspaceRoot: string, artifactId: string): string {
  return path.join(artifactDir(workspaceRoot, artifactId), "files");
}

function metaPath(workspaceRoot: string, artifactId: string): string {
  return path.join(artifactDir(workspaceRoot, artifactId), "artifact.json");
}

/** Resolve an artifact-relative file path, rejecting traversal outside files/. */
export function resolveArtifactFilePath(
  workspaceRoot: string,
  artifactId: string,
  relativePath: string
): string {
  const filesDir = artifactFilesDir(workspaceRoot, artifactId);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Invalid artifact file path: ${relativePath}`);
  }
  const resolved = path.resolve(filesDir, normalized);
  const rel = path.relative(filesDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Artifact file path escapes the artifact: ${relativePath}`);
  }
  return resolved;
}

/** Append `.cesium/` to the workspace .gitignore when missing (same policy as worktrees). */
export async function ensureCesiumDirGitignored(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".cesium/") || lines.includes("/.cesium/") || lines.includes(".cesium")) {
    return;
  }
  const needsLeadingNewline = current.length > 0 && !current.endsWith("\n");
  const prefix = needsLeadingNewline ? "\n" : "";
  await fs.appendFile(
    gitignorePath,
    `${prefix}\n# Cesium local data (plans, artifacts, worktrees)\n.cesium/\n`,
    "utf8"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap a Chart.js config in a self-contained responsive page. The chart fills
 * the iframe/tab viewport at any size (inline chat card, editor tab, mobile).
 */
export function buildChartArtifactHtml(title: string, chartConfigJson: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="${ARTIFACT_CHART_RUNTIME_PATH}"></script>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: transparent; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #chart-shell { position: absolute; inset: 0; padding: 12px; box-sizing: border-box; }
  #chart-error { display: none; padding: 16px; font-size: 13px; color: #b91c1c; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="chart-shell"><canvas id="chart"></canvas></div>
<pre id="chart-error"></pre>
<script id="chart-config" type="application/json">
${chartConfigJson}
</script>
<script>
(function () {
  try {
    var config = JSON.parse(document.getElementById("chart-config").textContent);
    config.options = config.options || {};
    if (config.options.responsive === undefined) config.options.responsive = true;
    if (config.options.maintainAspectRatio === undefined) config.options.maintainAspectRatio = false;
    new Chart(document.getElementById("chart"), config);
  } catch (error) {
    var el = document.getElementById("chart-error");
    el.style.display = "block";
    el.textContent = "Failed to render chart: " + (error && error.message ? error.message : String(error));
  }
})();
</script>
</body>
</html>
`;
}

/** Wrap an HTML fragment (no <html> tag) in a minimal responsive document. */
export function wrapHtmlFragment(title: string, fragment: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 16px; box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
</style>
</head>
<body>
${fragment}
</body>
</html>
`;
}

function normalizeHtmlDocument(title: string, html: string): string {
  return /<html[\s>]/i.test(html) ? html : wrapHtmlFragment(title, html);
}

async function readMetaFile(workspaceRoot: string, artifactId: string): Promise<ArtifactMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(workspaceRoot, artifactId), "utf8");
    const parsed = JSON.parse(raw) as ArtifactMeta;
    if (parsed?.schemaVersion !== 1 || parsed.id !== artifactId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeMetaFile(workspaceRoot: string, meta: ArtifactMeta): Promise<void> {
  await fs.mkdir(artifactDir(workspaceRoot, meta.id), { recursive: true });
  await fs.writeFile(metaPath(workspaceRoot, meta.id), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function listArtifactFilePaths(workspaceRoot: string, artifactId: string): Promise<string[]> {
  const filesDir = artifactFilesDir(workspaceRoot, artifactId);
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES_PER_ARTIFACT) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        results.push(path.relative(filesDir, absolute).replace(/\\/g, "/"));
      }
    }
  }
  await walk(filesDir);
  return results.sort();
}

function assertFilePayload(files: Record<string, string>): void {
  const names = Object.keys(files);
  if (names.length === 0) {
    throw new Error("Expected at least one file.");
  }
  if (names.length > MAX_FILES_PER_ARTIFACT) {
    throw new Error(`Too many files (max ${MAX_FILES_PER_ARTIFACT}).`);
  }
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`File too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB): ${name}`);
    }
    total += bytes;
  }
  if (total > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact too large (max ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB total).`);
  }
}

async function writeArtifactFiles(
  workspaceRoot: string,
  artifactId: string,
  files: Record<string, string>
): Promise<void> {
  assertFilePayload(files);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = resolveArtifactFilePath(workspaceRoot, artifactId, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

export type CreateArtifactInput = {
  workspaceRoot: string;
  workspaceId: string;
  kind: ArtifactKind;
  title: string;
  description?: string;
  /** Chart.js config (object or JSON string) - required for kind=chart. */
  chart?: unknown;
  /** HTML document or fragment - required for kind=html. */
  html?: string;
  /** File map (path → content) - required for kind=project. */
  files?: Record<string, string>;
  /** Entry file for kind=project (default index.html). */
  entry?: string;
};

function chartConfigToJson(chart: unknown): string {
  if (typeof chart === "string") {
    const trimmed = chart.trim();
    JSON.parse(trimmed);
    return trimmed;
  }
  if (chart && typeof chart === "object") {
    return JSON.stringify(chart, null, 2);
  }
  throw new Error("Expected chart to be a Chart.js config object or JSON string.");
}

function buildContentFiles(input: {
  kind: ArtifactKind;
  title: string;
  chart?: unknown;
  html?: string;
  files?: Record<string, string>;
  entry?: string;
}): { files: Record<string, string>; entry: string } {
  if (input.kind === "chart") {
    if (input.chart === undefined || input.chart === null) {
      throw new Error("kind=chart requires a chart config (Chart.js config object or JSON string).");
    }
    const configJson = chartConfigToJson(input.chart);
    return {
      files: {
        "chart.json": `${configJson}\n`,
        "index.html": buildChartArtifactHtml(input.title, configJson),
      },
      entry: "index.html",
    };
  }
  if (input.kind === "html") {
    if (typeof input.html !== "string" || !input.html.trim()) {
      throw new Error("kind=html requires non-empty html content.");
    }
    return {
      files: { "index.html": normalizeHtmlDocument(input.title, input.html) },
      entry: "index.html",
    };
  }
  if (!input.files || Object.keys(input.files).length === 0) {
    throw new Error("kind=project requires a files map (path → content).");
  }
  const entry = (input.entry?.trim() || "index.html").replace(/^\/+/, "");
  if (!Object.keys(input.files).includes(entry)) {
    throw new Error(`Project files must include the entry file (${entry}).`);
  }
  return { files: input.files, entry };
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactSummary> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Artifact title is required.");
  }
  const content = buildContentFiles({ ...input, title });
  const id = newArtifactId(title);
  const now = Date.now();
  const meta: ArtifactMeta = {
    schemaVersion: 1,
    id,
    title,
    kind: input.kind,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    entry: content.entry,
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(artifactFilesDir(input.workspaceRoot, id), { recursive: true });
  await writeArtifactFiles(input.workspaceRoot, id, content.files);
  await writeMetaFile(input.workspaceRoot, meta);
  await ensureCesiumDirGitignored(input.workspaceRoot).catch(() => undefined);
  return {
    ...meta,
    serverPath: artifactServerPath(input.workspaceId, id),
    files: await listArtifactFilePaths(input.workspaceRoot, id),
  };
}

export type UpdateArtifactInput = {
  workspaceRoot: string;
  workspaceId: string;
  artifactId: string;
  title?: string;
  description?: string;
  /** Replaces the chart config for kind=chart (regenerates index.html). */
  chart?: unknown;
  /** Replaces index.html for kind=html. */
  html?: string;
  /** Upserts files for any kind (path → content). */
  files?: Record<string, string>;
  /** Deletes files by path. */
  deletePaths?: string[];
  entry?: string;
};

export async function updateArtifact(input: UpdateArtifactInput): Promise<ArtifactSummary> {
  const meta = await readMetaFile(input.workspaceRoot, input.artifactId);
  if (!meta) {
    throw new Error(`Unknown artifact: ${input.artifactId}`);
  }
  const title = input.title?.trim() || meta.title;

  if (input.chart !== undefined && input.chart !== null) {
    const configJson = chartConfigToJson(input.chart);
    await writeArtifactFiles(input.workspaceRoot, meta.id, {
      "chart.json": `${configJson}\n`,
      "index.html": buildChartArtifactHtml(title, configJson),
    });
  }
  if (typeof input.html === "string" && input.html.trim()) {
    await writeArtifactFiles(input.workspaceRoot, meta.id, {
      "index.html": normalizeHtmlDocument(title, input.html),
    });
  }
  if (input.files && Object.keys(input.files).length > 0) {
    await writeArtifactFiles(input.workspaceRoot, meta.id, input.files);
  }
  for (const relativePath of input.deletePaths ?? []) {
    const absolute = resolveArtifactFilePath(input.workspaceRoot, meta.id, relativePath);
    await fs.rm(absolute, { force: true });
  }

  const nextMeta: ArtifactMeta = {
    ...meta,
    title,
    ...(input.description !== undefined
      ? input.description.trim()
        ? { description: input.description.trim() }
        : {}
      : meta.description
        ? { description: meta.description }
        : {}),
    entry: input.entry?.trim().replace(/^\/+/, "") || meta.entry,
    updatedAt: Date.now(),
  };
  await writeMetaFile(input.workspaceRoot, nextMeta);
  return {
    ...nextMeta,
    serverPath: artifactServerPath(input.workspaceId, meta.id),
    files: await listArtifactFilePaths(input.workspaceRoot, meta.id),
  };
}

export async function readArtifact(input: {
  workspaceRoot: string;
  workspaceId: string;
  artifactId: string;
}): Promise<ArtifactSummary | null> {
  const meta = await readMetaFile(input.workspaceRoot, input.artifactId);
  if (!meta) {
    return null;
  }
  return {
    ...meta,
    serverPath: artifactServerPath(input.workspaceId, meta.id),
    files: await listArtifactFilePaths(input.workspaceRoot, meta.id),
  };
}

export async function readArtifactFile(input: {
  workspaceRoot: string;
  artifactId: string;
  path: string;
}): Promise<string> {
  const absolute = resolveArtifactFilePath(input.workspaceRoot, input.artifactId, input.path);
  return await fs.readFile(absolute, "utf8");
}

export async function listArtifacts(input: {
  workspaceRoot: string;
  workspaceId: string;
}): Promise<ArtifactSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(artifactsRoot(input.workspaceRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: ArtifactSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidArtifactId(entry.name)) {
      continue;
    }
    const summary = await readArtifact({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      artifactId: entry.name,
    });
    if (summary) {
      summaries.push(summary);
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteArtifact(input: {
  workspaceRoot: string;
  artifactId: string;
}): Promise<boolean> {
  const dir = artifactDir(input.workspaceRoot, input.artifactId);
  const meta = await readMetaFile(input.workspaceRoot, input.artifactId);
  if (!meta) {
    return false;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
