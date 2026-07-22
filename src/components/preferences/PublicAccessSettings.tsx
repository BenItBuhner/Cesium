"use client";

import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  attachSessionToken,
  setStoredSessionToken,
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
  type AuthSession,
} from "@/lib/auth-client";
import {
  SettingsFieldLabel,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useAuth } from "@/components/auth/AuthProvider";

type PublicAccessStatus = {
  configured: boolean;
  enabled: boolean;
  webAppUrl: string | null;
  provider: "auto" | "localhost-run" | "cloudflare-quick" | "custom" | null;
  customPublicUrl: string | null;
  publicUrl: string | null;
  connectUrl: string | null;
  auth: {
    enabled: boolean;
    username: string | null;
    credentialsManagerGenerated: boolean;
    externallyConfigured: boolean;
  };
  tunnel: {
    running: boolean;
    provider: string | null;
    lastError: string | null;
  };
  rendezvous: {
    lastPublishedAt: number | null;
    lastError: string | null;
  };
};

type GeneratedCredentials = {
  username: string;
  password: string;
};

const inputClass =
  "box-border w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[7px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

function defaultWebAppUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.protocol === "http:" || window.location.protocol === "https:"
    ? window.location.origin
    : "";
}

export function PublicAccessSettings({
  serverBaseUrl,
}: {
  serverBaseUrl: string;
}) {
  const { refreshAuthStatus } = useAuth();
  const [status, setStatus] = useState<PublicAccessStatus | null>(null);
  const [webAppUrl, setWebAppUrl] = useState(defaultWebAppUrl);
  const [provider, setProvider] = useState<"auto" | "localhost-run" | "cloudflare-quick">(
    "auto"
  );
  const [customPublicUrl, setCustomPublicUrl] = useState("");
  const [credentials, setCredentials] = useState<GeneratedCredentials | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const request = useCallback(
    async (pathname: string, init?: RequestInit) => {
      const response = await fetch(`${serverBaseUrl}${pathname}`, {
        ...init,
        headers: attachSessionToken(init?.headers, serverBaseUrl),
        credentials: "include",
        cache: "no-store",
      });
      syncAuthTokenFromResponse(response, serverBaseUrl);
      const payload = (await response.json().catch(() => ({}))) as
        | (Record<string, unknown> & { error?: string })
        | PublicAccessStatus;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Public access request failed (${response.status}).`
        );
      }
      return payload;
    },
    [serverBaseUrl]
  );

  const refresh = useCallback(async () => {
    try {
      const next = (await request("/api/public-access/status")) as PublicAccessStatus;
      setStatus(next);
      setWebAppUrl(next.webAppUrl ?? defaultWebAppUrl());
      setProvider(
        next.provider === "localhost-run" || next.provider === "cloudflare-quick"
          ? next.provider
          : "auto"
      );
      setCustomPublicUrl(next.customPublicUrl ?? "");
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Public access is unavailable.");
    }
  }, [request]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const loginGeneratedCredentials = useCallback(
    async (nextCredentials: GeneratedCredentials) => {
      const response = await fetch(`${serverBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({
          username: nextCredentials.username,
          password: nextCredentials.password,
          remember: true,
        }),
      });
      syncAuthTokenFromResponse(response, serverBaseUrl);
      const payload = (await response.json().catch(() => ({}))) as {
        authenticated?: boolean;
        session?: AuthSession | null;
        token?: string;
        error?: string;
      };
      if (!response.ok || payload.authenticated !== true || !payload.session) {
        throw new Error(payload.error || "Public access enabled, but automatic sign-in failed.");
      }
      if (payload.token) {
        setStoredSessionToken(payload.token, payload.session, serverBaseUrl);
      }
      updateStoredAuthSession(payload.session, serverBaseUrl);
      await refreshAuthStatus();
    },
    [refreshAuthStatus, serverBaseUrl]
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (pending) return;
      setPending(true);
      setError(null);
      setCredentials(null);
      try {
        if (!enabled) {
          const next = (await request("/api/public-access/disable", {
            method: "POST",
          })) as PublicAccessStatus;
          setStatus(next);
          await refreshAuthStatus();
          return;
        }
        const result = (await request("/api/public-access/enable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            webAppUrl,
            provider,
            customPublicUrl: customPublicUrl.trim() || null,
          }),
        })) as {
          status: PublicAccessStatus;
          generatedCredentials?: GeneratedCredentials;
        };
        if (result.generatedCredentials) {
          await loginGeneratedCredentials(result.generatedCredentials);
          setCredentials(result.generatedCredentials);
        }
        setStatus(result.status);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Public access update failed.");
        await refresh();
      } finally {
        setPending(false);
      }
    },
    [
      customPublicUrl,
      loginGeneratedCredentials,
      pending,
      provider,
      refresh,
      request,
      refreshAuthStatus,
      webAppUrl,
    ]
  );

  const rotateCredentials = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = (await request("/api/public-access/rotate-auth", {
        method: "POST",
      })) as GeneratedCredentials & { status: PublicAccessStatus };
      const nextCredentials = { username: result.username, password: result.password };
      await loginGeneratedCredentials(nextCredentials);
      setCredentials(nextCredentials);
      setStatus(result.status);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Credential rotation failed.");
    } finally {
      setPending(false);
    }
  }, [loginGeneratedCredentials, pending, request]);

  const copy = useCallback(async (key: string, value: string | null | undefined) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
  }, []);

  const enabled = status?.enabled === true;
  const statusText = enabled
    ? status?.tunnel.running && status.connectUrl
      ? `Online through ${status.tunnel.provider ?? "secure tunnel"}`
      : "Starting secure tunnel..."
    : "Only this device can reach the backend.";

  return (
    <SettingsSection title="Public access">
      <SettingsRow
        title="Share this backend"
        description={statusText}
        searchId="public-access"
        trailing={
          <ToggleSwitch
            checked={enabled}
            onChange={(next) => void setEnabled(next)}
            variant="green"
          />
        }
      />
      <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
        <div className="grid gap-[10px] md:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-[6px]">
            <SettingsFieldLabel>Cesium web app URL</SettingsFieldLabel>
            <input
              type="url"
              value={webAppUrl}
              onChange={(event) => setWebAppUrl(event.target.value)}
              disabled={pending || enabled}
              placeholder="https://your-cesium.vercel.app"
              className={inputClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-[6px]">
            <SettingsFieldLabel>Tunnel provider</SettingsFieldLabel>
            <select
              value={provider}
              onChange={(event) =>
                setProvider(
                  event.target.value as "auto" | "localhost-run" | "cloudflare-quick"
                )
              }
              disabled={pending || enabled}
              className={inputClass}
            >
              <option value="auto">Automatic</option>
              <option value="localhost-run">localhost.run</option>
              <option value="cloudflare-quick">Cloudflare Quick Tunnel</option>
            </select>
          </label>
        </div>
        <label className="mt-[10px] flex min-w-0 flex-col gap-[6px]">
          <SettingsFieldLabel>Custom backend URL (optional, advanced)</SettingsFieldLabel>
          <input
            type="url"
            value={customPublicUrl}
            onChange={(event) => setCustomPublicUrl(event.target.value)}
            disabled={pending || enabled}
            placeholder="https://server.example.com"
            className={inputClass}
          />
          <span className="font-sans text-[10.5px] text-[var(--text-disabled)]">
            The generated Cesium connection link is already permanent. Set this only when an
            existing HTTPS reverse proxy points to this backend.
          </span>
        </label>
      </div>
      {status?.connectUrl ? (
        <SettingsRow
          title="Permanent connection link"
          description={status.connectUrl}
          searchId="stable-link"
          trailing={
            <div className="flex items-center gap-[6px]">
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => void copy("link", status.connectUrl)}
              >
                {copied === "link" ? (
                  <Check className="size-[13px]" aria-hidden />
                ) : (
                  <Copy className="size-[13px]" aria-hidden />
                )}
                {copied === "link" ? "Copied" : "Copy"}
              </button>
              <a
                href={status.connectUrl}
                target="_blank"
                rel="noreferrer"
                className={rowButtonClass}
              >
                <ExternalLink className="size-[13px]" aria-hidden />
                Open
              </a>
            </div>
          }
        />
      ) : null}
      <SettingsRow
        title="Connection credentials"
        description={
          credentials
            ? `${credentials.username} · password shown until you leave this page`
            : status?.auth.externallyConfigured
              ? "Managed by this server's environment."
              : status?.auth.username
                ? `${status.auth.username} · rotate to reveal a new password`
                : "Generated automatically when public access is enabled."
        }
        searchId="server-credentials"
        border={!error}
        trailing={
          <div className="flex items-center gap-[6px]">
            {credentials ? (
              <button
                type="button"
                className={rowButtonClass}
                onClick={() =>
                  void copy(
                    "credentials",
                    `Username: ${credentials.username}\nPassword: ${credentials.password}`
                  )
                }
              >
                {copied === "credentials" ? (
                  <Check className="size-[13px]" aria-hidden />
                ) : (
                  <Copy className="size-[13px]" aria-hidden />
                )}
                {copied === "credentials" ? "Copied" : "Copy"}
              </button>
            ) : null}
            {enabled && status?.auth.credentialsManagerGenerated ? (
              <button
                type="button"
                className={rowButtonClass}
                disabled={pending}
                onClick={() => void rotateCredentials()}
              >
                <RefreshCw className={`size-[13px] ${pending ? "animate-spin" : ""}`} aria-hidden />
                Rotate
              </button>
            ) : null}
          </div>
        }
      />
      {credentials ? (
        <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-main)] px-[16px] py-[10px] font-mono text-[11px] text-[var(--text-primary)]">
          <p>Username: {credentials.username}</p>
          <p className="mt-[3px] break-all">Password: {credentials.password}</p>
        </div>
      ) : null}
      {error || status?.tunnel.lastError || status?.rendezvous.lastError ? (
        <div className="border-t border-[var(--border-subtle)] px-[16px] py-[10px] font-sans text-[11px] text-[var(--debug-accent)]">
          {error || status?.tunnel.lastError || status?.rendezvous.lastError}
        </div>
      ) : null}
    </SettingsSection>
  );
}
