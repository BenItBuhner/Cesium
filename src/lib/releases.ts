/**
 * GitHub release catalog for the public /download page.
 *
 * The release workflow (.github/workflows/release.yml) publishes assets with
 * strict names, which this module parses into a structured catalog:
 *
 *   cesium-desktop-<version>-mac-<arch>.dmg / .zip
 *   cesium-desktop-<version>-win-<arch>-setup.exe
 *   cesium-desktop-<version>-linux-<arch>.AppImage / .deb
 *   cesium-mobile-<version>.apk
 *   cesium-wear-<version>.apk
 */

export const CESIUM_GITHUB_REPO = "BenItBuhner/Cesium";

export const CESIUM_RELEASES_URL = `https://github.com/${CESIUM_GITHUB_REPO}/releases`;

export type ReleasePlatform = "mac" | "win" | "linux" | "android" | "wear";

export type ReleaseArch = "arm64" | "x64" | "universal";

export type ReleaseAssetKind =
  | "dmg"
  | "zip"
  | "exe"
  | "appimage"
  | "deb"
  | "apk";

export type ReleaseAsset = {
  name: string;
  url: string;
  sizeBytes: number;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  kind: ReleaseAssetKind;
};

export type ReleaseCatalog = {
  version: string;
  tag: string;
  publishedAt: string | null;
  htmlUrl: string;
  assets: ReleaseAsset[];
};

const DESKTOP_ASSET_PATTERN =
  /^cesium-desktop-.+-(mac|win|linux)-(arm64|x64)(?:-setup)?\.(dmg|zip|exe|AppImage|deb)$/;

/** Classify one release asset by its published filename; null when unknown. */
export function classifyReleaseAsset(input: {
  name: string;
  url: string;
  sizeBytes: number;
}): ReleaseAsset | null {
  const { name } = input;
  if (/^cesium-mobile-.+\.apk$/.test(name)) {
    return { ...input, platform: "android", arch: "universal", kind: "apk" };
  }
  if (/^cesium-wear-.+\.apk$/.test(name)) {
    return { ...input, platform: "wear", arch: "universal", kind: "apk" };
  }
  const match = DESKTOP_ASSET_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  const [, platform, arch, extension] = match;
  return {
    ...input,
    platform: platform as ReleasePlatform,
    arch: arch as ReleaseArch,
    kind: extension.toLowerCase() as ReleaseAssetKind,
  };
}

type GitHubReleaseResponse = {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

/** Parse a GitHub `releases/latest` API payload into a normalized catalog. */
export function parseGitHubRelease(payload: unknown): ReleaseCatalog | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const release = payload as GitHubReleaseResponse;
  const tag = typeof release.tag_name === "string" ? release.tag_name : null;
  if (!tag) {
    return null;
  }
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(release.assets)) {
    for (const raw of release.assets) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const asset = raw as {
        name?: unknown;
        browser_download_url?: unknown;
        size?: unknown;
      };
      if (
        typeof asset.name !== "string" ||
        typeof asset.browser_download_url !== "string"
      ) {
        continue;
      }
      const classified = classifyReleaseAsset({
        name: asset.name,
        url: asset.browser_download_url,
        sizeBytes: typeof asset.size === "number" ? asset.size : 0,
      });
      if (classified) {
        assets.push(classified);
      }
    }
  }
  return {
    version: tag.replace(/^(mobile-)?v/, ""),
    tag,
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : null,
    htmlUrl:
      typeof release.html_url === "string"
        ? release.html_url
        : `${CESIUM_RELEASES_URL}/tag/${tag}`,
    assets,
  };
}

export function formatAssetSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  const mb = sizeBytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
