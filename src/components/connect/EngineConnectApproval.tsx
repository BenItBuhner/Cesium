"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import {
  bootstrapStoredServerConnection,
  getConfiguredServerBaseUrl,
  setStoredSessionToken,
} from "@cesium/client";
import { api } from "@convex/_generated/api";
import { CesiumMark } from "@/components/ui/CesiumMark";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  claimEnginePairing,
  isEnginePairingCode,
  engineAuthSecretKind,
  sealEngineCredential,
  setPendingEngineConnect,
} from "@/lib/cloud/engine-pairing";
import { loginToEngine } from "@/lib/onboarding/engine-api";
import { WORKSPACE_ROUTE } from "@/lib/workbench-view";

const accentButtonClass =
  "inline-flex w-full items-center justify-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[12px] text-[14px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60";
const outlineButtonClass =
  "inline-flex w-full items-center justify-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[12px] text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]";

type AttachPhase =
  | { kind: "idle" }
  | { kind: "working"; step: string }
  | { kind: "done"; label: string }
  | { kind: "error"; message: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen overflow-y-auto bg-[var(--bg-main)] text-[var(--text-primary)]">
      <div className="mx-auto flex min-h-screen max-w-[440px] flex-col justify-center px-[24px] py-[48px]">
        <div className="mb-[28px] flex items-center gap-[10px]">
          <CesiumMark className="h-[22px] w-auto text-[var(--text-primary)]" />
          <span className="text-[15px] font-semibold tracking-tight">Cesium</span>
        </div>
        {children}
      </div>
    </main>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <Frame>
      <h1 className="text-balance text-[28px] font-semibold leading-[1.15] tracking-tight">{title}</h1>
      <p className="mt-[14px] text-pretty text-[14px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
      {action ? <div className="mt-[24px] flex flex-col gap-[10px]">{action}</div> : null}
    </Frame>
  );
}

export function EngineConnectApproval({ code }: { code: string }) {
  const cloud = useCloudContext();
  const normalizedCode = code.trim().toLowerCase();
  const validCode = isEnginePairingCode(normalizedCode);

  // Remember the code before any sign-in redirect can lose it.
  useEffect(() => {
    if (validCode && cloud.status !== "ready") {
      setPendingEngineConnect(normalizedCode);
    }
  }, [cloud.status, normalizedCode, validCode]);

  if (!validCode) {
    return (
      <Notice
        title="That connect link is not valid."
        body="Run `cesium-server connect` on the engine and open the link it prints."
      />
    );
  }
  if (cloud.mode === "disabled") {
    return (
      <Notice
        title="Cloud sync is off on this device."
        body="Attaching an engine to your account needs Cesium Cloud. Turn it on under Settings → Account → Cloud sync, or connect manually with the details from `cesium-server connect --legacy`."
        action={
          <Link href={WORKSPACE_ROUTE} className={outlineButtonClass}>
            Open workbench
          </Link>
        }
      />
    );
  }
  return <EngineConnectApprovalInner code={normalizedCode} />;
}

function EngineConnectApprovalInner({ code }: { code: string }) {
  const cloud = useCloudContext();
  const [now, setNow] = useState(() => Date.now());
  const [phase, setPhase] = useState<AttachPhase>({ kind: "idle" });
  // Client clock for the deterministic lookup query (see convex/pairings.ts).
  const [lookupClock] = useState(() => Date.now());
  const lookup = useQuery(api.pairings.lookup, { code, now: lookupClock });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // The stash only has to survive the sign-in round trip; once the approval
  // page renders for a ready account it must not drag the user back here.
  useEffect(() => {
    if (cloud.status === "ready") {
      setPendingEngineConnect(null);
    }
  }, [cloud.status]);

  useEffect(() => {
    if (phase.kind !== "done") {
      return;
    }
    const timer = window.setTimeout(() => {
      window.location.assign(WORKSPACE_ROUTE);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const signInHref = useMemo(
    () => `/sign-in?redirect_url=${encodeURIComponent(`/connect/${code}`)}`,
    [code]
  );
  const signUpHref = useMemo(
    () => `/sign-up?redirect_url=${encodeURIComponent(`/connect/${code}`)}`,
    [code]
  );

  if (cloud.status === "loading") {
    return (
      <Frame>
        <div className="flex items-center gap-[10px] text-[14px] text-[var(--text-secondary)]">
          <Loader2 className="size-[16px] animate-spin" strokeWidth={2} aria-hidden />
          Checking your account…
        </div>
      </Frame>
    );
  }

  if (cloud.status === "signed-out") {
    return (
      <Notice
        title={
          lookup?.label ? `Sign in to attach ${lookup.label}.` : "Sign in to attach this engine."
        }
        body="The engine will be added to your account, and every device you sign in on can use it - no URL or password to copy."
        action={
          <>
            <a href={signInHref} className={accentButtonClass}>
              Sign in
              <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
            </a>
            <a href={signUpHref} className={outlineButtonClass}>
              Create an account
            </a>
          </>
        }
      />
    );
  }

  if (lookup === undefined) {
    return (
      <Frame>
        <div className="flex items-center gap-[10px] text-[14px] text-[var(--text-secondary)]">
          <Loader2 className="size-[16px] animate-spin" strokeWidth={2} aria-hidden />
          Looking up the engine…
        </div>
      </Frame>
    );
  }

  if (lookup === null || lookup.status === "expired") {
    return (
      <Notice
        title="This connect link has expired."
        body="Links are single-use and valid for 10 minutes. Run `cesium-server connect` on the engine for a fresh one."
        action={
          <Link href={WORKSPACE_ROUTE} className={outlineButtonClass}>
            Open workbench
          </Link>
        }
      />
    );
  }

  if (phase.kind === "done") {
    return (
      <Notice
        title={`${phase.label} is attached.`}
        body="It is now in your device list on every signed-in device. Opening the workbench…"
        action={
          <Link href={WORKSPACE_ROUTE} className={accentButtonClass}>
            Open workbench
            <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
          </Link>
        }
      />
    );
  }

  if (lookup.status === "approved" && phase.kind === "idle") {
    return (
      <Notice
        title="This connect link was already used."
        body={`${lookup.label} was attached with this link. If that was you, it is already in your device list; otherwise run \`cesium-server connect\` again to get a fresh link.`}
        action={
          <Link href={WORKSPACE_ROUTE} className={outlineButtonClass}>
            Open workbench
          </Link>
        }
      />
    );
  }

  const attach = async () => {
    if (!cloud.actions) {
      setPhase({ kind: "error", message: "Your account is not ready yet - try again in a moment." });
      return;
    }
    const actions = cloud.actions;
    try {
      setPhase({ kind: "working", step: `Contacting ${hostOf(lookup.publicUrl)}…` });
      const claim = await claimEnginePairing({
        publicUrl: lookup.publicUrl,
        code,
        account: { email: cloud.userEmail, name: cloud.userName },
      });
      if (claim.serverId !== lookup.serverId || claim.fingerprint !== lookup.fingerprint) {
        throw new Error(
          "The engine that answered is not the one this link was created for. Nothing was attached."
        );
      }
      setPhase({ kind: "working", step: "Signing in to the engine…" });
      const { token } = await loginToEngine(claim.publicUrl, claim.auth.username, claim.auth.password);
      setPhase({ kind: "working", step: "Saving to your account…" });
      const sealed = await sealEngineCredential({
        serverId: claim.serverId,
        username: claim.auth.username,
        password: claim.auth.password,
      });
      await actions.saveSecret({ kind: engineAuthSecretKind(claim.serverId), payload: sealed });
      const attachedAt = Date.now();
      await actions.saveServer({
        name: claim.label,
        baseUrl: claim.publicUrl,
        kind: "remote",
        rendezvous: claim.rendezvous,
        sessionToken: token,
        markConnected: true,
        pairing: { fingerprint: claim.fingerprint, attachedAt },
      });
      await actions.approveEnginePairing({ code, serverId: claim.serverId });
      // Adopt locally too, so this device opens straight onto the engine.
      bootstrapStoredServerConnection(
        {
          id: `rendezvous:${claim.serverId}`,
          label: claim.label,
          baseUrl: claim.publicUrl,
          rendezvous: claim.rendezvous,
        },
        {
          activate: "always",
          defaultServer: "if-missing",
          configuredDefaultBaseUrl: getConfiguredServerBaseUrl(),
        }
      );
      setStoredSessionToken(token, null, claim.publicUrl);
      setPendingEngineConnect(null);
      setPhase({ kind: "done", label: claim.label });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "Attaching the engine failed.",
      });
    }
  };

  const working = phase.kind === "working";
  return (
    <Frame>
      <h1 className="text-balance text-[30px] font-semibold leading-[1.12] tracking-tight sm:text-[34px]">
        Attach <span className="font-mono text-[0.88em]">{lookup.label}</span> to your account?
      </h1>
      <p className="mt-[14px] text-pretty text-[14px] leading-relaxed text-[var(--text-secondary)]">
        Every device signed in as{" "}
        <span className="text-[var(--text-primary)]">{cloud.userEmail ?? cloud.userName ?? "this account"}</span>{" "}
        will be able to use this engine. Its sign-in is stored encrypted for your account; nothing
        to copy or paste.
      </p>
      <dl className="mt-[22px] grid grid-cols-[auto_minmax(0,1fr)] gap-x-[16px] gap-y-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-[14px] text-[13px]">
        <dt className="text-[var(--text-secondary)]">Engine</dt>
        <dd className="truncate font-mono" data-testid="connect-engine-label">{lookup.label}</dd>
        <dt className="text-[var(--text-secondary)]">Fingerprint</dt>
        <dd className="font-mono tracking-[0.04em]" data-testid="connect-fingerprint">{lookup.fingerprint}</dd>
        <dt className="text-[var(--text-secondary)]">Reached at</dt>
        <dd className="truncate font-mono" title={lookup.publicUrl}>{hostOf(lookup.publicUrl)}</dd>
        <dt className="text-[var(--text-secondary)]">Link expires</dt>
        <dd className="font-mono">{formatRemaining(lookup.expiresAt, now)}</dd>
      </dl>
      <p className="mt-[12px] flex items-start gap-[8px] text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        <ShieldCheck className="mt-[2px] size-[14px] shrink-0" strokeWidth={1.8} aria-hidden />
        The terminal that printed this link shows the same fingerprint. If it differs, do not attach.
      </p>
      <div className="mt-[24px] flex flex-col gap-[10px]">
        <button
          type="button"
          onClick={() => void attach()}
          disabled={working}
          className={accentButtonClass}
          data-testid="connect-attach"
        >
          {working ? (
            <Loader2 className="size-[15px] animate-spin" strokeWidth={2} aria-hidden />
          ) : (
            <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
          )}
          {working ? phase.step : `Attach ${lookup.label}`}
        </button>
        <Link href={WORKSPACE_ROUTE} className={outlineButtonClass}>
          Not now
        </Link>
      </div>
      {phase.kind === "error" ? (
        <p
          role="alert"
          className="mt-[14px] rounded-[var(--radius-tab)] border border-[var(--goal-accent)] px-[12px] py-[10px] text-[13px] leading-relaxed text-[var(--goal-accent)]"
        >
          {phase.message}
        </p>
      ) : null}
    </Frame>
  );
}
