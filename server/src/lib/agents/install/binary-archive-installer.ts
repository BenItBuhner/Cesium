import { createWriteStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isExecutableFile } from "../harness-runtime.js";
import {
  acpRegistryPlatformKey,
  binaryArchiveCurrentPointerPath,
  binaryArchiveInstallRoot,
  binaryArchiveVersionDir,
  type AcpRegistryAgentManifest,
  type AcpRegistryBinaryTarget,
  type BinaryArchiveInstallSpec,
} from "./cli-install-registry.js";
import { extractStreamZip } from "./zip-stream.js";

/**
 * Installer for vendor binary archives published through the ACP Registry
 * (currently Google's Antigravity ACP server). Mirrors what Zed's
 * "Install from Registry" does: read `agent.json`, pick the platform target,
 * download the zip, extract it into a versioned directory, and point
 * `current` at it. Everything is confined to `{DATA_DIR}/tools/<name>/`.
 */

export type BinaryArchiveInstallPhase = "manifest" | "download" | "extract" | "finalize";

export type BinaryArchiveInstallEvent =
  | { type: "log"; line: string }
  | {
      type: "progress";
      phase: BinaryArchiveInstallPhase;
      receivedBytes: number;
      totalBytes: number | null;
      percent: number | null;
    };

export type BinaryArchiveInstallResult = {
  executablePath: string;
  version: string;
  installDir: string;
  manifestSource: "registry" | "fallback";
  args: string[];
  skippedDownload: boolean;
};

export type BinaryArchiveInstallOptions = {
  emit?: (event: BinaryArchiveInstallEvent) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Skip the free-space check (tests). */
  skipDiskCheck?: boolean;
  /** Override host platform/arch (tests). */
  platform?: NodeJS.Platform;
  arch?: string;
};

const MANIFEST_TIMEOUT_MS = 15_000;
const ZIP_LIMITS = {
  maxEntries: 5_000,
  // Generous ceiling: the largest known payload is ~2 GB extracted.
  maxUncompressedBytes: 8 * 1024 * 1024 * 1024,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Structural validation of an ACP Registry `agent.json`. */
export function parseAcpRegistryManifest(raw: unknown): AcpRegistryAgentManifest | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { id, name, version, distribution } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof version !== "string") {
    return null;
  }
  if (!isRecord(distribution)) {
    return null;
  }
  const binaryRaw = distribution.binary;
  let binary: Record<string, AcpRegistryBinaryTarget> | undefined;
  if (binaryRaw !== undefined) {
    if (!isRecord(binaryRaw)) {
      return null;
    }
    binary = {};
    for (const [key, target] of Object.entries(binaryRaw)) {
      if (!isRecord(target) || typeof target.archive !== "string" || typeof target.cmd !== "string") {
        return null;
      }
      const args = Array.isArray(target.args)
        ? target.args.filter((item): item is string => typeof item === "string")
        : undefined;
      binary[key] = { archive: target.archive, cmd: target.cmd, ...(args ? { args } : {}) };
    }
  }
  return {
    id,
    name,
    version: version.trim(),
    description: typeof raw.description === "string" ? raw.description : undefined,
    website: typeof raw.website === "string" ? raw.website : undefined,
    authors: Array.isArray(raw.authors)
      ? raw.authors.filter((item): item is string => typeof item === "string")
      : undefined,
    license: typeof raw.license === "string" ? raw.license : undefined,
    distribution: { binary },
  };
}

function assertArchiveHostAllowed(spec: BinaryArchiveInstallSpec, archiveUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(archiveUrl);
  } catch {
    throw new Error(`Manifest archive URL is not valid: ${archiveUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS archive URL: ${archiveUrl}`);
  }
  if (!spec.allowedArchiveHosts.includes(parsed.hostname)) {
    throw new Error(
      `Refusing archive host ${parsed.hostname}; allowed: ${spec.allowedArchiveHosts.join(", ")}`
    );
  }
  return parsed;
}

/**
 * Fetches the live registry manifest; falls back to the pinned copy when the
 * network or the payload is bad. A live manifest whose id differs from the
 * pinned one is rejected (defends against a registry mix-up).
 */
export async function fetchAcpRegistryManifest(
  spec: BinaryArchiveInstallSpec,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<{ manifest: AcpRegistryAgentManifest; source: "registry" | "fallback"; error?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const response = await fetchImpl(spec.manifestUrl, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        manifest: spec.fallbackManifest,
        source: "fallback",
        error: `registry responded ${response.status}`,
      };
    }
    const manifest = parseAcpRegistryManifest(await response.json());
    if (!manifest || manifest.id !== spec.fallbackManifest.id) {
      return {
        manifest: spec.fallbackManifest,
        source: "fallback",
        error: "registry manifest was malformed or for a different agent",
      };
    }
    return { manifest, source: "registry" };
  } catch (error) {
    return {
      manifest: spec.fallbackManifest,
      source: "fallback",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Free bytes on the volume holding `dir` (creating it first), or null when unknown. */
export async function freeBytesAt(dir: string): Promise<number | null> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function resolveTarget(
  spec: BinaryArchiveInstallSpec,
  manifest: AcpRegistryAgentManifest,
  platform: NodeJS.Platform,
  arch: string
): { key: string; target: AcpRegistryBinaryTarget } {
  const key = acpRegistryPlatformKey(platform, arch);
  const target = key ? manifest.distribution.binary?.[key] : undefined;
  if (!key || !target) {
    throw new Error(
      `${spec.label} has no build for ${platform}/${arch} (registry keys: ${Object.keys(
        manifest.distribution.binary ?? {}
      ).join(", ") || "none"}).`
    );
  }
  return { key, target };
}

function resolveCmdPath(installDir: string, cmd: string): string {
  const normalized = cmd.replace(/^\.\//, "");
  const resolved = path.resolve(installDir, normalized);
  const relative = path.relative(installDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Manifest cmd escapes the install directory: ${cmd}`);
  }
  return resolved;
}

async function pointCurrentAt(installRoot: string, versionDir: string, version: string): Promise<void> {
  const link = path.join(installRoot, "current");
  const pointer = binaryArchiveCurrentPointerPath(path.basename(installRoot));
  await fs.rm(link, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.symlink(versionDir, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Symlinks may be unavailable (restricted Windows accounts, odd mounts):
    // fall back to a pointer file that `binaryArchiveCurrentDir` understands.
  }
  await fs.writeFile(
    pointer,
    `${JSON.stringify({ version, dir: versionDir, updatedAt: Date.now() }, null, 2)}\n`,
    "utf8"
  );
}

async function downloadToFile(input: {
  url: URL;
  destination: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  onProgress: (receivedBytes: number, totalBytes: number | null) => void;
}): Promise<void> {
  const response = await input.fetchImpl(input.url, { signal: input.signal, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`.trim());
  }
  const lengthHeader = response.headers.get("content-length");
  const totalBytes = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;
  let receivedBytes = 0;
  let lastEmit = 0;
  const body = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;
    const now = Date.now();
    if (now - lastEmit >= 250) {
      lastEmit = now;
      input.onProgress(receivedBytes, Number.isFinite(totalBytes) ? totalBytes : null);
    }
  });
  await pipeline(body, createWriteStream(input.destination), { signal: input.signal });
  input.onProgress(receivedBytes, Number.isFinite(totalBytes) ? totalBytes : null);
  if (totalBytes !== null && Number.isFinite(totalBytes) && receivedBytes !== totalBytes) {
    throw new Error(`Download truncated: received ${receivedBytes} of ${totalBytes} bytes.`);
  }
}

/**
 * Runs the full install. Re-running for an already-installed version only
 * repoints `current` (no download). Partial downloads live in a `.tmp-*`
 * directory that is removed on failure, so a crash never leaves a half
 * extracted tree where detection could find it.
 */
export async function installBinaryArchive(
  spec: BinaryArchiveInstallSpec,
  options: BinaryArchiveInstallOptions = {}
): Promise<BinaryArchiveInstallResult> {
  const emit = options.emit ?? (() => undefined);
  const fetchImpl = options.fetchImpl ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const signal = options.signal;

  emit({ type: "progress", phase: "manifest", receivedBytes: 0, totalBytes: null, percent: null });
  emit({ type: "log", line: `Fetching ACP Registry manifest ${spec.manifestUrl}` });
  const { manifest, source, error: manifestError } = await fetchAcpRegistryManifest(spec, {
    fetchImpl,
    signal,
  });
  if (source === "fallback") {
    emit({
      type: "log",
      line: `Registry unavailable (${manifestError ?? "unknown"}); using pinned manifest ${spec.fallbackManifest.version}.`,
    });
  } else {
    emit({ type: "log", line: `Registry manifest ${manifest.id}@${manifest.version} (${manifest.license ?? "license unspecified"}, ${(manifest.authors ?? []).join(", ") || "unknown authors"}).` });
  }

  const { key, target } = resolveTarget(spec, manifest, platform, arch);
  const archiveUrl = assertArchiveHostAllowed(spec, target.archive);
  const version = manifest.version;
  const installRoot = binaryArchiveInstallRoot(spec.installDirName);
  const versionDir = binaryArchiveVersionDir(spec.installDirName, version);
  const cmdPath = resolveCmdPath(versionDir, target.cmd);
  const args = target.args ?? [];

  if (isExecutableFile(cmdPath)) {
    emit({ type: "log", line: `${spec.label} ${version} is already installed at ${versionDir}; refreshing the current pointer.` });
    emit({ type: "progress", phase: "finalize", receivedBytes: 0, totalBytes: null, percent: 100 });
    await pointCurrentAt(installRoot, versionDir, version);
    return {
      executablePath: cmdPath,
      version,
      installDir: versionDir,
      manifestSource: source,
      args,
      skippedDownload: true,
    };
  }

  await fs.mkdir(installRoot, { recursive: true });
  if (!options.skipDiskCheck) {
    const free = await freeBytesAt(installRoot);
    const needed = spec.approxDownloadBytes + Math.ceil(spec.approxInstalledBytes * 1.05);
    if (free !== null && free < needed) {
      throw new Error(
        `Not enough free disk space for ${spec.label}: need about ${formatBytes(needed)} (download + extract), have ${formatBytes(free)} at ${installRoot}.`
      );
    }
  }

  const tmpDir = path.join(installRoot, `.tmp-${randomBytes(6).toString("hex")}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, "archive.zip");
  const extractDir = path.join(tmpDir, "extract");
  try {
    emit({ type: "log", line: `Downloading ${archiveUrl.toString()} (${key})` });
    await downloadToFile({
      url: archiveUrl,
      destination: archivePath,
      fetchImpl,
      signal,
      onProgress: (receivedBytes, totalBytes) => {
        emit({
          type: "progress",
          phase: "download",
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null,
        });
      },
    });
    emit({ type: "log", line: `Download complete; extracting to ${versionDir}` });
    emit({ type: "progress", phase: "extract", receivedBytes: 0, totalBytes: null, percent: 0 });
    let lastPercent = -1;
    const entries = await extractStreamZip(archivePath, extractDir, {
      limits: ZIP_LIMITS,
      signal,
      onProgress: ({ writtenBytes, totalBytes }) => {
        const percent = totalBytes > 0 ? Math.round((writtenBytes / totalBytes) * 100) : null;
        if (percent !== lastPercent) {
          lastPercent = percent ?? -1;
          emit({ type: "progress", phase: "extract", receivedBytes: writtenBytes, totalBytes, percent });
        }
      },
    });
    emit({ type: "log", line: `Extracted ${entries.filter((entry) => !entry.isDirectory).length} files.` });
    await fs.rm(archivePath, { force: true }).catch(() => undefined);

    const extractedCmd = resolveCmdPath(extractDir, target.cmd);
    if (!(await fs.stat(extractedCmd).then((stat) => stat.isFile()).catch(() => false))) {
      throw new Error(`Archive did not contain the expected executable ${target.cmd}.`);
    }
    if (platform !== "win32") {
      await fs.chmod(extractedCmd, 0o755).catch(() => undefined);
    }

    emit({ type: "progress", phase: "finalize", receivedBytes: 0, totalBytes: null, percent: null });
    await fs.rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(extractDir, versionDir);
    await fs.writeFile(
      path.join(versionDir, "cesium-install.json"),
      `${JSON.stringify(
        {
          id: manifest.id,
          version,
          platformKey: key,
          archive: archiveUrl.toString(),
          cmd: target.cmd,
          args,
          manifestSource: source,
          installedAt: Date.now(),
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await pointCurrentAt(installRoot, versionDir, version);
    emit({ type: "log", line: `${spec.label} ${version} installed at ${cmdPath}` });
    return {
      executablePath: cmdPath,
      version,
      installDir: versionDir,
      manifestSource: source,
      args,
      skippedDownload: false,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Installed versions under `{tools}/<name>/`, newest mtime first. */
export async function listInstalledBinaryArchiveVersions(
  spec: BinaryArchiveInstallSpec
): Promise<Array<{ version: string; dir: string }>> {
  const root = binaryArchiveInstallRoot(spec.installDirName);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: Array<{ version: string; dir: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (name === "current" || name === "current.json" || name.startsWith(".tmp-")) {
      continue;
    }
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) {
        out.push({ version: name, dir, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // skip
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map(({ version, dir }) => ({ version, dir }));
}
