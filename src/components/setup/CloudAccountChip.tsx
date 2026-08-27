"use client";

import { useState } from "react";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { Check, Cloud, CloudOff, Link2 } from "lucide-react";
import { useCloudContext } from "@/contexts/CloudContext";

/**
 * Header chip summarizing the cloud account state.
 *
 * - clerk mode: real sign-in/sign-out via Clerk (production posture).
 * - device mode: synced under a per-browser device identity.
 * - disabled: everything stays local; chip explains that cloud is off.
 */
export function CloudAccountChip() {
  const cloud = useCloudContext();

  if (cloud.mode === "disabled") {
    return (
      <span
        className="inline-flex items-center gap-[8px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[6px] font-mono text-[11px] text-[var(--text-disabled)]"
        title="Cloud sync is not configured for this build. Everything stays on this device and your engines."
      >
        <CloudOff className="size-[13px]" strokeWidth={1.75} aria-hidden />
        Local-only
      </span>
    );
  }

  if (cloud.mode === "clerk") {
    if (cloud.status === "signed-out") {
      return (
        <SignInButton mode="modal">
          <button
            type="button"
            className="inline-flex items-center gap-[8px] rounded-[var(--radius-pill)] bg-[var(--accent)] px-[14px] py-[6px] text-[12.5px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
          >
            <Cloud className="size-[13px]" strokeWidth={1.75} aria-hidden />
            Sign in to sync
          </button>
        </SignInButton>
      );
    }
    return (
      <span className="inline-flex items-center gap-[10px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] pl-[12px] pr-[6px] font-mono text-[11px] text-[var(--text-secondary)]">
        <Cloud className="size-[13px] text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
        {cloud.userEmail ?? cloud.userName ?? "Synced"}
        <UserButton />
      </span>
    );
  }

  return <DeviceModeChip status={cloud.status} userKey={cloud.userKey} />;
}

function DeviceModeChip({
  status,
  userKey,
}: {
  status: string;
  userKey: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const deviceKey = userKey?.startsWith("device:") ? userKey.slice(7) : null;

  const copyLinkUrl = async () => {
    if (!deviceKey) {
      return;
    }
    const url = `${window.location.origin}/setup?link=${encodeURIComponent(deviceKey)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/insecure context) - ignore.
    }
  };

  return (
    <span
      className="inline-flex items-center gap-[8px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[6px] font-mono text-[11px] text-[var(--text-secondary)]"
      title={`Cloud sync active in device mode (${userKey ?? "resolving"}). Configure Clerk for account sign-in.`}
    >
      <Cloud className="size-[13px] text-[var(--ask-accent)]" strokeWidth={1.75} aria-hidden />
      {status === "ready" ? "Synced · device" : "Connecting…"}
      {deviceKey ? (
        <button
          type="button"
          onClick={() => void copyLinkUrl()}
          title="Copy a link that signs another device into this cloud context"
          className="inline-flex items-center gap-[4px] rounded-[var(--radius-pill)] border border-[var(--border-card)] px-[8px] py-[2px] text-[10px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
        >
          {copied ? (
            <Check className="size-[11px]" strokeWidth={2} aria-hidden />
          ) : (
            <Link2 className="size-[11px]" strokeWidth={1.75} aria-hidden />
          )}
          {copied ? "Copied" : "Link device"}
        </button>
      ) : null}
    </span>
  );
}
