"use client";

/**
 * Harness auth sync UI: keep agent sign-ins (Codex, Claude Code, Cursor,
 * Grok, OpenCode, Devin, Antigravity, Cesium Agent API keys) in the
 * account's encrypted vault so any of the user's devices/engines can sign
 * in without re-running vendor logins.
 *
 * Everything here is consent-driven: material is captured only when the
 * user uploads it, and applied only when they ask. Payloads are sealed on
 * the device (AES-256-GCM envelopes) before upload - the cloud only stores
 * ciphertext.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Check,
  CloudDownload,
  CloudUpload,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { harnessAuthSyncIdForBackend } from "@cesium/core";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  SettingsCallout,
  SettingsRow,
  SettingsSection,
  SettingsSubsectionHeading,
  rowButtonClass,
  tagClass,
} from "@/components/editor/settings-ui";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  useHarnessAuthSync,
  type HarnessAuthSyncItem,
} from "@/hooks/useHarnessAuthSync";
import type { HarnessAuthSyncId, ServerRequestContext } from "@/lib/server-api";

const SECURITY_COPY =
  "Encrypted on this device with your account's private sync key (AES-256-GCM) before upload. Cesium Cloud stores only sealed ciphertext - it can never read your tokens. Synced sign-ins exist for one purpose: handing them to your other devices when you explicitly apply them.";

function formatSyncedAt(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "recently";
  }
  try {
    return new Date(updatedAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "recently";
  }
}

type BusyAction = "push" | "apply" | "remove" | null;

function useSyncRowActions(
  api: ReturnType<typeof useHarnessAuthSync>,
  syncId: HarnessAuthSyncId
) {
  const [busy, setBusy] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: Exclude<BusyAction, null>, work: () => Promise<string>) => {
      setBusy(action);
      setMessage(null);
      setError(null);
      try {
        setMessage(await work());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sync action failed.");
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const push = useCallback(
    () =>
      run("push", async () => {
        await api.pushToCloud(syncId);
        return "Sign-in encrypted and synced to your account.";
      }),
    [api, run, syncId]
  );

  const apply = useCallback(
    () =>
      run("apply", async () => {
        const { applied } = await api.applyToEngine(syncId);
        return applied > 0
          ? "Synced sign-in applied to this engine."
          : "Nothing needed to be applied.";
      }),
    [api, run, syncId]
  );

  const remove = useCallback(
    () =>
      run("remove", async () => {
        await api.removeFromCloud(syncId);
        return "Removed the encrypted copy from your account.";
      }),
    [api, run, syncId]
  );

  return { busy, message, error, push, apply, remove };
}

/* ------------------------------------------------------------------------ */
/* Per-harness detail section (Settings → Agents → <harness>)               */
/* ------------------------------------------------------------------------ */

export function HarnessAuthSyncDetailSection({
  backendId,
}: {
  backendId: string;
}) {
  const syncId = harnessAuthSyncIdForBackend(backendId);
  const cloud = useCloudContext();
  const api = useHarnessAuthSync();

  if (!syncId || cloud.mode === "disabled") {
    return null;
  }

  return (
    <section className="px-[2px]">
      <SettingsSubsectionHeading>Sync across devices</SettingsSubsectionHeading>
      {cloud.status !== "ready" ? (
        <p className="mt-[6px] font-sans text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Sign in to your Cesium account to keep this agent&apos;s sign-in
          available on your other devices and servers.
        </p>
      ) : (
        <HarnessAuthSyncDetailBody api={api} syncId={syncId} />
      )}
    </section>
  );
}

function HarnessAuthSyncDetailBody({
  api,
  syncId,
}: {
  api: ReturnType<typeof useHarnessAuthSync>;
  syncId: HarnessAuthSyncId;
}) {
  const item = api.items.find((entry) => entry.syncId === syncId) ?? null;
  const { busy, message, error, push, apply, remove } = useSyncRowActions(
    api,
    syncId
  );
  const enabled = item?.decision === true;
  const engineSignedIn = item?.engine?.signedIn === true;
  const exportable = item?.engine?.exportable === true;
  const hasCloud = item?.cloud != null;

  return (
    <div className="mt-[10px] flex flex-col gap-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
      <div className="flex items-center justify-between gap-[16px]">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            Keep this sign-in synced
          </p>
          <p className="mt-[2px] leading-snug">
            {hasCloud
              ? `Encrypted copy in your account · updated ${formatSyncedAt(item?.cloud?.updatedAt ?? 0)}.`
              : "No copy in your account yet."}
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          variant="green"
          onChange={(on) => {
            api.setEnabled(syncId, on);
            if (on && exportable && !hasCloud) {
              void push();
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-[8px]">
        <button
          type="button"
          className={rowButtonClass}
          disabled={busy != null || !exportable}
          onClick={() => void push()}
          title={
            exportable
              ? "Encrypt this engine's sign-in and store it in your account."
              : "Nothing to upload: this engine has no sign-in for this agent."
          }
        >
          {busy === "push" ? (
            <Loader2 className="size-[14px] animate-spin" strokeWidth={1.75} />
          ) : (
            <CloudUpload className="size-[14px]" strokeWidth={1.5} />
          )}
          {hasCloud ? "Update synced copy" : "Sync from this engine"}
        </button>
        <button
          type="button"
          className={rowButtonClass}
          disabled={busy != null || !hasCloud}
          onClick={() => void apply()}
          title={
            hasCloud
              ? "Decrypt the synced sign-in on this device and apply it to this engine."
              : "No synced copy to apply yet."
          }
        >
          {busy === "apply" ? (
            <Loader2 className="size-[14px] animate-spin" strokeWidth={1.75} />
          ) : (
            <CloudDownload className="size-[14px]" strokeWidth={1.5} />
          )}
          Apply to this engine
        </button>
        {hasCloud ? (
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy != null}
            onClick={() => void remove()}
          >
            {busy === "remove" ? (
              <Loader2 className="size-[14px] animate-spin" strokeWidth={1.75} />
            ) : (
              <Trash2 className="size-[14px]" strokeWidth={1.5} />
            )}
            Remove from account
          </button>
        ) : null}
        <button
          type="button"
          className={rowButtonClass}
          disabled={busy != null}
          onClick={() => void api.refresh()}
        >
          <RefreshCw className="size-[14px]" strokeWidth={1.5} />
          Refresh
        </button>
      </div>
      {engineSignedIn && !hasCloud && !enabled ? (
        <p className="leading-relaxed">
          This engine is signed in. Turn on sync (or use “Sync from this
          engine”) to make the sign-in available to your other devices.
        </p>
      ) : null}
      {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
      {error ? <SettingsCallout tone="danger">{error}</SettingsCallout> : null}
      <SettingsCallout tone="info" className="items-start">
        <span className="flex gap-[8px]">
          <ShieldCheck
            className="mt-[1px] size-[14px] shrink-0 text-[var(--text-secondary)]"
            strokeWidth={1.75}
            aria-hidden
          />
          <span>{SECURITY_COPY}</span>
        </span>
      </SettingsCallout>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Summary card (Settings → Agents list view, Account panel)                */
/* ------------------------------------------------------------------------ */

function summaryStatus(item: HarnessAuthSyncItem): {
  label: string;
  tone: "synced" | "engine-only" | "cloud-only";
} {
  if (item.cloud && item.engine?.signedIn) {
    return { label: "Synced", tone: "synced" };
  }
  if (item.cloud) {
    return { label: "In account", tone: "cloud-only" };
  }
  return { label: "This engine only", tone: "engine-only" };
}

export function HarnessAuthSyncSummaryCard() {
  const cloud = useCloudContext();
  const api = useHarnessAuthSync();
  const [busySyncId, setBusySyncId] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<{
    syncId: string;
    text: string;
    isError: boolean;
  } | null>(null);

  const relevant = useMemo(
    () =>
      api.items.filter(
        (item) => item.cloud != null || item.engine?.signedIn === true
      ),
    [api.items]
  );

  if (cloud.mode === "disabled") {
    return null;
  }

  const runRowAction = async (
    syncId: HarnessAuthSyncId,
    work: () => Promise<string>
  ) => {
    setBusySyncId(syncId);
    setRowNotice(null);
    try {
      setRowNotice({ syncId, text: await work(), isError: false });
    } catch (error) {
      setRowNotice({
        syncId,
        text: error instanceof Error ? error.message : "Sync action failed.",
        isError: true,
      });
    } finally {
      setBusySyncId(null);
    }
  };

  return (
    <SettingsSection title="Agent sign-in sync">
      <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px]">
        <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          Keep harness logins and API keys available on every device you sign
          into - encrypted end-to-end, applied only when you say so.
        </p>
      </div>
      {cloud.status !== "ready" ? (
        <SettingsRow
          title="Sign in to enable"
          description="Agent sign-ins sync through your Cesium account's encrypted vault."
          trailing={<span className={tagClass}>Account required</span>}
          searchId="agents-auth-sync-signin"
        />
      ) : relevant.length === 0 ? (
        <SettingsRow
          title="Nothing to sync yet"
          description="Sign in to an agent CLI on any engine (or add Cesium Agent API keys) and it will appear here."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => void api.refresh()}
            >
              <RefreshCw className="size-[13px]" strokeWidth={1.5} />
              Refresh
            </button>
          }
          searchId="agents-auth-sync-empty"
        />
      ) : (
        relevant.map((item) => {
          const status = summaryStatus(item);
          const busy = busySyncId === item.syncId;
          const notice = rowNotice?.syncId === item.syncId ? rowNotice : null;
          return (
            <SettingsRow
              key={item.syncId}
              title={item.label}
              description={
                notice
                  ? notice.text
                  : item.cloud
                    ? `Encrypted copy updated ${formatSyncedAt(item.cloud.updatedAt)}.`
                    : "Signed in on this engine; not yet synced to your account."
              }
              trailing={
                <span className="flex items-center gap-[8px]">
                  <span className={tagClass}>{status.label}</span>
                  {item.engine?.exportable ? (
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy}
                      onClick={() =>
                        void runRowAction(item.syncId, async () => {
                          await api.pushToCloud(item.syncId);
                          api.setEnabled(item.syncId, true);
                          return "Encrypted and synced to your account.";
                        })
                      }
                    >
                      {busy ? (
                        <Loader2
                          className="size-[13px] animate-spin"
                          strokeWidth={1.75}
                        />
                      ) : (
                        <CloudUpload className="size-[13px]" strokeWidth={1.5} />
                      )}
                      Sync
                    </button>
                  ) : null}
                  {item.cloud && item.engine != null && !item.engine.signedIn ? (
                    <button
                      type="button"
                      className={rowButtonClass}
                      disabled={busy}
                      onClick={() =>
                        void runRowAction(item.syncId, async () => {
                          const { applied } = await api.applyToEngine(item.syncId);
                          return applied > 0
                            ? "Applied to this engine."
                            : "Nothing needed to be applied.";
                        })
                      }
                    >
                      {busy ? (
                        <Loader2
                          className="size-[13px] animate-spin"
                          strokeWidth={1.75}
                        />
                      ) : (
                        <CloudDownload className="size-[13px]" strokeWidth={1.5} />
                      )}
                      Apply here
                    </button>
                  ) : null}
                </span>
              }
              searchId={`agents-auth-sync-${item.syncId}`}
            />
          );
        })
      )}
      <div className="px-[16px] py-[12px]">
        <SettingsCallout tone="info">{SECURITY_COPY}</SettingsCallout>
      </div>
    </SettingsSection>
  );
}

/* ------------------------------------------------------------------------ */
/* Offer banner (onboarding Agents step, add-server flow)                   */
/* ------------------------------------------------------------------------ */

export function HarnessAuthSyncOffer({
  server,
  heading,
  onApplied,
}: {
  /** Target engine; defaults to the active server connection. */
  server?: ServerRequestContext;
  heading?: string;
  onApplied?: (applied: string[]) => void;
}) {
  const cloud = useCloudContext();
  const api = useHarnessAuthSync({ server });
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<"apply" | "upload" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sign-ins in the vault that this engine is missing → offer to apply.
  // Only harnesses that exist on the target host: offering a sign-in for a
  // CLI that is not installed is noise (install first, then the offer shows).
  const applicable = useMemo(
    () =>
      api.items.filter(
        (item) =>
          item.cloud != null &&
          item.engine != null &&
          item.engine.installed &&
          !item.engine.signedIn &&
          item.decision !== false
      ),
    [api.items]
  );
  // Sign-ins on this engine the vault does not have → offer to back up.
  const uploadable = useMemo(
    () =>
      api.items.filter(
        (item) =>
          item.cloud == null &&
          item.engine?.exportable === true &&
          item.decision !== false
      ),
    [api.items]
  );

  if (
    cloud.status !== "ready" ||
    dismissed ||
    (applicable.length === 0 && uploadable.length === 0)
  ) {
    return null;
  }

  const applyAll = async () => {
    setBusy("apply");
    setError(null);
    try {
      const applied: string[] = [];
      const failures: string[] = [];
      for (const item of applicable) {
        try {
          await api.applyToEngine(item.syncId);
          applied.push(item.label);
        } catch (cause) {
          failures.push(
            `${item.label}: ${cause instanceof Error ? cause.message : "failed"}`
          );
        }
      }
      if (applied.length > 0) {
        setResult(`Signed in: ${applied.join(", ")}.`);
        onApplied?.(applied);
      }
      if (failures.length > 0) {
        setError(failures.join(" "));
      }
    } finally {
      setBusy(null);
    }
  };

  const uploadAll = async () => {
    setBusy("upload");
    setError(null);
    try {
      const uploaded: string[] = [];
      const failures: string[] = [];
      for (const item of uploadable) {
        try {
          await api.pushToCloud(item.syncId);
          api.setEnabled(item.syncId, true);
          uploaded.push(item.label);
        } catch (cause) {
          failures.push(
            `${item.label}: ${cause instanceof Error ? cause.message : "failed"}`
          );
        }
      }
      if (uploaded.length > 0) {
        setResult(`Encrypted and synced: ${uploaded.join(", ")}.`);
      }
      if (failures.length > 0) {
        setError(failures.join(" "));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-card)] px-[14px] py-[12px]">
      <div className="flex items-start gap-[10px]">
        <ShieldCheck
          className="mt-[2px] size-[16px] shrink-0 text-[var(--text-secondary)]"
          strokeWidth={1.75}
          aria-hidden
        />
        <div className="min-w-0 flex-1 font-sans">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">
            {heading ?? "Sync agent sign-ins"}
          </p>
          <p className="mt-[2px] text-[12px] leading-snug text-[var(--text-secondary)]">
            {applicable.length > 0
              ? `Your account has encrypted sign-ins for ${applicable
                  .map((item) => item.label)
                  .join(", ")} that this server is missing.`
              : `Back up ${uploadable
                  .map((item) => item.label)
                  .join(", ")} to your account so other devices can sign in automatically.`}{" "}
            Sign-ins stay end-to-end encrypted and are only used to sign in
            devices you approve.
          </p>
          {result ? (
            <p className="mt-[6px] flex items-center gap-[6px] text-[12px] text-[var(--text-primary)]">
              <Check className="size-[13px]" strokeWidth={2} aria-hidden />
              {result}
            </p>
          ) : null}
          {error ? (
            <p className="mt-[6px] text-[12px] text-[#dc2626] dark:text-[#fca5a5]">
              {error}
            </p>
          ) : null}
          <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
            {applicable.length > 0 ? (
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy != null}
                onClick={() => void applyAll()}
              >
                {busy === "apply" ? (
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={1.75} />
                ) : (
                  <CloudDownload className="size-[13px]" strokeWidth={1.5} />
                )}
                Sign in automatically
                {applicable.length > 1 ? ` (${applicable.length})` : ""}
              </button>
            ) : null}
            {uploadable.length > 0 ? (
              <button
                type="button"
                className={rowButtonClass}
                disabled={busy != null}
                onClick={() => void uploadAll()}
              >
                {busy === "upload" ? (
                  <Loader2 className="size-[13px] animate-spin" strokeWidth={1.75} />
                ) : (
                  <CloudUpload className="size-[13px]" strokeWidth={1.5} />
                )}
                Sync to account
                {uploadable.length > 1 ? ` (${uploadable.length})` : ""}
              </button>
            ) : null}
            <button
              type="button"
              className="font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              disabled={busy != null}
              onClick={() => setDismissed(true)}
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
