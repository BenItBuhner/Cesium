"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, LogOut } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  clearAuthLoginDraft,
  readAuthLoginDraft,
  writeAuthLoginDraft,
} from "@/lib/auth-client";
import { postDebugLog } from "@/lib/debug-auth-log-client";

export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, enabled, authenticated, session, loginPending, error, login, logout } =
    useAuth();
  const [username, setUsername] = useState(
    () => readAuthLoginDraft()?.username ?? ""
  );
  const [password, setPassword] = useState(
    () => readAuthLoginDraft()?.password ?? ""
  );
  const [remember, setRemember] = useState(
    () => readAuthLoginDraft()?.remember ?? true
  );
  const usernameInputRef = useRef<HTMLInputElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const latestSnapshotRef = useRef<Record<string, unknown> | null>(null);

  const snapshot = {
    ready,
    enabled,
    authenticated,
    loginPending,
    usernameStateLen: username.length,
    passwordStateLen: password.length,
    usernameDomLen: usernameInputRef.current?.value.length ?? null,
    passwordDomLen: passwordInputRef.current?.value.length ?? null,
    activeElement:
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement.tagName
        : null,
    activeElementType:
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLInputElement
        ? document.activeElement.type
        : null,
    hasError: Boolean(error),
    sessionUsername: session?.username ?? null,
  };
  latestSnapshotRef.current = snapshot;

  useEffect(() => {
    // #region agent log
    postDebugLog({
      hypothesisId: "A",
      location: "src/components/auth/AuthGate.tsx:18",
      message: "AuthGate mounted",
      data: latestSnapshotRef.current ?? {},
      timestamp: Date.now(),
    });
    // #endregion
    return () => {
      // #region agent log
      postDebugLog({
        hypothesisId: "A",
        location: "src/components/auth/AuthGate.tsx:28",
        message: "AuthGate unmounted",
        data: latestSnapshotRef.current ?? {},
        timestamp: Date.now(),
      });
      // #endregion
    };
  }, []);

  /** After SSR hydration, restore draft (sessionStorage is unavailable on the server). */
  useEffect(() => {
    const draft = readAuthLoginDraft();
    if (!draft || (!draft.username && !draft.password)) {
      return;
    }
    setUsername(draft.username);
    setPassword(draft.password);
    setRemember(draft.remember);
  }, []);

  useEffect(() => {
    if (authenticated) {
      clearAuthLoginDraft();
    }
  }, [authenticated]);

  useEffect(() => {
    if (!ready || !enabled || authenticated) {
      return;
    }
    writeAuthLoginDraft({ username, password, remember });
  }, [authenticated, enabled, password, ready, remember, username]);

  useEffect(() => {
    // #region agent log
    postDebugLog({
      hypothesisId: "C",
      location: "src/components/auth/AuthGate.tsx:41",
      message: "AuthGate snapshot",
      data: latestSnapshotRef.current ?? {},
      timestamp: Date.now(),
    });
    // #endregion
  }, [
    authenticated,
    enabled,
    error,
    loginPending,
    password,
    ready,
    session?.username,
    username,
  ]);

  const logFieldInteraction = (phase: "focus" | "blur", field: "username" | "password") => {
    // #region agent log
    postDebugLog({
      hypothesisId: "B",
      location: "src/components/auth/AuthGate.tsx:60",
      message: "Field interaction",
      data: {
        phase,
        field,
        ...snapshot,
      },
      timestamp: Date.now(),
    });
    // #endregion
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ok = await login({
      username,
      password,
      remember,
    });
    if (ok) {
      clearAuthLoginDraft();
    }
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
              ref={usernameInputRef}
              value={username}
              onFocus={() => logFieldInteraction("focus", "username")}
              onBlur={() => logFieldInteraction("blur", "username")}
              onChange={(event) => {
                // #region agent log
                postDebugLog({
                  hypothesisId: "B",
                  location: "src/components/auth/AuthGate.tsx:84",
                  message: "Username change",
                  data: {
                    nextLen: event.target.value.length,
                    previousLen: username.length,
                    passwordStateLen: password.length,
                    passwordDomLen: passwordInputRef.current?.value.length ?? null,
                  },
                  timestamp: Date.now(),
                });
                // #endregion
                setUsername(event.target.value);
              }}
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
              ref={passwordInputRef}
              value={password}
              onFocus={() => logFieldInteraction("focus", "password")}
              onBlur={() => logFieldInteraction("blur", "password")}
              onChange={(event) => {
                // #region agent log
                postDebugLog({
                  hypothesisId: "B",
                  location: "src/components/auth/AuthGate.tsx:111",
                  message: "Password change",
                  data: {
                    nextLen: event.target.value.length,
                    previousLen: password.length,
                    usernameStateLen: username.length,
                    usernameDomLen: usernameInputRef.current?.value.length ?? null,
                  },
                  timestamp: Date.now(),
                });
                // #endregion
                setPassword(event.target.value);
              }}
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
