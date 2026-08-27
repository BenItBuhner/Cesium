"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { ServerSetupCommand } from "@/components/preferences/ServerSetupCommand";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  accountOwnsServers,
  shouldOfferManualServerConnect,
} from "@/lib/account-server-sync";
import {
  assertEngineConnectionAllowed,
  REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE,
  normalizeServerBaseUrl,
  setStoredSessionToken,
} from "@cesium/client";
import {
  checkEngineHealth,
  getEngineAuthStatus,
  loginToEngine,
} from "@/lib/onboarding/engine-api";

export function DeviceConnectPanel({
  onConnected,
}: {
  onConnected: (serverId: string) => void;
}) {
  const cloud = useCloudContext();
  const { saveServer, setActiveServer } = useServerConnections();
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "needs-auth">("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);

  const linked = accountOwnsServers(cloud);
  const showManualByDefault = shouldOfferManualServerConnect(cloud);
  const showManual = showManualByDefault || fallbackOpen;

  const finalize = (baseUrl: string) => {
    const saved = saveServer({
      label: name.trim() || undefined,
      baseUrl,
    });
    setActiveServer(saved.id);
    onConnected(saved.id);
  };

  const testAndConnect = async (rawUrl: string) => {
    setError(null);
    setPhase("checking");
    let baseUrl: string;
    try {
      baseUrl = normalizeServerBaseUrl(rawUrl);
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
      finalize(baseUrl);
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
      finalize(baseUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("needs-auth");
    }
  };

  return (
    <div className="flex flex-col gap-[8px] px-[8px] py-[6px]">
      {linked ? (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          Install the engine on the other machine. Once it signs in, it shows up on every
          device on this account. No URL to paste.
        </p>
      ) : (
        <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
          Install the engine on the other machine (`cesium install`), then paste
          its connect URL. A bare host URL with no sign-in is rejected.
        </p>
      )}
      {linked ? <ServerSetupCommand compact accountLinked /> : null}
      {linked ? (
        <button
          type="button"
          aria-expanded={fallbackOpen}
          onClick={() => setFallbackOpen((open) => !open)}
          className="inline-flex items-center gap-[4px] self-start font-sans text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown
            className={`size-[13px] transition-transform ${fallbackOpen ? "rotate-180" : ""}`}
            strokeWidth={1.7}
            aria-hidden
          />
          Local fallback
        </button>
      ) : null}
      {showManual ? (
        <>
          {linked ? (
            <p className="font-sans text-[11px] leading-snug text-[var(--text-disabled)]">
              Paste a connect URL only for a local engine that is not attached to this
              account.
            </p>
          ) : null}
          <input
            type="url"
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            placeholder="https://your-engine.example or cesium connect URL"
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-mono text-[11.5px] text-[var(--text-primary)] outline-none"
          />
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (optional)"
            className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none"
          />
          {phase === "needs-auth" ? (
            <>
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username"
                autoComplete="username"
                className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none"
              />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none"
              />
              <button
                type="button"
                onClick={() => void submitLogin()}
                className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--bg-panel)]"
              >
                Sign in
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={phase === "checking" || !baseUrlInput.trim()}
              onClick={() => void testAndConnect(baseUrlInput)}
              className="inline-flex items-center justify-center gap-[6px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--bg-panel)] disabled:opacity-50"
            >
              {phase === "checking" ? (
                <Loader2 className="size-[13px] animate-spin" strokeWidth={2} aria-hidden />
              ) : null}
              Test & connect
            </button>
          )}
          {error ? (
            <p className="font-sans text-[11.5px] text-[var(--goal-accent)]">{error}</p>
          ) : null}
        </>
      ) : null}
      {linked ? null : <ServerSetupCommand compact />}
    </div>
  );
}
