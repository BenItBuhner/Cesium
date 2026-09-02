"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Link2,
  Mail,
  Pause,
  Play,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useCloudContext, type CloudOutgoingShare } from "@/contexts/CloudContext";
import {
  cloudServerIdentity,
  isCloudSyncableServerUrl,
} from "@/lib/cloud/cloud-servers";
import {
  buildShareInviteLink,
  buildShareInviteMailto,
  extractShareInviteCode,
} from "@/lib/cloud/share-invites";

const inputClass =
  "box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

const buttonClass =
  "inline-flex h-[32px] min-w-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] text-center font-sans text-[12px] leading-none text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50";

const chipClass =
  "shrink-0 rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[2px] font-sans text-[11px]";

const EXPIRY_OPTIONS = [
  { id: "never", label: "No expiry", ms: null },
  { id: "1d", label: "Expires in 1 day", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "Expires in 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "Expires in 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

function formatExpiry(expiresAt: number | null): string | null {
  if (expiresAt === null) {
    return null;
  }
  try {
    return new Date(expiresAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function shareStatusChip(share: CloudOutgoingShare): {
  label: string;
  className: string;
} {
  if (share.status === "revoked") {
    return { label: "Revoked", className: "text-[var(--text-disabled)]" };
  }
  if (share.status === "declined") {
    return { label: "Declined / left", className: "text-[var(--text-disabled)]" };
  }
  if (share.expired) {
    return { label: "Expired", className: "text-[var(--text-disabled)]" };
  }
  if (share.status === "pending") {
    return { label: "Invite pending", className: "text-[var(--text-secondary)]" };
  }
  if (share.paused) {
    return { label: "Paused", className: "text-[#b45309] dark:text-[#fbbf24]" };
  }
  return { label: "Active", className: "text-[var(--text-primary)]" };
}

/**
 * Account-to-account server sharing, inside Settings → Servers:
 * - invites addressed to this account (accept / decline / leave),
 * - sharing one of this user's servers by email invite or invite link,
 * - owner-side grant management (pause, expiry, revoke).
 */
export function ServerSharingSettings() {
  const cloud = useCloudContext();
  const { servers } = useServerConnections();
  const [busyShareIds, setBusyShareIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Share form state.
  const [shareServerId, setShareServerId] = useState<string>("");
  const [shareEmail, setShareEmail] = useState("");
  const [shareExpiry, setShareExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]["id"]>("never");
  const [sharePending, setSharePending] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<{
    link: string;
    email: string | null;
    serverName: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Redeem form state.
  const [redeemValue, setRedeemValue] = useState("");
  const [redeemPending, setRedeemPending] = useState(false);
  const [redeemMessage, setRedeemMessage] = useState<string | null>(null);

  const actions = cloud.actions;
  const bootstrap = cloud.bootstrap;

  const sharedIdentitySet = useMemo(
    () =>
      new Set(
        (bootstrap?.sharedServers ?? []).map((server) =>
          cloudServerIdentity(server)
        )
      ),
    [bootstrap?.sharedServers]
  );

  /** Servers this user can share: syncable and not shared *to* them. */
  const shareableServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          isCloudSyncableServerUrl(server.baseUrl) &&
          !sharedIdentitySet.has(cloudServerIdentity(server))
      ),
    [servers, sharedIdentitySet]
  );

  const incomingPending = useMemo(
    () =>
      (bootstrap?.incomingShares ?? []).filter(
        (share) => share.status === "pending" && !share.expired
      ),
    [bootstrap?.incomingShares]
  );
  const incomingAccepted = useMemo(
    () => (bootstrap?.incomingShares ?? []).filter((share) => share.status === "accepted"),
    [bootstrap?.incomingShares]
  );
  const outgoingShares = bootstrap?.outgoingShares ?? [];

  const withShareBusy = useCallback(
    async (shareId: string, run: () => Promise<void>) => {
      setBusyShareIds((current) => new Set(current).add(shareId));
      setError(null);
      try {
        await run();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Share update failed.");
      } finally {
        setBusyShareIds((current) => {
          const next = new Set(current);
          next.delete(shareId);
          return next;
        });
      }
    },
    []
  );

  const handleCreateShare = useCallback(async () => {
    if (!actions) {
      return;
    }
    const server =
      shareableServers.find((candidate) => candidate.id === shareServerId) ??
      shareableServers[0] ??
      null;
    if (!server) {
      setError("No shareable server selected.");
      return;
    }
    setSharePending(true);
    setError(null);
    setCreatedInvite(null);
    try {
      const expiryMs = EXPIRY_OPTIONS.find((option) => option.id === shareExpiry)?.ms ?? null;
      const email = shareEmail.trim();
      const result = await actions.createServerShare({
        ...(server.rendezvous
          ? { rendezvousServerId: server.rendezvous.serverId }
          : { baseUrl: server.baseUrl }),
        ...(email ? { granteeEmail: email } : {}),
        ...(expiryMs !== null ? { expiresAt: Date.now() + expiryMs } : {}),
      });
      const link = buildShareInviteLink(window.location.origin, result.inviteCode);
      setCreatedInvite({ link, email: email || null, serverName: server.label });
      setShareEmail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creating the share failed.");
    } finally {
      setSharePending(false);
    }
  }, [actions, shareEmail, shareExpiry, shareServerId, shareableServers]);

  const handleRedeem = useCallback(async () => {
    if (!actions) {
      return;
    }
    const code = extractShareInviteCode(redeemValue);
    if (!code) {
      setRedeemMessage("Paste a full invite link or its code.");
      return;
    }
    setRedeemPending(true);
    setRedeemMessage(null);
    try {
      const result = await actions.claimServerShareByCode(code);
      setRedeemMessage(
        result.alreadyAccepted
          ? `"${result.serverName}" is already in your list.`
          : `Accepted - "${result.serverName}" was added to your servers.`
      );
      setRedeemValue("");
    } catch (cause) {
      setRedeemMessage(
        cause instanceof Error ? cause.message : "Redeeming the invite failed."
      );
    } finally {
      setRedeemPending(false);
    }
  }, [actions, redeemValue]);

  const handleCopy = useCallback(async (key: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopiedKey(ok ? key : null);
    if (ok) {
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1500);
    }
  }, []);

  if (cloud.mode === "disabled") {
    return null;
  }
  if (!actions) {
    return (
      <p className="px-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
        Sign in to your Cesium account to share servers with other accounts and
        accept servers shared with you.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-[16px]">
      {error ? (
        <p className="px-[2px] font-sans text-[11px] text-[var(--debug-accent)]">{error}</p>
      ) : null}

      {/* ---------- Shared with you ---------- */}
      {incomingPending.length > 0 || incomingAccepted.length > 0 ? (
        <div className="min-w-0">
          <h4 className="mb-[8px] px-[2px] font-sans text-[13px] font-semibold text-[var(--text-primary)]">
            Shared with you
          </h4>
          <div className="flex min-w-0 flex-col">
            {incomingPending.map((share) => {
              const busy = busyShareIds.has(share.shareId);
              const owner = share.ownerName ?? share.ownerEmail ?? "Another user";
              return (
                <div
                  key={share.shareId}
                  data-testid="incoming-share-pending"
                  className="flex min-w-0 flex-col gap-[8px] border-b border-[var(--border-subtle)] py-[10px] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                      {share.serverName}
                    </p>
                    <p className="mt-[2px] truncate font-sans text-[11px] text-[var(--text-secondary)]">
                      {owner} invited you to use this server.
                      {formatExpiry(share.expiresAt)
                        ? ` Invite expires ${formatExpiry(share.expiresAt)}.`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-[8px]">
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy}
                      onClick={() =>
                        void withShareBusy(share.shareId, () =>
                          actions.respondServerShare({ shareId: share.shareId, accept: true })
                        )
                      }
                    >
                      <Check className="size-[14px]" strokeWidth={1.5} aria-hidden />
                      Accept
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy}
                      onClick={() =>
                        void withShareBusy(share.shareId, () =>
                          actions.respondServerShare({ shareId: share.shareId, accept: false })
                        )
                      }
                    >
                      <X className="size-[14px]" strokeWidth={1.5} aria-hidden />
                      Decline
                    </button>
                  </div>
                </div>
              );
            })}
            {incomingAccepted.map((share) => {
              const busy = busyShareIds.has(share.shareId);
              const owner = share.ownerName ?? share.ownerEmail ?? "Another user";
              return (
                <div
                  key={share.shareId}
                  data-testid="incoming-share-accepted"
                  className="flex min-w-0 flex-col gap-[8px] border-b border-[var(--border-subtle)] py-[10px] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
                      <p className="min-w-0 truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                        {share.serverName}
                      </p>
                      {share.paused ? (
                        <span className={`${chipClass} text-[#b45309] dark:text-[#fbbf24]`}>
                          Paused by owner
                        </span>
                      ) : share.expired ? (
                        <span className={`${chipClass} text-[var(--text-disabled)]`}>Expired</span>
                      ) : (
                        <span className={`${chipClass} text-[var(--text-secondary)]`}>Active</span>
                      )}
                    </div>
                    <p className="mt-[2px] truncate font-sans text-[11px] text-[var(--text-secondary)]">
                      Shared by {owner}
                      {formatExpiry(share.expiresAt)
                        ? ` · until ${formatExpiry(share.expiresAt)}`
                        : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${buttonClass} shrink-0`}
                    disabled={busy}
                    onClick={() =>
                      void withShareBusy(share.shareId, () =>
                        actions.respondServerShare({ shareId: share.shareId, accept: false })
                      )
                    }
                  >
                    <Trash2 className="size-[14px]" strokeWidth={1.5} aria-hidden />
                    Leave
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ---------- Share one of my servers ---------- */}
      <div className="min-w-0">
        <div className="mb-[8px] flex items-center gap-[8px] px-[2px]">
          <Share2 className="size-[15px] text-[var(--text-secondary)]" strokeWidth={1.6} />
          <h4 className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">
            Share a server
          </h4>
        </div>
        {shareableServers.length === 0 ? (
          <p className="px-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
            Add a server first, then share it here. Tunnel-backed servers (public
            access) work best - their address follows the share automatically.
          </p>
        ) : (
          <>
            <div className="grid min-w-0 grid-cols-1 gap-[10px] md:grid-cols-3">
              <label className="flex min-w-0 flex-col gap-[6px]">
                <span className="font-sans text-[11px] text-[var(--text-secondary)]">Server</span>
                <select
                  value={shareServerId || (shareableServers[0]?.id ?? "")}
                  onChange={(event) => setShareServerId(event.target.value)}
                  className={inputClass}
                  data-testid="share-server-select"
                >
                  {shareableServers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-[6px]">
                <span className="font-sans text-[11px] text-[var(--text-secondary)]">
                  Recipient email (optional)
                </span>
                <input
                  type="email"
                  value={shareEmail}
                  onChange={(event) => setShareEmail(event.target.value)}
                  placeholder="friend@example.com"
                  className={inputClass}
                  data-testid="share-email-input"
                />
              </label>
              <label className="flex min-w-0 flex-col gap-[6px]">
                <span className="font-sans text-[11px] text-[var(--text-secondary)]">Limit</span>
                <select
                  value={shareExpiry}
                  onChange={(event) =>
                    setShareExpiry(event.target.value as (typeof EXPIRY_OPTIONS)[number]["id"])
                  }
                  className={inputClass}
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-[6px] px-[2px] font-sans text-[11px] text-[var(--text-secondary)]">
              With an email, the invite appears automatically in the recipient&apos;s
              Cesium account (plus a link you can send them). Without one, anyone
              with the invite link can claim it once.
            </p>
            <div className="mt-[10px] flex flex-wrap gap-[8px]">
              <button
                type="button"
                className={buttonClass}
                disabled={sharePending}
                onClick={() => void handleCreateShare()}
                data-testid="create-share-button"
              >
                <Share2 className="size-[14px]" strokeWidth={1.5} aria-hidden />
                {sharePending ? "Creating..." : "Create invite"}
              </button>
            </div>
            {createdInvite ? (
              <div
                className="mt-[10px] rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] p-[10px]"
                data-testid="created-invite-panel"
              >
                <p className="font-sans text-[12px] text-[var(--text-primary)]">
                  Invite ready for <span className="font-medium">{createdInvite.serverName}</span>
                  {createdInvite.email ? (
                    <>
                      {" "}addressed to <span className="font-medium">{createdInvite.email}</span>
                    </>
                  ) : null}
                  .
                </p>
                <p
                  className="mt-[6px] break-all font-mono text-[10.5px] text-[var(--text-secondary)]"
                  data-testid="created-invite-link"
                >
                  {createdInvite.link}
                </p>
                <div className="mt-[8px] flex flex-wrap gap-[8px]">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => void handleCopy("created", createdInvite.link)}
                  >
                    <Copy className="size-[14px]" strokeWidth={1.5} aria-hidden />
                    {copiedKey === "created" ? "Copied!" : "Copy link"}
                  </button>
                  {createdInvite.email ? (
                    <a
                      className={buttonClass}
                      href={buildShareInviteMailto({
                        email: createdInvite.email,
                        serverName: createdInvite.serverName,
                        inviteLink: createdInvite.link,
                        ownerName: cloud.userName ?? cloud.userEmail,
                      })}
                    >
                      <Mail className="size-[14px]" strokeWidth={1.5} aria-hidden />
                      Send by email
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* ---------- People with access (owner side) ---------- */}
      {outgoingShares.length > 0 ? (
        <div className="min-w-0">
          <h4 className="mb-[8px] px-[2px] font-sans text-[13px] font-semibold text-[var(--text-primary)]">
            People with access
          </h4>
          <div className="flex min-w-0 flex-col">
            {outgoingShares.map((share) => {
              const busy = busyShareIds.has(share.shareId);
              const chip = shareStatusChip(share);
              const ended =
                share.status === "revoked" || share.status === "declined" || share.expired;
              const who =
                share.granteeName ??
                share.granteeEmail ??
                "Anyone with the invite link";
              const link = buildShareInviteLink(window.location.origin, share.inviteCode);
              return (
                <div
                  key={share.shareId}
                  data-testid="outgoing-share-row"
                  className="flex min-w-0 flex-col gap-[8px] border-b border-[var(--border-subtle)] py-[10px] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
                      <p className="min-w-0 truncate font-sans text-[13px] font-medium text-[var(--text-primary)]">
                        {share.serverName}
                      </p>
                      <span className={`${chipClass} ${chip.className}`}>{chip.label}</span>
                    </div>
                    <p className="mt-[2px] truncate font-sans text-[11px] text-[var(--text-secondary)]">
                      {who}
                      {formatExpiry(share.expiresAt)
                        ? ` · until ${formatExpiry(share.expiresAt)}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-[8px]">
                    {share.status === "pending" && !share.expired ? (
                      <button
                        type="button"
                        className={buttonClass}
                        onClick={() => void handleCopy(share.shareId, link)}
                        title="Copy the invite link"
                      >
                        <Link2 className="size-[14px]" strokeWidth={1.5} aria-hidden />
                        {copiedKey === share.shareId ? "Copied!" : "Copy link"}
                      </button>
                    ) : null}
                    {share.status === "accepted" && !share.expired ? (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        data-testid="pause-share-button"
                        onClick={() =>
                          void withShareBusy(share.shareId, () =>
                            actions.updateServerShare({
                              shareId: share.shareId,
                              paused: !share.paused,
                            })
                          )
                        }
                      >
                        {share.paused ? (
                          <Play className="size-[14px]" strokeWidth={1.5} aria-hidden />
                        ) : (
                          <Pause className="size-[14px]" strokeWidth={1.5} aria-hidden />
                        )}
                        {share.paused ? "Resume" : "Pause"}
                      </button>
                    ) : null}
                    {!ended ? (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        data-testid="revoke-share-button"
                        onClick={() =>
                          void withShareBusy(share.shareId, () =>
                            actions.revokeServerShare(share.shareId)
                          )
                        }
                      >
                        <X className="size-[14px]" strokeWidth={1.5} aria-hidden />
                        Revoke
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() =>
                          void withShareBusy(share.shareId, () =>
                            actions.removeServerShare(share.shareId)
                          )
                        }
                      >
                        <Trash2 className="size-[14px]" strokeWidth={1.5} aria-hidden />
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ---------- Redeem an invite ---------- */}
      <div className="min-w-0">
        <h4 className="mb-[8px] px-[2px] font-sans text-[13px] font-semibold text-[var(--text-primary)]">
          Redeem an invite
        </h4>
        <div className="flex min-w-0 flex-col gap-[8px] sm:flex-row">
          <input
            type="text"
            value={redeemValue}
            onChange={(event) => setRedeemValue(event.target.value)}
            placeholder="Paste an invite link or code"
            className={inputClass}
            data-testid="redeem-input"
          />
          <button
            type="button"
            className={`${buttonClass} shrink-0`}
            disabled={redeemPending || !redeemValue.trim()}
            onClick={() => void handleRedeem()}
            data-testid="redeem-button"
          >
            <Check className="size-[14px]" strokeWidth={1.5} aria-hidden />
            {redeemPending ? "Redeeming..." : "Redeem"}
          </button>
        </div>
        {redeemMessage ? (
          <p
            className="mt-[6px] px-[2px] font-sans text-[11px] text-[var(--text-secondary)]"
            data-testid="redeem-message"
          >
            {redeemMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
