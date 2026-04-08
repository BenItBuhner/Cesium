"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, LogOut } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, session, loginPending, error, login, logout } =
    useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await login({
      username,
      password,
      remember,
    });
    setPassword("");
  };

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-main)] px-6">
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-5 py-4 font-sans text-[13px] text-[var(--text-secondary)] shadow-[var(--palette-shadow)]">
          Checking authentication...
        </div>
      </div>
    );
  }

  if (!enabled || authenticated) {
    return <>{children}</>;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-main)] px-6 py-10">
      <div className="w-full max-w-[420px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-6 shadow-[var(--palette-shadow)]">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex size-[36px] items-center justify-center rounded-[10px] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)]">
              <LockKeyhole className="size-[18px]" strokeWidth={1.8} />
            </div>
            <h1 className="font-sans text-[20px] font-semibold text-[var(--text-primary)]">
              Sign in to OpenCursor
            </h1>
            <p className="mt-2 font-sans text-[13px] leading-[1.5] text-[var(--text-secondary)]">
              This server requires authentication before workspace files, terminals, and agent
              events can be accessed.
            </p>
          </div>
          {session ? (
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              <LogOut className="size-[14px]" strokeWidth={1.8} />
              Clear
            </button>
          ) : null}
        </div>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-[6px]">
            <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
              Username
            </span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
              placeholder="Username"
              required
            />
          </label>

          <label className="flex flex-col gap-[6px]">
            <span className="font-sans text-[12px] font-medium text-[var(--text-secondary)]">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
              placeholder="Password"
              required
            />
          </label>

          <label className="mt-1 inline-flex items-center gap-[8px] font-sans text-[12px] text-[var(--text-secondary)]">
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
            className="mt-2 inline-flex h-[40px] items-center justify-center rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] font-sans text-[13px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[var(--bg-panel)]"
          >
            {loginPending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
