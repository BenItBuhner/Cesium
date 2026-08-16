"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpCircle,
  Download,
  ExternalLink,
  GitBranch,
  Package,
  RefreshCw,
} from "lucide-react";
import {
  applyServerUpdate,
  checkForUpdates,
  fetchUpdateStatus,
  saveUpdateSettings,
  type CesiumInstallKind,
  type CesiumUpdateChannelId,
  type CesiumUpdateRelease,
  type CesiumUpdateStatusPayload,
} from "@/lib/server-api";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
  tagClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

const INSTALL_KIND_LABELS: Record<CesiumInstallKind, string> = {
  "isolated-server": "Isolated server (installer)",
  "termux-server": "Termux on-device server",
  "desktop-electron": "Desktop app (Electron)",
  source: "Source checkout (git)",
  unknown: "Unknown",
};

const CHANNEL_LABELS: Record<CesiumUpdateChannelId, string> = {
  app: "App (unified release)",
  server: "Server",
  desktop: "Desktop",
  mobile: "Android app",
};

function formatTimestamp(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function formatBytes(size: number): string {
  if (size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let value = size;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 10) : "—";
}

function ReleaseRow({
  release,
  label,
  isNewer,
  border = true,
}: {
  release: CesiumUpdateRelease;
  label: string;
  isNewer: boolean;
  border?: boolean;
}) {
  const publishedLabel = release.publishedAt
    ? new Date(release.publishedAt).toLocaleDateString()
    : null;
  return (
    <SettingsRow
      title={`${label} — ${release.tag}`}
      titleExtra={
        <>
          {release.prerelease ? <span className={tagClass}>pre-release</span> : null}
          {isNewer ? (
            <span className={`${tagClass} text-[var(--accent-strong)]`}>
              update available
            </span>
          ) : null}
        </>
      }
      description={[
        release.name && release.name !== release.tag ? release.name : null,
        publishedLabel ? `Published ${publishedLabel}` : null,
        release.assets.length > 0
          ? `${release.assets.length} asset${release.assets.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      border={border}
      trailing={
        <div className="flex items-center gap-[8px]">
          {release.assets.slice(0, 2).map((asset) => (
            <a
              key={asset.name}
              className={rowButtonClass}
              href={asset.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${asset.name}${asset.size ? ` (${formatBytes(asset.size)})` : ""}`}
            >
              <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
              {asset.name.length > 28 ? `${asset.name.slice(0, 25)}…` : asset.name}
            </a>
          ))}
          {release.htmlUrl ? (
            <a
              className={rowButtonClass}
              href={release.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
              Release
            </a>
          ) : null}
        </div>
      }
    />
  );
}

export function UpdatesSettingsPanel() {
  const [status, setStatus] = useState<CesiumUpdateStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyLog, setApplyLog] = useState<string[]>([]);
  const [applyOutcome, setApplyOutcome] = useState<
    { ok: boolean; restartRequired: boolean; error?: string } | null
  >(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const payload = await fetchUpdateStatus();
      if (!mountedRef.current) return;
      setStatus(payload);
      setStatusError(null);
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleCheckNow = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      const payload = await checkForUpdates();
      if (!mountedRef.current) return;
      setStatus(payload);
      setStatusError(null);
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError((error as Error).message);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, [checking]);

  const handleSettingChange = useCallback(
    async (patch: Parameters<typeof saveUpdateSettings>[0]) => {
      try {
        const payload = await saveUpdateSettings(patch);
        if (!mountedRef.current) return;
        setStatus(payload);
      } catch (error) {
        if (!mountedRef.current) return;
        setStatusError((error as Error).message);
      }
    },
    []
  );

  const handleApply = useCallback(async () => {
    if (applying || !status?.selfUpdate.supported) return;
    setApplying(true);
    setApplyLog([]);
    setApplyOutcome(null);
    try {
      await applyServerUpdate({
        onEvent: (event) => {
          if (!mountedRef.current) return;
          switch (event.type) {
            case "start":
              setApplyLog((log) => [...log, `Starting self-update (${event.method}).`]);
              break;
            case "log":
              setApplyLog((log) => [...log, event.line]);
              break;
            case "restarting":
              setApplyLog((log) => [...log, event.message]);
              break;
            case "done":
              setApplyOutcome({
                ok: event.ok,
                restartRequired: event.restartRequired,
                error: event.error,
              });
              if (event.error) {
                setApplyLog((log) => [...log, `Error: ${event.error}`]);
              }
              break;
          }
        },
      });
    } catch (error) {
      if (mountedRef.current) {
        setApplyLog((log) => [...log, `Failed: ${(error as Error).message}`]);
        setApplyOutcome({ ok: false, restartRequired: false, error: (error as Error).message });
      }
    } finally {
      if (mountedRef.current) {
        setApplying(false);
        void loadStatus();
      }
    }
  }, [applying, loadStatus, status?.selfUpdate.supported]);

  const secondaryChannels = useMemo(() => {
    if (!status) return [] as CesiumUpdateRelease[];
    const primaryTag = status.latest?.tag;
    return Object.values(status.channels).filter(
      (release): release is CesiumUpdateRelease =>
        Boolean(release) && release.tag !== primaryTag
    );
  }, [status]);

  const settings = status?.settings;

  return (
    <>
      <PageIntro title="Updates" />
      <SettingsSection
        title="This installation"
        action={
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => void handleCheckNow()}
            disabled={checking || applying}
          >
            <RefreshCw
              className={`size-[14px] ${checking ? "animate-spin" : ""}`}
              strokeWidth={1.5}
              aria-hidden
            />
            {checking ? "Checking…" : "Check now"}
          </button>
        }
      >
        {statusError ? (
          <SettingsBlock>
            <SettingsCallout tone="danger">
              Update status unavailable: {statusError}
            </SettingsCallout>
          </SettingsBlock>
        ) : null}
        <SettingsRow
          title="Current version"
          description={`Protocol ${status?.protocolVersion ?? "…"} · checked ${formatTimestamp(status?.lastCheckedAt ?? null)}`}
          trailing={
            <span className={tagClass}>{status ? `v${status.currentVersion}` : "…"}</span>
          }
        />
        <SettingsRow
          title="Installation type"
          description="Detected from the server environment; decides the self-update strategy."
          trailing={
            <span className="font-sans text-[12px] text-[var(--text-secondary)]">
              {status ? INSTALL_KIND_LABELS[status.installKind] : "Loading…"}
            </span>
          }
        />
        <SettingsRow
          title="Release source"
          description="GitHub repository whose releases are checked for updates."
          border={false}
          trailing={
            <a
              className={rowButtonClass}
              href={`https://github.com/${status?.githubRepo ?? ""}/releases`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
              {status?.githubRepo ?? "…"}
            </a>
          }
        />
      </SettingsSection>

      <SettingsSection title="Available updates">
        {status?.githubError ? (
          <SettingsBlock>
            <SettingsCallout tone="warning">{status.githubError}</SettingsCallout>
          </SettingsBlock>
        ) : null}
        {status?.latest ? (
          <ReleaseRow
            release={status.latest}
            label={CHANNEL_LABELS[status.primaryChannel]}
            isNewer={Boolean(
              status.updateAvailable &&
                status.latest.version !== status.currentVersion &&
                status.latest.version !== status.settings.dismissedVersion
            )}
          />
        ) : (
          <SettingsRow
            title="Releases"
            description={
              status
                ? `No published release found for the ${CHANNEL_LABELS[status.primaryChannel]} channel yet.`
                : "Loading…"
            }
            trailing={<span />}
          />
        )}
        {status?.git ? (
          <SettingsRow
            title="Git remote"
            leading={
              <GitBranch
                className="size-[14px] text-[var(--text-secondary)]"
                strokeWidth={1.5}
                aria-hidden
              />
            }
            description={
              status.git.error
                ? `Could not check the remote: ${status.git.error}`
                : `${status.git.branch ?? "?"} @ ${shortCommit(status.git.commit)} · remote ${shortCommit(status.git.remoteCommit)}`
            }
            trailing={
              <span
                className={`font-sans text-[12px] ${
                  status.git.updateAvailable
                    ? "text-[var(--accent-strong)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {status.git.error
                  ? "Unavailable"
                  : status.git.updateAvailable
                    ? `${status.git.behind} commit${status.git.behind === 1 ? "" : "s"} behind`
                    : "Up to date"}
              </span>
            }
          />
        ) : null}
        {status?.npm ? (
          <SettingsRow
            title={`npm — ${status.npm.packageName}`}
            leading={
              <Package
                className="size-[14px] text-[var(--text-secondary)]"
                strokeWidth={1.5}
                aria-hidden
              />
            }
            description={
              status.npm.error
                ? status.npm.error
                : `Installed ${status.npm.currentVersion} · latest ${status.npm.latestVersion ?? "unknown"}`
            }
            trailing={
              <span
                className={`font-sans text-[12px] ${
                  status.npm.updateAvailable
                    ? "text-[var(--accent-strong)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                {status.npm.updateAvailable ? "Update available" : "Up to date"}
              </span>
            }
          />
        ) : null}
        {secondaryChannels.map((release, index) => (
          <ReleaseRow
            key={release.tag}
            release={release}
            label={CHANNEL_LABELS[release.channel]}
            isNewer={false}
            border={index < secondaryChannels.length - 1}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Automatic checks">
        <SettingsRow
          title="Check for updates automatically"
          description="Query the release feeds in the background every few hours."
          trailing={
            <ToggleSwitch
              checked={settings?.autoCheck ?? true}
              onChange={(next) => void handleSettingChange({ autoCheck: next })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Include pre-releases"
          description="Offer beta and release-candidate builds in addition to stable releases."
          border={false}
          trailing={
            <ToggleSwitch
              checked={settings?.includePrereleases ?? false}
              onChange={(next) => void handleSettingChange({ includePrereleases: next })}
              size="md"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Apply update">
        <SettingsRow
          title="Self-update this server"
          description={
            status?.selfUpdate.supported
              ? status.selfUpdate.method === "cesium-server-cli"
                ? "Hands off to the cesium-server installer, which stops, updates, and restarts this server."
                : "Fast-forwards the git checkout and rebuilds shared packages when needed. Restart the server afterwards."
              : (status?.selfUpdate.reason ??
                "Self-update availability is detected from the installation type.")
          }
          border={applyLog.length > 0 || applyOutcome !== null}
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => void handleApply()}
              disabled={!status?.selfUpdate.supported || applying || checking}
            >
              <ArrowUpCircle className="size-[14px]" strokeWidth={1.5} aria-hidden />
              {applying ? "Updating…" : "Update now"}
            </button>
          }
        />
        {applyLog.length > 0 ? (
          <SettingsBlock className="py-[12px]">
            <ul className="flex max-h-[240px] flex-col gap-[3px] overflow-y-auto font-mono text-[11px] leading-snug text-[var(--text-secondary)]">
              {applyLog.map((line, index) => (
                <li key={index} className="break-all">
                  {line}
                </li>
              ))}
            </ul>
            {applyOutcome ? (
              <p
                className={`mt-[8px] font-sans text-[12px] ${
                  applyOutcome.ok ? "text-[var(--text-primary)]" : "text-[#dc2626] dark:text-[#fca5a5]"
                }`}
              >
                {applyOutcome.ok
                  ? applyOutcome.restartRequired
                    ? "Update applied — restart the server to run the new build."
                    : "Already up to date."
                  : `Update failed${applyOutcome.error ? `: ${applyOutcome.error}` : "."}`}
              </p>
            ) : null}
          </SettingsBlock>
        ) : null}
      </SettingsSection>
    </>
  );
}
