"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Server } from "lucide-react";
import {
  assertEngineConnectionAllowed,
  CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE,
  isCesiumAccountSiteUrl,
  REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE,
  getConfiguredServerBaseUrl,
  getStoredSessionToken,
  markServerConnectionUsed,
  normalizeServerBaseUrl,
  readStoredServerConnectionsState,
  setStoredSessionToken,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "@cesium/client";
import { ServerSetupCommand } from "@/components/preferences/ServerSetupCommand";
import { useCloudContext, type CloudServer } from "@/contexts/CloudContext";
import {
  checkEngineHealth,
  getEngineAuthStatus,
  loginToEngine,
} from "@/lib/onboarding/engine-api";

/**
 * Step 1 - connect your first engine. Verifies the URL with `/health`,
 * handles password-protected engines via the session-token flow, persists the
 * connection locally, and mirrors it (token included) to the cloud so any
 * future device reconnects instantly.
 */
export function ConnectServerStep({
  onConnected,
}: {
  onConnected: (baseUrl: string) => void;
}) {
  const cloud = useCloudContext();
  const [baseUrlInput, setBaseUrlInput] = useState(() => {
    const configured = getConfiguredServerBaseUrl();
    return isCesiumAccountSiteUrl(configured) ? "" : configured;
  });
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "needs-auth" | "connected">(
    "idle"
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);

  const cloudServers = cloud.bootstrap?.servers ?? [];

  const finalizeConnection = (baseUrl: string, sessionToken: string | null) => {
    const state = readStoredServerConnectionsState(getConfiguredServerBaseUrl());
    const next = upsertServerConnection(state, {
      label: name.trim() || undefined,
      baseUrl,
    });
    const server = next.servers.find((entry) => entry.baseUrl === baseUrl);
    writeStoredServerConnectionsState(
      server ? markServerConnectionUsed(next, server.id) : next
    );
    if (cloud.actions) {
      void cloud.actions
        .saveServer({
          name: name.trim() || server?.label || baseUrl,
          baseUrl,
          kind: "remote",
          markConnected: true,
          ...(sessionToken ? { sessionToken } : {}),
        })
        .catch(() => undefined);
    }
    setConnectedUrl(baseUrl);
    setPhase("connected");
    onConnected(baseUrl);
  };

  const testAndConnect = async (rawUrl: string) => {
    setError(null);
    setPhase("checking");
    let baseUrl: string;
    try {
      baseUrl = normalizeServerBaseUrl(rawUrl);
      if (isCesiumAccountSiteUrl(baseUrl)) {
        setError(CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE);
        setPhase("idle");
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
      return;
    }
    try {
      await checkEngineHealth(baseUrl);
      const auth = await getEngineAuthStatus(baseUrl);
      assertEngineConnectionAllowed({
        baseUrl,
        authEnabled: auth.enabled,
      });
      if (auth.enabled && !auth.authenticated) {
        setBaseUrlInput(baseUrl);
        setPhase("needs-auth");
        return;
      }
      finalizeConnection(baseUrl, getStoredSessionToken(baseUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not reach the engine.";
      setError(
        message === REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE
          ? message
          : `Could not reach the engine: ${message}`
      );
      setPhase("idle");
    }
  };

  const submitLogin = async () => {
    setError(null);
    setPhase("checking");
    try {
      const baseUrl = normalizeServerBaseUrl(baseUrlInput);
      const { token } = await loginToEngine(baseUrl, username, password);
      setStoredSessionToken(token, null, baseUrl);
      finalizeConnection(baseUrl, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("needs-auth");
    }
  };

  const connectCloudServer = async (server: CloudServer) => {
    setBaseUrlInput(server.baseUrl);
    setName(server.name);
    if (server.sessionToken && !getStoredSessionToken(server.baseUrl)) {
      setStoredSessionToken(server.sessionToken, null, server.baseUrl);
    }
    await testAndConnect(server.baseUrl);
  };

  if (phase === "connected" && connectedUrl) {
    return (
      <div className="flex items-center gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[18px]">
        <CheckCircle2 className="size-[20px] text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
        <div>
          <p className="text-[14px] font-medium text-[var(--text-primary)]">
            Connected to {connectedUrl}
          </p>
          <p className="text-[12.5px] text-[var(--text-secondary)]">
            {cloud.actions
              ? "Saved to your cloud account - future devices reconnect automatically."
              : "Saved on this device."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-[16px]">
      {cloudServers.length > 0 ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[16px]">
          <p className="mb-[10px] font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-disabled)]">
            Your servers, from the cloud
          </p>
          <div className="space-y-[8px]">
            {cloudServers.map((server) => (
              <button
                key={server.baseUrl}
                type="button"
                onClick={() => void connectCloudServer(server)}
                className="flex w-full items-center gap-[10px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[10px] text-left transition-colors hover:bg-[var(--bg-card-hover)]"
              >
                <Server className="size-[15px] text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
                <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                  {server.name}
                </span>
                <span className="ml-auto truncate font-mono text-[11px] text-[var(--text-disabled)]">
                  {server.baseUrl}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {cloud.mode === "clerk" && cloud.status === "signed-out" ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[14px] py-[12px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Sign in with the header control to use production sync. You can still
          attach a local engine, or install one with the command below.
        </p>
      ) : null}

      <ServerSetupCommand />

      <div className="space-y-[10px]">
        <label className="block">
          <span className="mb-[6px] block text-[12.5px] font-medium text-[var(--text-secondary)]">
            Engine URL
          </span>
          <input
            type="url"
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            placeholder="http://localhost:9100"
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[9px] font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-[6px] block text-[12.5px] font-medium text-[var(--text-secondary)]">
            Name <span className="text-[var(--text-disabled)]">(optional)</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My workstation"
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[9px] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>

        {phase === "needs-auth" ? (
          <div className="space-y-[10px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[14px]">
            <p className="text-[12.5px] text-[var(--text-secondary)]">
              This engine requires a login.
            </p>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
              autoComplete="username"
              className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[9px] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[9px] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => void submitLogin()}
              className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[16px] py-[8px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
            >
              Sign in to engine
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={phase === "checking"}
            onClick={() => void testAndConnect(baseUrlInput)}
            className="inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[16px] py-[9px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            {phase === "checking" ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={2} aria-hidden />
            ) : null}
            Test &amp; connect
          </button>
        )}

        {error ? (
          <p className="text-[12.5px] text-[var(--goal-accent)]">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
