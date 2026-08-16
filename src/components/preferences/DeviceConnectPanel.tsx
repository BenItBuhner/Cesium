"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { ServerSetupCommand } from "@/components/preferences/ServerSetupCommand";
import { normalizeServerBaseUrl, setStoredSessionToken } from "@cesium/client";
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
  const { saveServer, setActiveServer } = useServerConnections();
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "needs-auth">("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      if (auth.enabled && !auth.authenticated) {
        setBaseUrlInput(baseUrl);
        setPhase("needs-auth");
        return;
      }
      finalize(baseUrl);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not reach the engine: ${err.message}`
          : "Could not reach the engine."
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
      <p className="font-sans text-[11.5px] leading-snug text-[var(--text-secondary)]">
        Paste an engine URL, or install Cesium on the other machine and paste the connect URL it prints.
      </p>
      <input
        type="url"
        value={baseUrlInput}
        onChange={(event) => setBaseUrlInput(event.target.value)}
        placeholder="http://192.168.1.12:9100"
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
      <ServerSetupCommand compact />
    </div>
  );
}
