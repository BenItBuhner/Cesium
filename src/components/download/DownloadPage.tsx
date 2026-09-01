"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  Github,
  TerminalSquare,
} from "lucide-react";
import { PlatformIcon } from "@/components/download/PlatformIcon";
import { WorkbenchLink } from "@/components/landing/WorkbenchLink";
import {
  installerButtonLabel,
  pickRecommendedAsset,
  userFacingAssets,
} from "@/lib/download-assets";
import { detectClientPlatform, type DetectedPlatform } from "@/lib/platform-detect";
import { CESIUM_RELEASES_URL, type ReleaseAsset, type ReleaseCatalog } from "@/lib/releases";
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

function AssetButton({
  asset,
  siblings,
}: {
  asset: ReleaseAsset;
  siblings: readonly ReleaseAsset[];
}) {
  return (
    <a
      href={asset.url}
      className="inline-flex items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[14px] py-[8px] text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-card-hover)]"
    >
      {installerButtonLabel(asset, siblings)}
    </a>
  );
}

function CopyableCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between gap-[10px] border-b border-[var(--border-subtle)] px-[14px] py-[8px]">
        <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] px-[8px] py-[4px] text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
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

function PlatformCard({
  title,
  platform,
  children,
}: {
  title: string;
  platform: "mac" | "win" | "linux" | "android" | "wear" | "ios" | "web";
  children: ReactNode;
}) {
  return (
    <article className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-card)] p-[22px]">
      <div className="mb-[16px] flex items-center gap-[12px]">
        <span className="flex size-[36px] items-center justify-center rounded-[var(--radius-tab)] bg-[var(--accent-bg)] text-[var(--text-primary)]">
          <PlatformIcon platform={platform} className="size-[18px]" />
        </span>
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      </div>
      {children}
    </article>
  );
}

const PRIMARY_BUTTON =
  "inline-flex items-center justify-center gap-[10px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[24px] py-[12px] text-[15px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]";

const SECONDARY_BUTTON =
  "inline-flex items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[14px] py-[8px] text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-card-hover)]";

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
    return [
      { key: "mac" as const, title: "macOS" },
      { key: "win" as const, title: "Windows" },
      { key: "linux" as const, title: "Linux" },
      { key: "android" as const, title: "Android" },
      { key: "wear" as const, title: "Wear OS" },
    ]
      .map((section) => ({
        ...section,
        assets: userFacingAssets(catalog.assets, section.key),
      }))
      .filter((section) => section.assets.length > 0);
  }, [catalog]);

  return (
    <div className="fixed inset-0 z-0 overflow-y-auto overflow-x-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
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

      <section className="relative">
        <div className="landing-grid-bg pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-[1100px] px-[24px] pb-[56px] pt-[72px] text-center sm:pt-[88px]">
          <h1 className="text-balance text-[38px] font-semibold leading-[1.08] tracking-tight sm:text-[52px]">
            Get Cesium on every screen
          </h1>
          <p className="mx-auto mt-[18px] max-w-[500px] text-pretty text-[15.5px] leading-relaxed text-[var(--text-secondary)]">
            The desktop app is a complete local workbench. Phone, watch, and web
            clients connect to an engine on hardware you control.
          </p>

          <div className="mt-[32px] flex flex-col items-center gap-[14px]">
            {catalogState.status === "loading" ? (
              <div className="inline-flex items-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[12px] text-[14px] text-[var(--text-secondary)]">
                Finding your download…
              </div>
            ) : recommendation ? (
              <a href={recommendation.asset.url} className={PRIMARY_BUTTON}>
                <Download className="size-[17px]" strokeWidth={2} aria-hidden />
                Download for {recommendation.label}
              </a>
            ) : catalogState.status === "ready" && detected?.os === "ios" ? (
              <>
                <WorkbenchLink className={PRIMARY_BUTTON}>Open the workbench</WorkbenchLink>
                <p className="max-w-[400px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                  On iPhone and iPad, open this in Safari, then Share and Add to Home
                  Screen.
                </p>
              </>
            ) : (
              <a
                href={catalog?.htmlUrl ?? CESIUM_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={PRIMARY_BUTTON}
              >
                <Github className="size-[17px]" strokeWidth={2} aria-hidden />
                Browse releases
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="mx-auto max-w-[1100px] px-[24px] py-[56px]">
          <div className="mb-[28px] flex flex-wrap items-end justify-between gap-[12px]">
            <h2 className="text-[24px] font-semibold tracking-tight">All platforms</h2>
            <a
              href={catalog?.htmlUrl ?? CESIUM_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-[6px] text-[13px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              Release notes
              <ExternalLink className="size-[13px]" strokeWidth={1.75} aria-hidden />
            </a>
          </div>

          {catalogState.status === "unavailable" ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[24px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              Builds are on the{" "}
              <a
                href={CESIUM_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-primary)] underline underline-offset-2"
              >
                GitHub releases page
              </a>{" "}
              if the catalog does not load.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-[16px] sm:grid-cols-2 lg:grid-cols-3">
              {desktopSections.map(({ key, title, assets }) => (
                <PlatformCard key={key} title={title} platform={key}>
                  <div className="flex flex-wrap gap-[8px]">
                    {assets.map((asset) => (
                      <AssetButton key={asset.name} asset={asset} siblings={assets} />
                    ))}
                  </div>
                </PlatformCard>
              ))}
              <PlatformCard title="iOS" platform="ios">
                <p className="mb-[14px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                  Share from Safari, then Add to Home Screen.
                </p>
                <WorkbenchLink className={SECONDARY_BUTTON}>Open workbench</WorkbenchLink>
              </PlatformCard>
              <PlatformCard title="Web" platform="web">
                <p className="mb-[14px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
                  Works in any modern browser.
                </p>
                <WorkbenchLink className={SECONDARY_BUTTON}>Open workbench</WorkbenchLink>
              </PlatformCard>
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-[24px] py-[56px]">
        <div className="grid grid-cols-1 items-start gap-[28px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <h2 className="flex items-center gap-[10px] text-[24px] font-semibold tracking-tight">
              <TerminalSquare className="size-[22px]" strokeWidth={1.5} aria-hidden />
              Run the engine anywhere
            </h2>
            <p className="mt-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              The desktop app already includes the engine. To point web or mobile
              clients at your own machine, install it with one command. It sets up
              the runtime, a tunnel, and registers with this deployment.
            </p>
            <p className="mt-[10px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
              Prefer npm?{" "}
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
              <CopyableCommand command={installCommand} label="Linux, macOS, and WSL" />
            ) : null}
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-[14px] px-[24px] py-[26px]">
          <div className="flex items-center gap-[8px] text-[var(--text-disabled)]">
            <CesiumMark className="h-[16px] w-auto" />
            <span className="text-[12px]">Cesium</span>
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
