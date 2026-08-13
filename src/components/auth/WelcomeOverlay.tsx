"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ChevronDown,
  LockKeyhole,
  RefreshCw,
  Server,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { CloudAccountChip } from "@/components/setup/CloudAccountChip";
import { useCloudContext } from "@/contexts/CloudContext";

/**
 * The redesigned entry surface. The workbench shell always renders; this
 * overlay appears above it only while the active engine is unusable — either
 * unreachable (connect as a guest or sign in to restore your servers) or
 * asking for engine credentials. It never replaces the app tree, so settings
 * and the rest of the shell stay reachable underneath.
 */

const inputClass =
  "box-border h-[40px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]";

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

function AccountSection() {
  const cloud = useCloudContext();
  if (cloud.mode === "disabled") {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-[8px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[12px]">
      <div className="flex items-center gap-[8px]">
        <Sparkles className="size-[14px] shrink-0 text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
        <p className="font-sans text-[12.5px] font-medium text-[var(--text-primary)]">
          Your account
        </p>
      </div>
      <p className="font-sans text-[12px] leading-[1.5] text-[var(--text-secondary)]">
        {cloud.status === "signed-out"
          ? "Sign in to restore your engines, theme, and personalization on this device."
          : "Your engines and personalization follow this account across devices."}
      </p>
      <div className="mt-[2px]">
        <CloudAccountChip />
      </div>
    </div>
  );
}

function EngineCredentialsForm() {
  const { login, loginPending, error, session, logout } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await login({ username, password, remember });
    setPassword("");
  };

  return (
    <form className="flex flex-col gap-[10px]" onSubmit={handleSubmit}>
      <input
        type="text"
        autoComplete="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        className={inputClass}
        placeholder="Username"
        required
      />
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className={inputClass}
        placeholder="Password"
        required
      />
      <label className="inline-flex min-w-0 items-center gap-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          className="size-[14px] rounded-[var(--radius-checkbox)] border border-[var(--border-card)] bg-[var(--bg-main)] accent-[var(--accent)]"
        />
        Remember this session
      </label>
      {error ? (
        <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
          {error}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={loginPending}
        className="inline-flex h-[42px] items-center justify-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[13px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--bg-panel)]"
      >
        {loginPending ? "Signing in..." : "Unlock engine"}
        {!loginPending ? <ArrowRight className="size-[14px]" strokeWidth={2} aria-hidden /> : null}
      </button>
      {session ? (
        <button
          type="button"
          onClick={() => void logout()}
          className="self-start font-sans text-[11.5px] text-[var(--text-secondary)] underline-offset-2 hover:underline"
        >
          Clear saved session
        </button>
      ) : null}
    </form>
  );
}

export function WelcomeOverlay() {
  const { ready, enabled, authenticated, connectionError, refreshAuthStatus } = useAuth();
  const { activeServer, serverStatusById, setActiveServer } = useServerConnections();
  /** null = automatic (open while connecting as a guest, closed for engine sign-in). */
  const [serversOpenOverride, setServersOpenOverride] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const activeHealth = serverStatusById[activeServer.id]?.health ?? "unknown";
  const needsEngineAuth =
    (enabled && !authenticated) || activeHealth === "auth_required";
  const engineUnreachable = Boolean(connectionError) && !needsEngineAuth;
  const blocked = ready && (needsEngineAuth || engineUnreachable);

  const mode: "auth" | "connect" = needsEngineAuth ? "auth" : "connect";
  const serversOpen = serversOpenOverride ?? mode === "connect";

  const serverChip = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-[10px] rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[12px] py-[9px]">
        <Server className="size-[15px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-[12.5px] font-medium text-[var(--text-primary)]">
            {activeServer.label}
          </p>
          <p
            className="truncate font-mono text-[11px] text-[var(--text-secondary)]"
            title={activeServer.baseUrl}
          >
            {activeServer.baseUrl}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setServersOpenOverride(!serversOpen)}
          className="inline-flex shrink-0 items-center gap-[5px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[5px] font-sans text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          Switch
          <ChevronDown
            className={`size-[12px] transition-transform ${serversOpen ? "rotate-180" : ""}`}
            strokeWidth={1.75}
            aria-hidden
          />
        </button>
      </div>
    ),
    [activeServer.baseUrl, activeServer.label, serversOpen]
  );

  if (!blocked || dismissed) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[9000] overflow-y-auto overscroll-contain bg-[color-mix(in_srgb,var(--bg-main)_62%,transparent)] backdrop-blur-[7px]"
      role="dialog"
      aria-modal="false"
      aria-label={mode === "auth" ? "Sign in to your engine" : "Connect an engine"}
    >
      <div className="mobile-safe-top-content flex min-h-full items-start justify-center px-4 py-6 sm:items-center sm:px-6 sm:py-10">
        <div className="w-full max-w-[480px]">
          <div className="rounded-[calc(var(--radius-card)+4px)] border border-[var(--border-card)] bg-[var(--bg-card)] p-5 shadow-[var(--palette-shadow)] sm:p-7">
            <div className="mb-5 flex items-center gap-[12px]">
              <CesiumMark className="h-[30px] w-auto shrink-0 text-[var(--text-primary)]" />
              <div className="min-w-0">
                <h1 className="font-sans text-[19px] font-semibold leading-tight tracking-tight text-[var(--text-primary)]">
                  {mode === "auth" ? "Unlock your engine" : "Welcome to Cesium"}
                </h1>
                <p className="mt-[2px] font-sans text-[12.5px] leading-[1.45] text-[var(--text-secondary)]">
                  {mode === "auth"
                    ? "This engine asks for credentials before it exposes files, terminals, and agents."
                    : "Sign in to restore your setup, or connect an engine as a guest."}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-[14px]">
              <AccountSection />

              <div className="flex min-w-0 flex-col gap-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] px-[14px] py-[12px]">
                <div className="flex items-center gap-[8px]">
                  {mode === "auth" ? (
                    <LockKeyhole className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Server className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.75} aria-hidden />
                  )}
                  <p className="font-sans text-[12.5px] font-medium text-[var(--text-primary)]">
                    {mode === "auth" ? "Engine sign-in" : "Your engine"}
                  </p>
                </div>

                {serverChip}

                {serversOpen ? (
                  <div className="max-h-[min(48vh,380px)] min-w-0 overflow-y-auto overscroll-contain rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-3 py-2">
                    <ServerConnectionsManager
                      compact
                      onActivate={(serverId) => {
                        setActiveServer(serverId);
                        setServersOpenOverride(false);
                      }}
                    />
                  </div>
                ) : null}

                {mode === "auth" ? (
                  <EngineCredentialsForm />
                ) : (
                  <div className="flex flex-col gap-[10px]">
                    <div className="rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--debug-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--debug-accent-bg)_82%,transparent)] px-[11px] py-[9px] font-sans text-[12px] leading-[1.45] text-[var(--text-primary)]">
                      {connectionError ?? "The selected engine could not be reached."}
                    </div>
                    <p className="font-sans text-[12px] leading-[1.5] text-[var(--text-secondary)]">
                      Guest mode keeps everything on this device: point Cesium at an engine you run
                      (locally or on your own machine) and start working — no account needed.
                    </p>
                    <button
                      type="button"
                      onClick={() => void refreshAuthStatus().catch(() => undefined)}
                      className="inline-flex h-[38px] items-center justify-center gap-[7px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                    >
                      <RefreshCw className="size-[13px]" strokeWidth={1.75} aria-hidden />
                      Retry connection
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-[10px] border-t border-[var(--border-subtle)] pt-[14px]">
              <Link
                href="/setup"
                className="font-sans text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                Full setup guide
              </Link>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="font-sans text-[12px] text-[var(--text-disabled)] underline-offset-2 transition-colors hover:text-[var(--text-secondary)] hover:underline"
              >
                Explore the workbench anyway
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
