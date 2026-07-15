"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Play, RefreshCw, ShieldCheck, Square, Trash2 } from "lucide-react";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import {
  activateInstalledExtension,
  closeExtensionSurfaceSessionClient,
  deleteInstalledExtensionClient,
  disableAllExtensionsClient,
  fetchInstalledExtensions,
  grantExtensionPermission,
  installOpenVsxExtensionClient,
  listExtensionSurfaceSessions,
  searchExtensionMarketplace,
  setExtensionEnabled,
  stopExtensionHostClient,
  type ExtensionHostStatus,
  type ExtensionInstallRecord,
  type ExtensionSurfaceSession,
  type ExtensionMarketplaceSearchResult,
} from "@/lib/server-api";
import {
  PageIntro,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "./settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

function compactBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function extensionSubtitle(extension: ExtensionInstallRecord): string {
  const status = extension.manifest.capabilities?.status;
  const warnings = extension.compatibilityWarnings.length;
  return [
    `${extension.publisher}.${extension.name}`,
    extension.version,
    status ?? extension.compatibility,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function contributionSummary(extension: ExtensionInstallRecord): string {
  const capabilities = extension.manifest.capabilities;
  if (!capabilities) {
    return "Legacy manifest metadata. Refresh or reinstall to classify extension support.";
  }
  const parts = [
    capabilities.activitySurfaces.length > 0
      ? `${capabilities.activitySurfaces.length} activity surface${capabilities.activitySurfaces.length === 1 ? "" : "s"}`
      : null,
    capabilities.staticContributions.length > 0
      ? `${capabilities.staticContributions.length} static contribution${capabilities.staticContributions.length === 1 ? "" : "s"}`
      : null,
    capabilities.commandContributions.length > 0
      ? `${capabilities.commandContributions.length} command contribution${capabilities.commandContributions.length === 1 ? "" : "s"}`
      : null,
    capabilities.languageContributions.length > 0
      ? `${capabilities.languageContributions.length} language contribution${capabilities.languageContributions.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "No supported contribution surfaces detected.";
}

export function VscodeExtensionsSettingsPanel() {
  const { vscodeExtensionsBeta, setVscodeExtensionsBeta } = useUserPreferences();
  const { activeWorkspaceId } = useWorkspace();
  const editorBridgeRef = useEditorBridgeRef();
  const [query, setQuery] = useState("python");
  const [results, setResults] = useState<ExtensionMarketplaceSearchResult[]>([]);
  const [installed, setInstalled] = useState<ExtensionInstallRecord[]>([]);
  const [surfaceSessions, setSurfaceSessions] = useState<ExtensionSurfaceSession[]>([]);
  const [host, setHost] = useState<ExtensionHostStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousBetaRef = useRef(vscodeExtensionsBeta);

  const installedIds = useMemo(
    () => new Set(installed.map((extension) => extension.extensionId.toLowerCase())),
    [installed]
  );

  const reloadInstalled = useCallback(async () => {
    if (!activeWorkspaceId || !vscodeExtensionsBeta) {
      setInstalled([]);
      setHost(null);
      return;
    }
    const result = await fetchInstalledExtensions(activeWorkspaceId);
    setInstalled(result.extensions);
    setHost(result.host);
    const sessionResult = await listExtensionSurfaceSessions(activeWorkspaceId).catch(() => null);
    setSurfaceSessions(sessionResult?.sessions ?? []);
  }, [activeWorkspaceId, vscodeExtensionsBeta]);

  useEffect(() => {
    void reloadInstalled().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [reloadInstalled]);

  useEffect(() => {
    const wasEnabled = previousBetaRef.current;
    previousBetaRef.current = vscodeExtensionsBeta;
    if (!activeWorkspaceId || !wasEnabled || vscodeExtensionsBeta) {
      return;
    }
    void stopExtensionHostClient(activeWorkspaceId).catch(() => undefined);
  }, [activeWorkspaceId, vscodeExtensionsBeta]);

  const runSearch = useCallback(async () => {
    if (!vscodeExtensionsBeta) return;
    setBusy("__search__");
    setError(null);
    try {
      const result = await searchExtensionMarketplace({ query, size: 12 });
      setResults(result.extensions);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setBusy(null);
    }
  }, [query, vscodeExtensionsBeta]);

  const install = useCallback(
    async (result: ExtensionMarketplaceSearchResult) => {
      if (!activeWorkspaceId) return;
      setBusy(`${result.namespace}.${result.name}`);
      setError(null);
      try {
        await installOpenVsxExtensionClient({
          workspaceId: activeWorkspaceId,
          namespace: result.namespace,
          name: result.name,
          version: result.version,
        });
        await reloadInstalled();
      } catch (installError) {
        setError(installError instanceof Error ? installError.message : String(installError));
      } finally {
        setBusy(null);
      }
    },
    [activeWorkspaceId, reloadInstalled]
  );

  const toggleEnabled = useCallback(
    async (extension: ExtensionInstallRecord, enabled: boolean) => {
      if (!activeWorkspaceId) return;
      setBusy(extension.extensionId);
      setError(null);
      try {
        const result = await setExtensionEnabled(activeWorkspaceId, extension.extensionId, enabled);
        setInstalled((current) =>
          current.map((item) =>
            item.extensionId === extension.extensionId ? result.extension : item
          )
        );
        setHost(result.host);
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
      } finally {
        setBusy(null);
      }
    },
    [activeWorkspaceId]
  );

  const grantTrustAndActivate = useCallback(
    async (extension: ExtensionInstallRecord) => {
      if (!activeWorkspaceId) return;
      setBusy(`${extension.extensionId}:activate`);
      setError(null);
      try {
        await grantExtensionPermission({
          workspaceId: activeWorkspaceId,
          extensionId: extension.extensionId,
          permission: "workspace.trust",
          granted: true,
          reason: "User enabled activation from extension settings.",
        });
        const result = await activateInstalledExtension(activeWorkspaceId, extension.extensionId);
        setInstalled((current) =>
          current.map((item) =>
            item.extensionId === extension.extensionId ? result.extension : item
          )
        );
        setHost(result.host);
      } catch (activationError) {
        setError(activationError instanceof Error ? activationError.message : String(activationError));
      } finally {
        setBusy(null);
      }
    },
    [activeWorkspaceId]
  );

  const stopHost = useCallback(async () => {
    if (!activeWorkspaceId) return;
    setBusy("__host__");
    setError(null);
    try {
      const result = await stopExtensionHostClient(activeWorkspaceId);
      setHost(result.host);
      setSurfaceSessions([]);
      await reloadInstalled();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(null);
    }
  }, [activeWorkspaceId, reloadInstalled]);

  const disableAll = useCallback(async () => {
    if (!activeWorkspaceId) return;
    setBusy("__disable_all__");
    setError(null);
    try {
      const result = await disableAllExtensionsClient(activeWorkspaceId);
      setInstalled(result.extensions);
      setHost(result.host);
      setSurfaceSessions([]);
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : String(disableError));
    } finally {
      setBusy(null);
    }
  }, [activeWorkspaceId]);

  const removeExtension = useCallback(
    async (extension: ExtensionInstallRecord) => {
      if (!activeWorkspaceId) return;
      setBusy(`${extension.extensionId}:remove`);
      setError(null);
      try {
        const result = await deleteInstalledExtensionClient(activeWorkspaceId, extension.extensionId);
        setInstalled((current) =>
          current.filter((item) => item.extensionId !== extension.extensionId)
        );
        setHost(result.host);
      } catch (removeError) {
        setError(removeError instanceof Error ? removeError.message : String(removeError));
      } finally {
        setBusy(null);
      }
    },
    [activeWorkspaceId]
  );

  const closeSurfaceSession = useCallback(
    async (session: ExtensionSurfaceSession) => {
      if (!activeWorkspaceId) return;
      setBusy(`${session.sessionId}:close`);
      setError(null);
      try {
        const result = await closeExtensionSurfaceSessionClient({
          workspaceId: activeWorkspaceId,
          sessionId: session.sessionId,
        });
        setSurfaceSessions((current) =>
          current.filter((item) => item.sessionId !== session.sessionId)
        );
        setHost(result.host);
      } catch (closeError) {
        setError(closeError instanceof Error ? closeError.message : String(closeError));
      } finally {
        setBusy(null);
      }
    },
    [activeWorkspaceId]
  );

  return (
    <>
      <PageIntro title="VS Code Extensions" />
      {error ? (
        <p className="mb-[12px] rounded-[var(--radius-card)] border border-[var(--error-border)] bg-[var(--error-bg)] px-[12px] py-[10px] font-sans text-[12px] text-[var(--error-fg)]">
          {error}
        </p>
      ) : null}
      <SettingsSection title="Beta Runtime">
        <SettingsRow
          title="Enable extension marketplace"
          description="Off means no extension marketplace requests, no host process, and no extension surfaces. On allows Open VSX installs and starts the host only when you activate an extension."
          trailing={
            <ToggleSwitch
              checked={vscodeExtensionsBeta}
              onChange={setVscodeExtensionsBeta}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Extension host"
          description={
            host?.running
              ? `Running${host.pid ? ` as PID ${host.pid}` : ""}. RSS sample: ${compactBytes(host.memoryRssBytes)}. Activated: ${host.activatedExtensionIds.length}.`
              : "Stopped. The host starts only after you activate or open an extension surface."
          }
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              disabled={!host?.running || busy === "__host__"}
              onClick={() => void stopHost()}
            >
              <Square className="size-[14px]" strokeWidth={1.5} />
              Stop host
            </button>
          }
          border={false}
        />
        <SettingsRow
          title="Disable all extensions"
          description="Emergency brake: stop the extension host and mark every installed extension disabled for this workspace."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              disabled={installed.length === 0 || busy === "__disable_all__"}
              onClick={() => void disableAll()}
            >
              Disable all
            </button>
          }
          border={false}
        />
      </SettingsSection>
      {vscodeExtensionsBeta ? (
        <>
          <SettingsSection title="Active Extension Surfaces">
            {surfaceSessions.length === 0 ? (
              <p className="px-[16px] py-[14px] font-sans text-[12px] text-[var(--text-secondary)]">
                No retained extension surfaces are running. Opening a sidebar view creates a
                server-owned session that survives client reloads until you close it or stop the
                host.
              </p>
            ) : (
              surfaceSessions.map((session) => (
                <SettingsRow
                  key={session.sessionId}
                  title={session.title}
                  description={[
                    `${session.extensionId} · ${session.surfaceId}`,
                    `${session.placements.join(", ") || "detached"}`,
                    `HTML v${session.htmlVersion} (${compactBytes(session.htmlBytes)})`,
                    session.resolveMs ? `${session.resolveMs}ms resolve` : null,
                    `${session.messages.length} queued message${session.messages.length === 1 ? "" : "s"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  trailing={
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy === `${session.sessionId}:close`}
                      onClick={() => void closeSurfaceSession(session)}
                    >
                      Close surface
                    </button>
                  }
                />
              ))
            )}
          </SettingsSection>
          <SettingsSection
            title="Marketplace"
            action={
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy === "__search__"}
                onClick={() => void runSearch()}
              >
                <RefreshCw className="size-[14px]" strokeWidth={1.5} />
                Search
              </button>
            }
          >
            <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runSearch();
                }}
                className="box-border h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-primary)] outline-none"
                placeholder="Search Open VSX"
              />
            </div>
            {results.length === 0 ? (
              <p className="px-[16px] py-[14px] font-sans text-[12px] text-[var(--text-secondary)]">
                Search Open VSX to install extensions.
              </p>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {results.map((result) => {
                  const extensionId = `${result.namespace}.${result.name}`.toLowerCase();
                  const isInstalled = installedIds.has(extensionId);
                  return (
                    <div key={extensionId} className="flex items-center justify-between gap-[12px] px-[16px] py-[12px]">
                      <div className="min-w-0">
                        <p className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                          {result.displayName}
                        </p>
                        <p className="mt-[3px] truncate font-sans text-[12px] text-[var(--text-secondary)]">
                          {result.namespace}.{result.name} · {result.version}
                        </p>
                        <p className="mt-[4px] line-clamp-2 font-sans text-[12px] text-[var(--text-secondary)]">
                          {result.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={isInstalled || busy === extensionId}
                        onClick={() => void install(result)}
                      >
                        <Download className="size-[14px]" strokeWidth={1.5} />
                        {isInstalled ? "Installed" : "Install"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsSection>
          <SettingsSection title="Installed">
            {installed.length === 0 ? (
              <p className="px-[16px] py-[14px] font-sans text-[12px] text-[var(--text-secondary)]">
                No extensions installed in this workspace.
              </p>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {installed.map((extension) => (
                  <div key={extension.extensionId} className="px-[16px] py-[12px]">
                    <div className="flex items-start justify-between gap-[12px]">
                      <div className="min-w-0">
                        <p className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                          {extension.displayName}
                        </p>
                        <p className="mt-[3px] font-sans text-[12px] text-[var(--text-secondary)]">
                          {extensionSubtitle(extension)}
                        </p>
                        <p className="mt-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
                          VSIX {compactBytes(extension.vsixSizeBytes)} · {extension.manifest.main ? "Node entrypoint" : "Static contributions only"}
                        </p>
                        <p className="mt-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
                          {contributionSummary(extension)}
                        </p>
                      </div>
                      <ToggleSwitch
                        checked={extension.enabled}
                        onChange={(checked) => void toggleEnabled(extension, checked)}
                        size="md"
                        variant="green"
                      />
                    </div>
                    {extension.compatibilityWarnings.length > 0 ? (
                      <div className="mt-[10px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
                        {extension.compatibilityWarnings.slice(0, 4).join(" ")}
                      </div>
                    ) : null}
                    {extension.manifest.capabilities?.reasons.length ? (
                      <div className="mt-[10px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
                        {extension.manifest.capabilities.reasons.slice(0, 4).join(" ")}
                      </div>
                    ) : null}
                    {extension.manifest.capabilities?.staticContributions.length ? (
                      <div className="mt-[10px] rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[10px] py-[7px] font-sans text-[11px] text-[var(--text-disabled)]">
                        Static contribution only:{" "}
                        {extension.manifest.capabilities.staticContributions
                          .slice(0, 4)
                          .map((item) => item.label)
                          .join(", ")}
                      </div>
                    ) : null}
                    <div className="mt-[10px] flex flex-wrap gap-[8px]">
                      {extension.manifest.capabilities?.activitySurfaces
                        .filter((surface) => surface.visibility === "always")
                        .slice(0, 4)
                        .map((surface) => (
                          <button
                            key={`${extension.extensionId}:${surface.surfaceId}`}
                            type="button"
                            className={rowButtonClass}
                            disabled={!extension.enabled}
                            onClick={() =>
                              editorBridgeRef.current?.openExtensionSurfaceTab({
                                extensionId: extension.extensionId,
                                surfaceId: surface.surfaceId,
                                title: surface.title,
                                surfaceKind:
                                  surface.kind === "activity.webviewView" ? "webview" : "view",
                                viewType: surface.containerId,
                                placement: "editor",
                              })
                            }
                          >
                            Open {surface.title}
                          </button>
                        ))}
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={!extension.enabled || busy === `${extension.extensionId}:activate`}
                        onClick={() => void grantTrustAndActivate(extension)}
                      >
                        <ShieldCheck className="size-[14px]" strokeWidth={1.5} />
                        Trust & activate
                      </button>
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={!extension.enabled || busy === `${extension.extensionId}:activate`}
                        onClick={() => void grantTrustAndActivate(extension)}
                      >
                        <Play className="size-[14px]" strokeWidth={1.5} />
                        Activate
                      </button>
                      <button
                        type="button"
                        className={rowButtonClass}
                        disabled={busy === `${extension.extensionId}:remove`}
                        onClick={() => void removeExtension(extension)}
                      >
                        <Trash2 className="size-[14px]" strokeWidth={1.5} />
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
