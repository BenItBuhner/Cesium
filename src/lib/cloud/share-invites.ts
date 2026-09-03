"use client";

import { clientKeyValueStore } from "@cesium/client";

/**
 * Server-share invite links.
 *
 * An invite link carries the share's capability code in the URL fragment
 * (never sent to servers or logged): `https://app/#cesiumShareInvite=<code>`.
 * Because the recipient may need to sign up first, the code is stashed in
 * client storage on arrival and redeemed once the cloud context is active.
 */

export const SHARE_INVITE_FRAGMENT_KEY = "cesiumShareInvite";
export const PENDING_SHARE_INVITE_STORAGE_KEY = "cesium-pending-share-invite";

const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function buildShareInviteLink(origin: string, inviteCode: string): string {
  return `${origin.replace(/\/+$/, "")}/#${SHARE_INVITE_FRAGMENT_KEY}=${inviteCode}`;
}

export function buildShareInviteMailto(input: {
  email: string;
  serverName: string;
  inviteLink: string;
  ownerName?: string | null;
}): string {
  const subject = `${input.ownerName ?? "A Cesium user"} shared the server "${input.serverName}" with you`;
  const body = [
    `You've been invited to use the Cesium server "${input.serverName}".`,
    "",
    "Open this link while signed in to Cesium to accept:",
    input.inviteLink,
    "",
    "New to Cesium? Sign up first, then open the link - the invite will be waiting.",
  ].join("\n");
  return `mailto:${encodeURIComponent(input.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Extract an invite code from a pasted link, fragment, or bare code. */
export function extractShareInviteCode(raw: string): string | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (INVITE_CODE_PATTERN.test(value)) {
    return value;
  }
  const fragmentMatch = value.match(
    new RegExp(`${SHARE_INVITE_FRAGMENT_KEY}=([A-Za-z0-9_-]{16,64})`)
  );
  return fragmentMatch ? fragmentMatch[1] : null;
}

/** Read (and strip) an invite code from the current location's fragment. */
export function consumeShareInviteFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const hash = window.location.hash;
  if (!hash.includes(SHARE_INVITE_FRAGMENT_KEY)) {
    return null;
  }
  const code = extractShareInviteCode(hash);
  if (!code) {
    return null;
  }
  const remaining = hash
    .replace(/^#/, "")
    .split("&")
    .filter((part) => !part.startsWith(`${SHARE_INVITE_FRAGMENT_KEY}=`))
    .join("&");
  const url = new URL(window.location.href);
  url.hash = remaining;
  window.history.replaceState(window.history.state, "", url.toString());
  return code;
}

export function getPendingShareInvite(): string | null {
  const raw = clientKeyValueStore().getItem(PENDING_SHARE_INVITE_STORAGE_KEY);
  return raw && INVITE_CODE_PATTERN.test(raw) ? raw : null;
}

export function setPendingShareInvite(code: string | null): void {
  const store = clientKeyValueStore();
  if (code) {
    store.setItem(PENDING_SHARE_INVITE_STORAGE_KEY, code);
  } else {
    store.removeItem(PENDING_SHARE_INVITE_STORAGE_KEY);
  }
}
