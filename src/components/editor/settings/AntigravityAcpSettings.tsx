"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { openExternalUrl } from "@/lib/mobile-bridge";
import { notifyAgentBackendsChanged } from "@/lib/agent-backend-events";
import {
  installEngineBackendCli,
  listEngineBackends,
  type EngineBackendInfo,
  type EngineBackendInstallProgress,
} from "@/lib/onboarding/engine-api";
import {
  cancelHarnessCliAuthLogin,
  fetchHarnessCliAuth,
  relayHarnessCliAuthOAuthCallback,
  startHarnessCliAuthLogin,
  startHarnessCliAuthLogout,
  type HarnessCliAuthMethodInfo,
  type HarnessCliAuthState,
} from "@/lib/server-api";
import {
  SettingsSubsectionHeading,
  rowButtonClass,
  tagClass,
} from "@/components/editor/settings-ui";

const BACKEND_ID = "google-antigravity-acp" as const;
const DEFAULT_METHOD_ID = "oauth-personal";

const inputClass =
  "box-border min-h-[32px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

function Block({ children }: { children: ReactNode }) {
  return <section className="px-[2px]">{children}</section>;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) {
    return "?";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

const PHASE_LABELS: Record<EngineBackendInstallProgress["phase"], string> = {
  manifest: "Reading the ACP Registry manifest",
  download: "Downloading from dl.google.com",
  extract: "Extracting",
  finalize: "Finalizing",
};

/**
 * Install card for Google's official Antigravity ACP server. Mirrors Zed's
 * "Install from Registry": the engine reads the registry manifest, downloads
 * the platform zip from Google, and extracts it into its tools directory.
 */
export function AntigravityAcpInstallSettings() {
  const { activeServer, hasServer } = useServerConnections();
  const baseUrl = hasServer ? activeServer.baseUrl : null;
  const [backend, setBackend] = useState<EngineBackendInfo | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<EngineBackendInstallProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!baseUrl) {
      return;
    }
    setLoading(true);
    try {
      const result = await listEngineBackends(baseUrl);
      setBackend(result.backends.find((entry) => entry.id === BACKEND_ID) ?? null);
      setPlatform(result.platform);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load the engine's backend catalog.");
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    if (!baseUrl || installing) {
      return;
    }
    setInstalling(true);
    setMessage(null);
    setLog([]);
    setProgress({ phase: "manifest", receivedBytes: 0, totalBytes: null, percent: null });
    try {
      const result = await installEngineBackendCli(
        baseUrl,
        BACKEND_ID,
        (line) => setLog((prev) => [...prev.slice(-199), line]),
        (next) => setProgress(next)
      );
      if (result.ok) {
        setMessage(
          result.version
            ? `Installed agy_acp_server ${result.version}. Next: log in with Google below.`
            : "Installed. Next: log in with Google below."
        );
      } else {
        setMessage(result.error ?? "Install failed.");
        setShowLog(true);
      }
      notifyAgentBackendsChanged();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Install failed.");
      setShowLog(true);
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  }, [baseUrl, installing, refresh]);

  const installer = backend?.installer ?? null;
  const installed = backend?.available === true;
  const statusLabel = !baseUrl
    ? "Connect to an engine to manage the ACP server."
    : backend == null
      ? loading
        ? "Checking the engine…"
        : "The connected engine does not list Google Antigravity."
      : installed
        ? `Installed: ${backend.commandPreview ?? "agy_acp_server"}`
        : installer
          ? `Not installed on the engine host${platform ? ` (${platform})` : ""}.`
          : "Not installed, and no one-click installer is available for this host. Set OPENCURSOR_ANTIGRAVITY_ACP_BIN to a downloaded agy_acp_server.";

  return (
    <Block>
      <SettingsSubsectionHeading>ACP server</SettingsSubsectionHeading>
      <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">{statusLabel}</p>
        <p className="leading-relaxed">
          Cesium drives Google&apos;s official <span className="font-mono text-[11px] text-[var(--text-primary)]">agy_acp_server</span>{" "}
          from the ACP Registry - the same binary Zed, JetBrains, and Xcode use. It ships its own
          harness core and handles Google sign-in itself. An existing Zed registry install is detected
          automatically.
          {installer?.approxDownloadBytes ? (
            <>
              {" "}Fresh install: about {formatBytes(installer.approxDownloadBytes)} download,{" "}
              {formatBytes(installer.approxInstalledBytes)} on disk
              {installer.pinnedVersion ? ` (pinned ${installer.pinnedVersion}, newer registry versions preferred)` : ""}.
            </>
          ) : null}
        </p>
        {installing && progress ? (
          <div className="rounded-[8px] border border-[var(--border-subtle)] px-[12px] py-[10px]">
            <p className="text-[12px] text-[var(--text-primary)]">
              {PHASE_LABELS[progress.phase]}
              {progress.percent != null ? ` · ${progress.percent}%` : ""}
              {progress.phase === "download" && progress.totalBytes
                ? ` · ${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                : ""}
            </p>
            <div className="mt-[8px] h-[6px] w-full overflow-hidden rounded-full bg-[var(--bg-main)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                style={{ width: `${Math.max(2, Math.min(100, progress.percent ?? 2))}%` }}
              />
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-[8px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={!baseUrl || !installer || installing}
            onClick={() => void install()}
          >
            <Download className="size-[14px]" strokeWidth={1.5} />
            {installing
              ? "Installing…"
              : installed
                ? "Reinstall / update from registry"
                : `Install Google's ACP server${installer?.approxDownloadBytes ? ` (~${formatBytes(installer.approxDownloadBytes)})` : ""}`}
          </button>
          <button type="button" className={rowButtonClass} disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className="size-[14px]" strokeWidth={1.5} />
            Refresh
          </button>
          {log.length > 0 ? (
            <button type="button" className={rowButtonClass} onClick={() => setShowLog((value) => !value)}>
              {showLog ? "Hide log" : "Show log"}
            </button>
          ) : null}
        </div>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
        {showLog && log.length > 0 ? (
          <pre className="max-h-[220px] overflow-auto rounded-[8px] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[10px] py-[8px] font-mono text-[10.5px] leading-snug text-[var(--text-secondary)]">
            {log.join("\n")}
          </pre>
        ) : null}
      </div>
    </Block>
  );
}

function methodLabel(method: HarnessCliAuthMethodInfo | undefined, fallback: string): string {
  return method?.name ?? fallback;
}

/**
 * Google sign-in for the ACP server, driven through ACP `authenticate`.
 * The server prints the Google OAuth URL and waits on a loopback port on the
 * engine host; when the browser runs elsewhere the user pastes the redirect
 * URL back so the engine can replay it locally.
 */
export function AntigravityAcpAuthSettings() {
  const [payload, setPayload] = useState<HarnessCliAuthState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [methodId, setMethodId] = useState<string>(DEFAULT_METHOD_ID);
  const [gcpProject, setGcpProject] = useState("");
  const [gcpLocation, setGcpLocation] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [methodTouched, setMethodTouched] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchHarnessCliAuth(BACKEND_ID);
      setPayload(next);
      if (!methodTouched && next.authMethodId) {
        setMethodId(next.authMethodId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Google Antigravity sign-in status.");
    }
  }, [methodTouched]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = payload?.status === "pending" || payload?.status === "awaiting-confirmation";

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const methods = useMemo(() => payload?.authMethods ?? [], [payload?.authMethods]);
  const selectedMethod = useMemo(
    () => methods.find((method) => method.id === methodId),
    [methods, methodId]
  );

  const startLogin = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    setCallbackUrl("");
    try {
      const result = await startHarnessCliAuthLogin(BACKEND_ID, {
        methodId,
        gcpProject: selectedMethod?.requiresGcp ? gcpProject : null,
        gcpLocation: selectedMethod?.requiresGcp ? gcpLocation : null,
      });
      setPayload(result);
      if (result.status === "failed") {
        setMessage(result.error ?? "Sign-in failed to start.");
      } else if (result.status === "success") {
        setMessage(`Signed in via ${methodLabel(selectedMethod, methodId)}.`);
      } else if (result.verificationUrl) {
        openExternalUrl(result.verificationUrl, {
          features: "noopener,noreferrer,width=520,height=720",
        });
      }
      notifyAgentBackendsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start sign-in.");
    } finally {
      setBusy(false);
    }
  }, [gcpLocation, gcpProject, methodId, selectedMethod]);

  const cancelLogin = useCallback(async () => {
    setBusy(true);
    try {
      setPayload(await cancelHarnessCliAuthLogin(BACKEND_ID));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to cancel sign-in.");
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await startHarnessCliAuthLogout(BACKEND_ID);
      setPayload(result);
      setMessage(result.status === "failed" ? result.error ?? "Sign-out failed." : "Signed out of Google Antigravity on the engine host.");
      notifyAgentBackendsChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to sign out.");
    } finally {
      setBusy(false);
    }
  }, []);

  const relayCallback = useCallback(async () => {
    if (!callbackUrl.trim()) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await relayHarnessCliAuthOAuthCallback(BACKEND_ID, callbackUrl.trim());
      setPayload(result);
      if (result.status === "success") {
        setMessage("Google accepted the sign-in. You're all set.");
        setCallbackUrl("");
        notifyAgentBackendsChanged();
      } else if (result.status === "failed") {
        setMessage(result.error ?? "Google rejected the callback.");
      } else {
        setMessage("Callback forwarded; waiting for the server to finish.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not forward the callback.");
    } finally {
      setBusy(false);
    }
  }, [callbackUrl]);

  const signedIn = payload?.signedIn === true || payload?.status === "success";
  const configuredMethod = methods.find((method) => method.id === payload?.authMethodId);
  const statusLabel =
    payload == null
      ? "Loading…"
      : !payload.installed
        ? "Install the ACP server above before signing in."
        : payload.status === "awaiting-confirmation"
          ? "Waiting for you to finish signing in with Google in your browser."
          : payload.status === "pending"
            ? "Starting the ACP server sign-in…"
            : payload.status === "failed"
              ? payload.error ?? "Sign-in failed."
              : signedIn
                ? `Signed in${configuredMethod ? ` via ${configuredMethod.name}` : ""}. Credentials live under ${payload.stateHome ?? "~/.gemini"}/antigravity-acp on the engine host.`
                : payload.signedIn === null && configuredMethod
                  ? `${configuredMethod.name} is configured but has not been verified yet. Send a message or sign in again to confirm.`
                  : "Not signed in. Choose a method and sign in - Google's server completes the login itself.";

  return (
    <Block>
      <SettingsSubsectionHeading>Account</SettingsSubsectionHeading>
      <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">{statusLabel}</p>
        <p className="leading-relaxed">
          Authentication is Google&apos;s own: Cesium sends one ACP{" "}
          <span className="font-mono text-[11px] text-[var(--text-primary)]">authenticate</span> request
          and the server runs the Google OAuth flow, stores the credential, and refreshes it. Cesium
          never sees a token. Any Antigravity plan works, including the free tier; Gemini Enterprise
          is in preview.
        </p>

        {methods.length > 0 ? (
          <div className="flex flex-col gap-[6px]">
            {methods.map((method) => (
              <label
                key={method.id}
                className={`flex cursor-pointer items-start gap-[10px] rounded-[8px] border px-[12px] py-[8px] ${
                  methodId === method.id
                    ? "border-[var(--accent)] bg-[var(--accent-bg)]"
                    : "border-[var(--border-subtle)]"
                }`}
              >
                <input
                  type="radio"
                  name="antigravity-acp-auth-method"
                  className="mt-[3px]"
                  checked={methodId === method.id}
                  disabled={active}
                  onChange={() => {
                    setMethodTouched(true);
                    setMethodId(method.id);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[var(--text-primary)]">
                    {method.name}
                    {method.id === DEFAULT_METHOD_ID ? " · recommended" : ""}
                    {method.id === payload?.authMethodId && signedIn ? (
                      <span className={`${tagClass} ml-[8px]`}>current</span>
                    ) : null}
                  </span>
                  <span className="block leading-snug">{method.description}</span>
                  {method.apiKeyEnvVar ? (
                    <span className="block leading-snug">
                      {payload?.apiKeyAvailable && method.id === "gemini-api-key"
                        ? "A Gemini API key is already available to the engine."
                        : `Reads ${method.apiKeyEnvVar} from the engine environment${
                            method.id === "gemini-api-key"
                              ? " (or the Google key saved under Cesium Agent)"
                              : ""
                          }.`}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        ) : null}

        {selectedMethod?.requiresGcp ? (
          <div className="grid gap-[8px] sm:grid-cols-2">
            <label className="flex flex-col gap-[4px]">
              <span className="text-[11px] uppercase tracking-wide text-[var(--text-disabled)]">GCP project</span>
              <input
                className={inputClass}
                value={gcpProject}
                placeholder="my-gcp-project"
                disabled={active}
                onChange={(event) => setGcpProject(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-[4px]">
              <span className="text-[11px] uppercase tracking-wide text-[var(--text-disabled)]">GCP location</span>
              <input
                className={inputClass}
                value={gcpLocation}
                placeholder="us-central1"
                disabled={active}
                onChange={(event) => setGcpLocation(event.target.value)}
              />
            </label>
            {payload?.gcpConfigured ? (
              <p className="sm:col-span-2">A project and location are already saved on the engine; leave these blank to keep them.</p>
            ) : null}
          </div>
        ) : null}

        {payload?.verificationUrl && active ? (
          <div className="flex flex-col gap-[10px] rounded-[8px] border border-[var(--border-subtle)] px-[12px] py-[10px]">
            <p className="text-[12px] text-[var(--text-primary)]">
              Open{" "}
              <a
                href={payload.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2"
              >
                Google sign-in
              </a>{" "}
              and pick your account. Google redirects back to{" "}
              <span className="font-mono text-[11px]">
                127.0.0.1{payload.callbackPort ? `:${payload.callbackPort}` : ""}
              </span>{" "}
              on the engine host.
            </p>
            <p className="leading-snug">
              Browser on a different machine than the engine? The redirect will show a
              &quot;connection refused&quot; page. Copy that page&apos;s full URL and paste it here so the
              engine can complete the sign-in for you.
            </p>
            <div className="flex flex-wrap items-center gap-[8px]">
              <input
                className={`${inputClass} min-w-[220px] flex-1 font-mono text-[11px]`}
                value={callbackUrl}
                placeholder="http://127.0.0.1:PORT/?state=...&code=..."
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy || !callbackUrl.trim()}
                onClick={() => void relayCallback()}
              >
                Complete sign-in
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-[8px]">
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy || active || payload?.installed === false}
            onClick={() => void startLogin()}
          >
            <ExternalLink className="size-[14px]" strokeWidth={1.5} />
            {signedIn
              ? `Sign in again (${methodLabel(selectedMethod, methodId)})`
              : methodLabel(selectedMethod, "Log in with Google")}
          </button>
          {signedIn ? (
            <button type="button" className={rowButtonClass} disabled={busy || active} onClick={() => void signOut()}>
              Sign out
            </button>
          ) : null}
          {active ? (
            <button type="button" className={rowButtonClass} disabled={busy} onClick={() => void cancelLogin()}>
              Cancel
            </button>
          ) : null}
          <button type="button" className={rowButtonClass} onClick={() => void refresh()}>
            <RefreshCw className="size-[14px]" strokeWidth={1.5} />
            Refresh status
          </button>
        </div>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
        <p className="leading-relaxed">
          Note: Google&apos;s server reports free-tier data handling for some paid accounts (an
          upstream issue). Review the Antigravity privacy notice before pointing it at private code.
          The ACP server keeps its own credential store, separate from the{" "}
          <span className="font-mono text-[11px] text-[var(--text-primary)]">agy</span> CLI login and the
          Antigravity IDE.
        </p>
      </div>
    </Block>
  );
}

export function AntigravityAcpHarnessSettings() {
  return (
    <>
      <AntigravityAcpInstallSettings />
      <AntigravityAcpAuthSettings />
    </>
  );
}
