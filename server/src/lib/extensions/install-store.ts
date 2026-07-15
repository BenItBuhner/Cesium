import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../persistence.js";
import { getStorage } from "../../storage/runtime.js";
import {
  extractZip,
  readTextEntry,
  readZipEntries,
  type ZipLimits,
} from "./zip.js";
import { classifyExtensionManifest } from "./manifest-classifier.js";
import type {
  ExtensionCompatibilityLevel,
  ExtensionInstallRecord,
  ExtensionManifestContributionSummary,
  ExtensionManifestSummary,
  ExtensionMarketplaceDetail,
  ExtensionMarketplaceSearchResponse,
  ExtensionPermissionGrant,
} from "./types.js";

const OPEN_VSX_BASE_URL = "https://open-vsx.org";
const MARKETPLACE_SEARCH_LIMIT_MAX = 50;
const MARKETPLACE_CACHE_TTL_MS = 5 * 60_000;
const VSIX_LIMITS: ZipLimits = {
  maxEntries: 12_000,
  maxCompressedBytes: 250 * 1024 * 1024,
  maxUncompressedBytes: 650 * 1024 * 1024,
};

const marketplaceCache = new Map<string, { expiresAt: number; value: unknown }>();

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = marketplaceCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const value = await loader();
  marketplaceCache.set(key, { expiresAt: now + MARKETPLACE_CACHE_TTL_MS, value });
  if (marketplaceCache.size > 250) {
    const expired = [...marketplaceCache.entries()]
      .filter(([, entry]) => entry.expiresAt <= now)
      .map(([entryKey]) => entryKey);
    for (const entryKey of expired.slice(0, 100)) {
      marketplaceCache.delete(entryKey);
    }
    while (marketplaceCache.size > 250) {
      const oldestKey = marketplaceCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      marketplaceCache.delete(oldestKey);
    }
  }
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function countContribution(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function summarizeContributes(raw: unknown): ExtensionManifestContributionSummary {
  const contributes = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    commands: countContribution(contributes, "commands"),
    configuration: countContribution(contributes, "configuration"),
    languages: countContribution(contributes, "languages"),
    grammars: countContribution(contributes, "grammars"),
    snippets: countContribution(contributes, "snippets"),
    themes: countContribution(contributes, "themes"),
    iconThemes: countContribution(contributes, "iconThemes"),
    views: countContribution(contributes, "views"),
    viewsContainers: countContribution(contributes, "viewsContainers"),
    webviews: countContribution(contributes, "webviews"),
    customEditors: countContribution(contributes, "customEditors"),
    keybindings: countContribution(contributes, "keybindings"),
    menus: countContribution(contributes, "menus"),
  };
}

function summarizeManifest(raw: Record<string, unknown>): ExtensionManifestSummary {
  const publisher = asString(raw.publisher) ?? "unknown";
  const name = asString(raw.name) ?? "extension";
  const engines =
    raw.engines && typeof raw.engines === "object"
      ? (raw.engines as Record<string, unknown>)
      : {};
  return {
    name,
    publisher,
    displayName: asString(raw.displayName) ?? name,
    description: asString(raw.description) ?? "",
    version: asString(raw.version) ?? "0.0.0",
    engines: {
      vscode: asString(engines.vscode),
    },
    main: asString(raw.main),
    browser: asString(raw.browser),
    activationEvents: asStringArray(raw.activationEvents),
    categories: asStringArray(raw.categories),
    contributes: summarizeContributes(raw.contributes),
    capabilities: classifyExtensionManifest(raw),
    raw,
  };
}

function scoreCompatibility(manifest: ExtensionManifestSummary): {
  compatibility: ExtensionCompatibilityLevel;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!manifest.main && !manifest.browser) {
    if (manifest.capabilities.staticContributions.length === 0) {
      warnings.push("No main or browser entrypoint; only static contributions can load.");
    }
  }
  warnings.push(...manifest.capabilities.reasons);
  if (manifest.raw.contributes && typeof manifest.raw.contributes === "object") {
    const contributes = manifest.raw.contributes as Record<string, unknown>;
    for (const key of Object.keys(contributes)) {
      if (
        ![
          "commands",
          "configuration",
          "languages",
          "grammars",
          "snippets",
          "themes",
          "iconThemes",
          "views",
          "viewsContainers",
          "webviews",
          "customEditors",
          "keybindings",
          "menus",
        ].includes(key)
      ) {
        warnings.push(`Contribution point '${key}' is not implemented yet.`);
      }
    }
  }
  if (manifest.raw.activationEvents && !Array.isArray(manifest.raw.activationEvents)) {
    warnings.push("activationEvents is malformed.");
  }
  if (manifest.categories.some((category) => /debugger|scm|notebook|testing/i.test(category))) {
    warnings.push("This extension category relies on APIs that are partial in the Beta.");
  }
  if (warnings.some((warning) => /malformed/i.test(warning))) {
    return { compatibility: "unsupported", warnings };
  }
  if (warnings.length > 0) {
    return { compatibility: "partial", warnings };
  }
  return { compatibility: "high", warnings };
}

function extensionInstallRoot(workspaceId: string, extensionId: string, version: string): string {
  return path.join(DATA_DIR, "extensions", "workspaces", workspaceId, extensionId, version);
}

function extensionVsixPath(workspaceId: string, extensionId: string, version: string): string {
  return path.join(DATA_DIR, "extensions", "vsix", workspaceId, `${extensionId}-${version}.vsix`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Open VSX request failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
}

export async function searchOpenVsx(input: {
  query: string;
  size?: number;
  category?: string;
  sortBy?: string;
  sortOrder?: string;
  namespace?: string;
}): Promise<ExtensionMarketplaceSearchResponse> {
  const params = new URLSearchParams();
  params.set("query", input.query.trim() || "*");
  params.set("size", String(Math.max(1, Math.min(input.size ?? 20, MARKETPLACE_SEARCH_LIMIT_MAX))));
  if (input.category?.trim()) params.set("category", input.category.trim());
  if (input.sortBy?.trim()) params.set("sortBy", input.sortBy.trim());
  if (input.sortOrder?.trim()) params.set("sortOrder", input.sortOrder.trim());
  if (input.namespace?.trim()) params.set("namespace", input.namespace.trim());
  const url = `${OPEN_VSX_BASE_URL}/api/-/search?${params.toString()}`;
  const raw = await cached(`search:${url}`, () => fetchJson<Record<string, unknown>>(url));
  const extensions = Array.isArray(raw.extensions) ? raw.extensions : [];
  return {
    offset: typeof raw.offset === "number" ? raw.offset : 0,
    totalSize: typeof raw.totalSize === "number" ? raw.totalSize : extensions.length,
    extensions: extensions
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
      .map((item) => ({
        namespace: asString(item.namespace) ?? "unknown",
        name: asString(item.name) ?? "extension",
        version: asString(item.version) ?? "0.0.0",
        displayName: asString(item.displayName) ?? asString(item.name) ?? "Extension",
        description: asString(item.description) ?? "",
        downloadCount:
          typeof item.downloadCount === "number" ? item.downloadCount : undefined,
        averageRating:
          typeof item.averageRating === "number" ? item.averageRating : undefined,
        verified: typeof item.verified === "boolean" ? item.verified : undefined,
        iconUrl: asString((item.files as Record<string, unknown> | undefined)?.icon),
      })),
  };
}

export async function getOpenVsxDetail(input: {
  namespace: string;
  name: string;
  version?: string;
}): Promise<ExtensionMarketplaceDetail> {
  const version = input.version?.trim() || "latest";
  const url = `${OPEN_VSX_BASE_URL}/api/${encodeURIComponent(input.namespace)}/${encodeURIComponent(
    input.name
  )}/${encodeURIComponent(version)}`;
  const raw = await cached(`detail:${url}`, () => fetchJson<Record<string, unknown>>(url));
  const files =
    raw.files && typeof raw.files === "object"
      ? (raw.files as Record<string, string>)
      : {};
  return {
    namespace: asString(raw.namespace) ?? input.namespace,
    name: asString(raw.name) ?? input.name,
    version: asString(raw.version) ?? version,
    displayName: asString(raw.displayName) ?? input.name,
    description: asString(raw.description) ?? "",
    downloadCount: typeof raw.downloadCount === "number" ? raw.downloadCount : undefined,
    averageRating: typeof raw.averageRating === "number" ? raw.averageRating : undefined,
    verified:
      typeof (raw.namespaceAccess as Record<string, unknown> | undefined)?.verified === "boolean"
        ? Boolean((raw.namespaceAccess as Record<string, unknown>).verified)
        : undefined,
    iconUrl: asString(files.icon),
    categories: asStringArray(raw.categories),
    tags: asStringArray(raw.tags),
    license: asString(raw.license),
    repository: asString(raw.repository),
    downloadUrl: asString(files.download),
    manifestUrl: asString(files.manifest),
    readmeUrl: asString(files.readme),
    files,
    raw,
  };
}

export async function installOpenVsxExtension(input: {
  workspaceId: string;
  namespace: string;
  name: string;
  version?: string;
}): Promise<ExtensionInstallRecord> {
  const detail = await getOpenVsxDetail(input);
  if (!detail.downloadUrl) {
    throw new Error("Open VSX extension did not include a VSIX download URL.");
  }
  const response = await fetch(detail.downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download VSIX (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const entries = readZipEntries(buffer, VSIX_LIMITS);
  const manifestText =
    readTextEntry(buffer, entries, "extension/package.json") ??
    readTextEntry(buffer, entries, "package.json");
  if (!manifestText) {
    throw new Error("Invalid VSIX: missing extension/package.json.");
  }
  const manifest = summarizeManifest(JSON.parse(manifestText) as Record<string, unknown>);
  const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const installPath = extensionInstallRoot(input.workspaceId, extensionId, manifest.version);
  const vsixPath = extensionVsixPath(input.workspaceId, extensionId, manifest.version);
  await fs.mkdir(path.dirname(vsixPath), { recursive: true });
  await fs.writeFile(vsixPath, buffer);
  await extractZip(buffer, installPath, VSIX_LIMITS);
  const compatibility = scoreCompatibility(manifest);
  const now = Date.now();
  const existing = await (await getStorage()).getInstalledExtension(
    input.workspaceId,
    extensionId
  );
  const permissions: ExtensionPermissionGrant[] = existing?.permissions ?? [
    {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      extensionId,
      permission: "workspace.trust",
      granted: false,
      reason: "Required before activating Node extension code.",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const record: ExtensionInstallRecord = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    extensionId,
    publisher: manifest.publisher,
    name: manifest.name,
    displayName: manifest.displayName || detail.displayName,
    description: manifest.description || detail.description,
    version: manifest.version,
    enabled: true,
    compatibility: compatibility.compatibility,
    compatibilityWarnings: compatibility.warnings,
    source: {
      kind: "open-vsx",
      namespace: detail.namespace,
      name: detail.name,
      version: detail.version,
      registryUrl: OPEN_VSX_BASE_URL,
    },
    vsixSha256: sha256,
    vsixSizeBytes: buffer.length,
    installPath,
    manifest,
    settings: existing?.settings ?? {},
    permissions,
    runtime: {
      hostRunning: false,
      activated: false,
      activationEvents: [],
      crashCount: existing?.runtime.crashCount ?? 0,
      disabledForCrashLoop: existing?.runtime.disabledForCrashLoop ?? false,
    },
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await (await getStorage()).upsertInstalledExtension(record);
  return record;
}
