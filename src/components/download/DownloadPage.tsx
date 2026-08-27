"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Apple,
  AppWindow,
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  Github,
  Globe,
  Monitor,
  Smartphone,
  TerminalSquare,
  Watch,
} from "lucide-react";
import { WorkbenchLink } from "@/components/landing/WorkbenchLink";
import {
  detectClientPlatform,
  type DetectedPlatform,
} from "@/lib/platform-detect";
import {
  CESIUM_RELEASES_URL,
  formatAssetSize,
  type ReleaseAsset,
  type ReleaseCatalog,
} from "@/lib/releases";
import { buildCesiumServerInstallCommand } from "@/lib/server-install-command";

/* ------------------------------------------------------------------------ */
/* Shared bits                                                              */
/* ------------------------------------------------------------------------ */

function CesiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 174" className={className} aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M159.014 134.928L112 162.072a24 24 0 0 1-24 0l-47.014-27.144a24 24 0 0 1-12-20.784V59.856a24 24 0 0 1 12-20.784L88 11.928a24 24 0 0 1 24 0l47.014 27.144a24 24 0 0 1 12 20.784v54.288a24 24 0 0 1-12 20.784ZM151.014 121.072L104 148.215a8 8 0 0 1-8 0l-47.014-27.143a8 8 0 0 1-4-6.928V59.856a8 8 0 0 1 4-6.928L96 25.785a8 8 0 0 1 8 0l47.014 27.143a8 8 0 0 1 4 6.928v54.288a8 8 0 0 1-4 6.928Z"
      />
    </svg>
  );
}

const ARCH_LABELS: Record<string, string> = {
  arm64: "Apple silicon",
  x64: "Intel",
};

function archLabel(platform: string, arch: string): string {
  if (platform === "mac") {
    return ARCH_LABELS[arch] ?? arch;
  }
  return arch;
}

const KIND_LABELS: Record<string, string> = {
  dmg: "DMG",
  zip: "ZIP",
  exe: "Installer",
  appimage: "AppImage",
  deb: "DEB",
  apk: "APK",
};

/* ------------------------------------------------------------------------ */
/* Recommendation logic                                                     */
/* ------------------------------------------------------------------------ */

type Recommendation = {
  asset: ReleaseAsset;
  label: string;
};

function pickRecommendedAsset(
  catalog: ReleaseCatalog,
  detected: DetectedPlatform
): Recommendation | null {
  const { os, arch } = detected;
  const find = (predicate: (asset: ReleaseAsset) => boolean) =>
    catalog.assets.find(predicate) ?? null;
  if (os === "mac") {
    const wantArch = arch ?? "arm64";
    const asset =
      find((a) => a.platform === "mac" && a.arch === wantArch && a.kind === "dmg") ??
      find((a) => a.platform === "mac" && a.kind === "dmg");
    return asset
      ? { asset, label: `macOS (${archLabel("mac", asset.arch)})` }
      : null;
  }
  if (os === "win") {
    const wantArch = arch ?? "x64";
    const asset =
      find((a) => a.platform === "win" && a.arch === wantArch && a.kind === "exe") ??
      find((a) => a.platform === "win" && a.kind === "exe");
    return asset ? { asset, label: `Windows (${asset.arch})` } : null;
  }
  if (os === "linux") {
    const wantArch = arch ?? "x64";
    const asset =
      find(
        (a) => a.platform === "linux" && a.arch === wantArch && a.kind === "appimage"
      ) ?? find((a) => a.platform === "linux" && a.kind === "appimage");
    return asset ? { asset, label: `Linux (${asset.arch})` } : null;
  }
  if (os === "android") {
    const asset = find((a) => a.platform === "android");
    return asset ? { asset, label: "Android" } : null;
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Small components                                                         */
/* ------------------------------------------------------------------------ */

function AssetButton({ asset }: { asset: ReleaseAsset }) {
  const size = formatAssetSize(asset.sizeBytes);
  return (
    <a
      href={asset.url}
      className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[7px] text-[12.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-card-hover)]"
    >
      <Download className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
      <span className="font-medium">
        {KIND_LABELS[asset.kind] ?? asset.kind}
      </span>
      <span className="font-mono text-[10.5px] text-[var(--text-disabled)]">
        {archLabel(asset.platform, asset.arch)}
        {size ? ` · ${size}` : ""}
      </span>
    </a>
  );
}

function CopyableCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between gap-[10px] border-b border-[var(--border-subtle)] px-[14px] py-[8px]">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] px-[8px] py-[4px] text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          {copied ? (
            <Check className="size-[12px]" strokeWidth={2} aria-hidden />
          ) : (
            <Copy className="size-[12px]" strokeWidth={1.75} aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-[14px] py-[12px] font-mono text-[12px] leading-relaxed text-[var(--text-primary)]">
        {command}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Page                                                                     */
/* ------------------------------------------------------------------------ */

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: ReleaseCatalog }
  | { status: "unavailable" };

export function DownloadPage() {
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/releases/latest")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`release catalog unavailable (${response.status})`);
        }
        return (await response.json()) as ReleaseCatalog;
      })
      .then((catalog) => {
        if (!cancelled) {
          setCatalogState({ status: "ready", catalog });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogState({ status: "unavailable" });
        }
      });
    void detectClientPlatform().then((platform) => {
      if (!cancelled) {
        setDetected(platform);
      }
    });
    setOrigin(window.location.origin);
    return () => {
      cancelled = true;
    };
  }, []);

  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const recommendation = useMemo(
    () => (catalog && detected ? pickRecommendedAsset(catalog, detected) : null),
    [catalog, detected]
  );

  const installCommand = useMemo(() => {
    try {
      return buildCesiumServerInstallCommand(origin ?? "http://localhost:3000");
    } catch {
      return null;
    }
  }, [origin]);

  const desktopSections = useMemo(() => {
    if (!catalog) {
      return [];
    }
    const byPlatform = (platform: string) =>
      catalog.assets.filter((asset) => asset.platform === platform);
    return [
      { key: "mac", title: "macOS", icon: Apple, note: "macOS 12+, DMG or ZIP", assets: byPlatform("mac") },
      { key: "win", title: "Windows", icon: AppWindow, note: "Windows 10+, NSIS installer", assets: byPlatform("win") },
      { key: "linux", title: "Linux", icon: Monitor, note: "AppImage or Debian package", assets: byPlatform("linux") },
      { key: "android", title: "Android", icon: Smartphone, note: "Android 8+, sideload APK", assets: byPlatform("android") },
      { key: "wear", title: "Wear OS", icon: Watch, note: "Companion APK for paired watches", assets: byPlatform("wear") },
    ].filter((section) => section.assets.length > 0);
  }, [catalog]);

  return (
    <div className="fixed inset-0 z-0 overflow-y-auto overflow-x-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-main)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[56px] max-w-[1100px] items-center justify-between px-[24px]">
          <Link href="/" className="flex items-center gap-[10px]">
            <CesiumMark className="h-[22px] w-auto text-[var(--text-primary)]" />
            <span className="text-[15px] font-semibold tracking-tight">Cesium</span>
          </Link>
          <nav className="flex items-center gap-[6px]">
            <Link
              href="/sign-in"
              className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[6px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* hero */}
      <section className="relative">
        <div className="landing-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-[1100px] px-[24px] pb-[56px] pt-[64px] text-center">
          <p className="mx-auto mb-[20px] inline-flex items-center gap-[8px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[6px] font-mono text-[11px] text-[var(--text-secondary)]">
            <span className="size-[6px] rounded-full bg-[var(--ask-accent)]" />
            {catalog ? `Latest release · v${catalog.version}` : "Downloads"}
          </p>
          <h1 className="text-balance text-[38px] font-semibold leading-[1.08] tracking-tight sm:text-[52px]">
            Get Cesium on every screen
          </h1>
          <p className="mx-auto mt-[18px] max-w-[540px] text-pretty text-[15.5px] leading-relaxed text-[var(--text-secondary)]">
            The desktop app bundles the engine for a zero-setup local workbench. Mobile and web
            clients connect to an engine running on hardware you control.
          </p>

          <div className="mt-[32px] flex flex-col items-center gap-[12px]">
            {catalogState.status === "loading" ? (
              <div className="inline-flex items-center gap-[10px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[12px] text-[14px] text-[var(--text-secondary)]">
                Checking the latest release…
              </div>
            ) : recommendation ? (
              <>
                <a
                  href={recommendation.asset.url}
                  className="inline-flex items-center gap-[10px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[24px] py-[12px] text-[15px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
                >
                  <Download className="size-[17px]" strokeWidth={2} aria-hidden />
                  Download for {recommendation.label}
                </a>
                <p className="font-mono text-[11px] text-[var(--text-disabled)]">
                  {recommendation.asset.name}
                  {formatAssetSize(recommendation.asset.sizeBytes)
                    ? ` · ${formatAssetSize(recommendation.asset.sizeBytes)}`
                    : ""}
                  {detected && !detected.archConfident && detected.os !== "android"
                    ? " · detected from your browser - pick another build below if this looks wrong"
                    : " · detected from your browser"}
                </p>
              </>
            ) : catalogState.status === "ready" && detected?.os === "ios" ? (
              <div className="max-w-[440px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[16px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                <Globe className="mx-auto mb-[8px] size-[18px] text-[var(--text-primary)]" strokeWidth={1.5} aria-hidden />
                There is no signed iOS build yet - on iPhone and iPad, install Cesium as a PWA:
                open the workbench in Safari, then Share → Add to Home Screen.
              </div>
            ) : (
              <a
                href={catalog?.htmlUrl ?? CESIUM_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-[10px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[24px] py-[12px] text-[15px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
              >
                <Github className="size-[17px]" strokeWidth={2} aria-hidden />
                Browse releases on GitHub
              </a>
            )}
          </div>
        </div>
      </section>

      {/* all platforms */}
      <section className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="mx-auto max-w-[1100px] px-[24px] py-[56px]">
          <div className="mb-[28px] flex flex-wrap items-end justify-between gap-[12px]">
            <div>
              <h2 className="text-[24px] font-semibold tracking-tight">All platforms</h2>
              <p className="mt-[6px] text-[13.5px] text-[var(--text-secondary)]">
                Every build from the latest release{catalog ? ` (v${catalog.version})` : ""}.
              </p>
            </div>
            <a
              href={catalog?.htmlUrl ?? CESIUM_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-[6px] text-[12.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              <ExternalLink className="size-[13px]" strokeWidth={1.75} aria-hidden />
              Release notes &amp; older versions
            </a>
          </div>

          {catalogState.status === "unavailable" ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[24px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              The release catalog could not be loaded right now. All builds remain available
              directly from the{" "}
              <a
                href={CESIUM_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-primary)] underline underline-offset-2"
              >
                GitHub releases page
              </a>
              .
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
              {desktopSections.map(({ key, title, icon: Icon, note, assets }) => (
                <article
                  key={key}
                  className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-[20px]"
                >
                  <div className="mb-[12px] flex items-center gap-[10px]">
                    <Icon className="size-[19px] text-[var(--text-primary)]" strokeWidth={1.5} aria-hidden />
                    <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
                  </div>
                  <p className="mb-[14px] font-mono text-[10.5px] text-[var(--text-disabled)]">{note}</p>
                  <div className="flex flex-wrap gap-[8px]">
                    {assets.map((asset) => (
                      <AssetButton key={asset.name} asset={asset} />
                    ))}
                  </div>
                </article>
              ))}
              <article className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-[20px]">
                <div className="mb-[12px] flex items-center gap-[10px]">
                  <Globe className="size-[19px] text-[var(--text-primary)]" strokeWidth={1.5} aria-hidden />
                  <h3 className="text-[15px] font-semibold tracking-tight">iOS &amp; web</h3>
                </div>
                <p className="mb-[14px] font-mono text-[10.5px] text-[var(--text-disabled)]">
                  Installable PWA - no store required
                </p>
                <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                  Open the workbench in any modern browser and install it from the address bar
                  (or Share → Add to Home Screen on iPhone/iPad).
                </p>
              </article>
            </div>
          )}
        </div>
      </section>

      {/* engine install */}
      <section className="mx-auto max-w-[1100px] px-[24px] py-[56px]">
        <div className="grid grid-cols-1 items-start gap-[28px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <h2 className="flex items-center gap-[10px] text-[24px] font-semibold tracking-tight">
              <TerminalSquare className="size-[22px]" strokeWidth={1.5} aria-hidden />
              Run the engine anywhere
            </h2>
            <p className="mt-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              The desktop app ships with an embedded engine. To use the web or mobile clients
              against your own hardware - a workstation, homelab box, or VPS - install the engine
              with one command. It sets up the runtime, credentials, a secure tunnel, and
              registers with this deployment so your devices can find it.
            </p>
            <p className="mt-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              Prefer npm? The same lifecycle is available as a CLI:{" "}
              <code className="rounded bg-[var(--accent-bg)] px-[5px] py-[2px] font-mono text-[12px]">
                npx cesium-workbench install
              </code>{" "}
              then{" "}
              <code className="rounded bg-[var(--accent-bg)] px-[5px] py-[2px] font-mono text-[12px]">
                npx cesium-workbench start
              </code>
              .
            </p>
          </div>
          <div className="space-y-[12px]">
            {installCommand ? (
              <CopyableCommand command={installCommand} label="Linux · macOS · WSL" />
            ) : null}
            <p className="font-mono text-[10.5px] text-[var(--text-disabled)]">
              Installs to ~/.cesium · manage it afterwards with `cesium-server status | logs | update`
            </p>
          </div>
        </div>
      </section>

      {/* footer */}
      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-[14px] px-[24px] py-[26px]">
          <div className="flex items-center gap-[8px] text-[var(--text-disabled)]">
            <CesiumMark className="h-[16px] w-auto" />
            <span className="text-[12px]">Cesium - local-first AI workbench</span>
          </div>
          <div className="flex items-center gap-[18px] text-[12px] text-[var(--text-disabled)]">
            <Link href="/" className="transition-colors hover:text-[var(--text-primary)]">
              Home
            </Link>
            <WorkbenchLink className="transition-colors hover:text-[var(--text-primary)]">
              Workbench
              <ArrowRight className="ml-[4px] inline size-[11px]" strokeWidth={2} aria-hidden />
            </WorkbenchLink>
          </div>
        </div>
      </footer>
    </div>
  );
}
