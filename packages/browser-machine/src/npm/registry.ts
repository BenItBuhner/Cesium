/**
 * Browser npm client. registry.npmjs.org serves metadata and tarballs with
 * CORS headers, so installs run entirely client-side: resolve semver range →
 * fetch tarball → extract into the VFS `node_modules` (hoisted, first-wins).
 */
import { joinPath } from "../paths";
import type { Vfs } from "../vfs";
import { extractTarball } from "../tar";

const REGISTRY_URL = "https://registry.npmjs.org";
const MAX_PACKAGES_PER_INSTALL = 250;

type AbbreviatedVersion = {
  version: string;
  dependencies?: Record<string, string>;
  dist: { tarball: string };
};

type AbbreviatedMetadata = {
  "dist-tags": Record<string, string>;
  versions: Record<string, AbbreviatedVersion>;
};

export type ParsedSemver = [number, number, number, string | null];

export function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ?? null,
  ];
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  // A release beats any prerelease of the same version.
  if (a[3] === null && b[3] !== null) return 1;
  if (a[3] !== null && b[3] === null) return -1;
  return (a[3] ?? "").localeCompare(b[3] ?? "");
}

export function satisfies(version: ParsedSemver, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "latest" || trimmed === "x") {
    return version[3] === null;
  }
  // OR alternatives: any side matching wins.
  if (trimmed.includes("||")) {
    return trimmed.split("||").some((part) => satisfies(version, part));
  }
  // Space-separated AND comparators (e.g. ">=1.2.3 <2").
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return parts.every((part) => satisfies(version, part));
  }
  const single = parts[0] ?? trimmed;
  const comparator = single.match(/^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!comparator) return false;
  const [, op = "", majorRaw, minorRaw, patchRaw] = comparator;
  const major = Number(majorRaw);
  const minor = minorRaw === undefined || minorRaw === "x" || minorRaw === "*" ? null : Number(minorRaw);
  const patch = patchRaw === undefined || patchRaw === "x" || patchRaw === "*" ? null : Number(patchRaw);
  const target: ParsedSemver = [major, minor ?? 0, patch ?? 0, null];
  const cmp = compareSemver(version, target);
  if (version[3] !== null && op !== "=" && op !== "") {
    // Avoid prereleases unless pinned exactly.
    return false;
  }
  switch (op) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "^":
      if (major > 0) {
        return version[0] === major && cmp >= 0;
      }
      if (minor !== null && minor > 0) {
        return version[0] === 0 && version[1] === minor && cmp >= 0;
      }
      return version[0] === 0 && version[1] === (minor ?? 0) && cmp >= 0;
    case "~":
      return version[0] === major && (minor === null || version[1] === minor) && cmp >= 0;
    case "=":
    case "": {
      if (minor === null) return version[0] === major;
      if (patch === null) return version[0] === major && version[1] === minor;
      return cmp === 0 && (version[3] ?? null) === (comparator[5] ?? null);
    }
    default:
      return false;
  }
}

export type InstallProgress = (message: string) => void;

export class NpmClient {
  private readonly metadataCache = new Map<string, AbbreviatedMetadata>();

  constructor(private readonly vfs: Vfs) {}

  private async fetchMetadata(name: string): Promise<AbbreviatedMetadata> {
    const cached = this.metadataCache.get(name);
    if (cached) return cached;
    const response = await fetch(`${REGISTRY_URL}/${name.replace("/", "%2f")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) {
      throw new Error(`npm registry ${response.status} for ${name}`);
    }
    const metadata = (await response.json()) as AbbreviatedMetadata;
    this.metadataCache.set(name, metadata);
    return metadata;
  }

  private resolveVersion(metadata: AbbreviatedMetadata, range: string): AbbreviatedVersion {
    const distTag = metadata["dist-tags"][range.trim()];
    if (distTag && metadata.versions[distTag]) {
      return metadata.versions[distTag] as AbbreviatedVersion;
    }
    const exact = metadata.versions[range.trim()];
    if (exact) return exact;
    let best: { parsed: ParsedSemver; version: AbbreviatedVersion } | null = null;
    for (const candidate of Object.values(metadata.versions)) {
      const parsed = parseSemver(candidate.version);
      if (!parsed) continue;
      if (!satisfies(parsed, range)) continue;
      if (!best || compareSemver(parsed, best.parsed) > 0) {
        best = { parsed, version: candidate };
      }
    }
    if (!best) {
      const latest = metadata["dist-tags"].latest;
      if (latest && metadata.versions[latest]) {
        return metadata.versions[latest] as AbbreviatedVersion;
      }
      throw new Error(`No version satisfies "${range}"`);
    }
    return best.version;
  }

  private async extractPackage(tarballUrl: string, targetDir: string): Promise<void> {
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      throw new Error(`Tarball fetch failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await extractTarball(bytes, (rawPath, data, isDir) => {
      // npm tarballs prefix entries with `package/`.
      const parts = rawPath.split("/").slice(1);
      if (parts.length === 0) return;
      const target = joinPath(targetDir, parts.join("/"));
      if (isDir) {
        if (!this.vfs.exists(target)) this.vfs.mkdir(target, { recursive: true });
        return;
      }
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      if (!this.vfs.exists(parent)) this.vfs.mkdir(parent, { recursive: true });
      this.vfs.writeFile(target, data.slice());
    });
  }

  /**
   * Install packages (with transitive production dependencies) into
   * `{projectDir}/node_modules`, hoisted flat, first version wins.
   */
  async install(input: {
    projectDir: string;
    packages: Array<{ name: string; range: string }>;
    onProgress?: InstallProgress;
  }): Promise<{ installed: string[] }> {
    const nodeModules = joinPath(input.projectDir, "node_modules");
    const installed: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ name: string; range: string }> = [...input.packages];

    while (queue.length > 0) {
      if (seen.size > MAX_PACKAGES_PER_INSTALL) {
        throw new Error(
          `Dependency graph exceeded ${MAX_PACKAGES_PER_INSTALL} packages; aborting install.`
        );
      }
      const entry = queue.shift();
      if (!entry) break;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const targetDir = joinPath(nodeModules, entry.name);
      if (this.vfs.exists(joinPath(targetDir, "package.json"))) {
        continue;
      }
      input.onProgress?.(`resolving ${entry.name}@${entry.range}`);
      const metadata = await this.fetchMetadata(entry.name);
      const version = this.resolveVersion(metadata, entry.range);
      input.onProgress?.(`installing ${entry.name}@${version.version}`);
      await this.extractPackage(version.dist.tarball, targetDir);
      installed.push(`${entry.name}@${version.version}`);
      for (const [dependencyName, dependencyRange] of Object.entries(
        version.dependencies ?? {}
      )) {
        if (!seen.has(dependencyName)) {
          queue.push({ name: dependencyName, range: dependencyRange });
        }
      }
    }
    return { installed };
  }
}
