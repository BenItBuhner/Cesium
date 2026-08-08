import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Browser walkthrough artifacts (screenshots, demo recordings) are saved inside
 * the workspace so every harness — Cesium Agent, subagents, and external CLI
 * harnesses — can read the same files back with plain filesystem tools.
 */
export const BROWSER_ARTIFACTS_RELATIVE_DIR = path.join("artifacts", "browser");

export type BrowserArtifactRecord = {
  /** Path relative to the workspace root (POSIX separators). */
  relativePath: string;
  absolutePath: string;
  bytes: number;
  mimeType: string;
};

export function browserArtifactsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, BROWSER_ARTIFACTS_RELATIVE_DIR);
}

export async function ensureBrowserArtifactsDir(workspaceRoot: string): Promise<string> {
  const dir = browserArtifactsDir(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  await ensureBrowserArtifactsGitignore(workspaceRoot);
  return dir;
}

async function ensureBrowserArtifactsGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (existing.includes("artifacts/browser/")) {
      return;
    }
    await fs.appendFile(gitignorePath, "\nartifacts/browser/\n", "utf8");
  } catch {
    // no .gitignore — skip
  }
}

export function browserArtifactTimestampSlug(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function sanitizeBrowserArtifactBaseName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

async function uniqueArtifactPath(dir: string, baseName: string, extension: string): Promise<string> {
  let candidate = path.join(dir, `${baseName}.${extension}`);
  for (let suffix = 2; suffix < 100; suffix += 1) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${baseName}-${suffix}.${extension}`);
    } catch {
      return candidate;
    }
  }
  return candidate;
}

export function parseImageDataUrl(imageDataUrl: string): { mimeType: string; data: Buffer } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(imageDataUrl.trim());
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  try {
    return { mimeType: match[1].toLowerCase(), data: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

function extensionForImageMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export async function saveBrowserScreenshotArtifact(input: {
  workspaceRoot: string;
  imageDataUrl: string;
  fileName?: string;
}): Promise<BrowserArtifactRecord | null> {
  const parsed = parseImageDataUrl(input.imageDataUrl);
  if (!parsed || parsed.data.length === 0) {
    return null;
  }
  const dir = await ensureBrowserArtifactsDir(input.workspaceRoot);
  const baseName = sanitizeBrowserArtifactBaseName(
    input.fileName,
    `screenshot-${browserArtifactTimestampSlug()}`
  );
  const absolutePath = await uniqueArtifactPath(dir, baseName, extensionForImageMime(parsed.mimeType));
  await fs.writeFile(absolutePath, parsed.data);
  return {
    relativePath: toRelative(input.workspaceRoot, absolutePath),
    absolutePath,
    bytes: parsed.data.length,
    mimeType: parsed.mimeType,
  };
}

export async function saveBrowserVideoArtifact(input: {
  workspaceRoot: string;
  sourcePath: string;
  fileName?: string;
  mimeType: string;
  extension: string;
}): Promise<BrowserArtifactRecord> {
  const dir = await ensureBrowserArtifactsDir(input.workspaceRoot);
  const baseName = sanitizeBrowserArtifactBaseName(
    input.fileName,
    `recording-${browserArtifactTimestampSlug()}`
  );
  const absolutePath = await uniqueArtifactPath(dir, baseName, input.extension);
  await fs.copyFile(input.sourcePath, absolutePath);
  const stat = await fs.stat(absolutePath);
  return {
    relativePath: toRelative(input.workspaceRoot, absolutePath),
    absolutePath,
    bytes: stat.size,
    mimeType: input.mimeType,
  };
}
