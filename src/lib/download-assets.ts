/**
 * User-facing installer selection for the public /download page.
 *
 * GitHub releases also publish ZIP archives (macOS update payloads) and
 * checksums. Those are not installers. This module keeps the page limited to
 * the builds people actually run:
 *
 *   macOS  - Electron 42 DMG (Monterey / macOS 12 and later)
 *   Windows - NSIS exe (Windows 10 and later)
 *   Linux  - AppImage, plus the Debian package when published
 *   Android - APK (minSdk 26 / Android 8)
 *   Wear OS - companion APK (minSdk 30 / Wear OS 3)
 */

import type { DetectedOs, DetectedPlatform } from "@/lib/platform-detect";
import type {
  ReleaseArch,
  ReleaseAsset,
  ReleaseAssetKind,
  ReleaseCatalog,
  ReleasePlatform,
} from "@/lib/releases";

const HIDDEN_INSTALLER_KINDS = new Set<ReleaseAssetKind>(["zip"]);

const ARCH_LABELS: Record<ReleasePlatform, Partial<Record<ReleaseArch, string>>> = {
  mac: { arm64: "Apple silicon", x64: "Intel" },
  win: { arm64: "ARM", x64: "64-bit" },
  linux: { arm64: "ARM", x64: "x64" },
  android: { universal: "Download" },
  wear: { universal: "Download" },
};

const KIND_LABELS: Partial<Record<ReleaseAssetKind, string>> = {
  appimage: "AppImage",
  deb: "Debian",
};

export function isUserFacingInstaller(asset: ReleaseAsset): boolean {
  return !HIDDEN_INSTALLER_KINDS.has(asset.kind);
}

export function userFacingAssets(
  assets: readonly ReleaseAsset[],
  platform?: ReleasePlatform
): ReleaseAsset[] {
  return assets.filter(
    (asset) =>
      isUserFacingInstaller(asset) &&
      (platform === undefined || asset.platform === platform)
  );
}

export function installerButtonLabel(
  asset: ReleaseAsset,
  siblings: readonly ReleaseAsset[]
): string {
  const samePlatform = siblings.filter((entry) => entry.platform === asset.platform);
  const needsKind = samePlatform.some((entry) => entry.kind !== asset.kind);
  const needsArch = samePlatform.some((entry) => entry.arch !== asset.arch);
  const archLabel = ARCH_LABELS[asset.platform][asset.arch] ?? asset.arch;
  const kindLabel = KIND_LABELS[asset.kind];

  if (!needsKind && !needsArch) {
    return "Download";
  }
  if (needsKind && needsArch) {
    return kindLabel ? `${kindLabel} · ${archLabel}` : archLabel;
  }
  if (needsKind) {
    return kindLabel ?? "Download";
  }
  return archLabel;
}

export function platformHeroLabel(os: DetectedOs): string | null {
  if (os === "mac") return "Mac";
  if (os === "win") return "Windows";
  if (os === "linux") return "Linux";
  if (os === "android") return "Android";
  return null;
}

export type DownloadRecommendation = {
  asset: ReleaseAsset;
  label: string;
};

function preferredKind(platform: ReleasePlatform): ReleaseAssetKind {
  if (platform === "mac") return "dmg";
  if (platform === "win") return "exe";
  if (platform === "linux") return "appimage";
  return "apk";
}

export function pickRecommendedAsset(
  catalog: ReleaseCatalog,
  detected: DetectedPlatform
): DownloadRecommendation | null {
  const os = detected.os;
  if (os !== "mac" && os !== "win" && os !== "linux" && os !== "android") {
    return null;
  }
  const assets = userFacingAssets(catalog.assets, os);
  if (assets.length === 0) {
    return null;
  }
  const wantKind = preferredKind(os);
  const wantArch = detected.arch;
  const find = (predicate: (asset: ReleaseAsset) => boolean) =>
    assets.find(predicate) ?? null;

  const asset =
    (wantArch
      ? find((entry) => entry.kind === wantKind && entry.arch === wantArch)
      : null) ??
    find((entry) => entry.kind === wantKind) ??
    (wantArch ? find((entry) => entry.arch === wantArch) : null) ??
    assets[0] ??
    null;

  const label = platformHeroLabel(os);
  return asset && label ? { asset, label } : null;
}
