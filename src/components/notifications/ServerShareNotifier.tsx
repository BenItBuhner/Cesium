"use client";

import { useEffect, useRef } from "react";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  consumeShareInviteFromLocation,
  getPendingShareInvite,
  setPendingShareInvite,
} from "@/lib/cloud/share-invites";

export const SERVER_SHARE_NOTIFICATION_KIND = "servers.shareInvite";

/**
 * Bridges account-to-account server shares into the workbench toast layer:
 * - Redeems invite links (`#cesiumShareInvite=<code>`), stashing the code
 *   until the user is signed in, then claiming it automatically.
 * - Surfaces pending invites addressed to this account as actionable
 *   notifications with inline Accept / Decline.
 */
export function ServerShareNotifier() {
  const cloud = useCloudContext();
  const { pushNotification, requestDismiss } = useWorkbenchNotifications();

  // Capture an invite code from the URL fragment as early as possible; the
  // user may still need to sign in (or sign up) before it can be redeemed.
  useEffect(() => {
    const code = consumeShareInviteFromLocation();
    if (code) {
      setPendingShareInvite(code);
    }
  }, []);

  // Redeem the stashed invite once cloud actions are available.
  const claimingRef = useRef(false);
  const actions = cloud.actions;
  useEffect(() => {
    if (!actions || claimingRef.current) {
      return;
    }
    const code = getPendingShareInvite();
    if (!code) {
      return;
    }
    claimingRef.current = true;
    void actions
      .claimServerShareByCode(code)
      .then((result) => {
        setPendingShareInvite(null);
        pushNotification({
          kind: SERVER_SHARE_NOTIFICATION_KIND,
          severity: "info",
          title: "Server share accepted",
          message: result.alreadyAccepted
            ? `"${result.serverName}" is already in your servers list.`
            : `"${result.serverName}"${result.ownerName ? ` from ${result.ownerName}` : ""} was added to your servers list.`,
        });
      })
      .catch((error: unknown) => {
        setPendingShareInvite(null);
        pushNotification({
          kind: SERVER_SHARE_NOTIFICATION_KIND,
          severity: "warning",
          title: "Server share invite failed",
          message: error instanceof Error ? error.message : "Could not redeem the invite.",
        });
      })
      .finally(() => {
        claimingRef.current = false;
      });
  }, [actions, pushNotification]);

  // Actionable toast for each pending invite addressed to this account
  // (matched by email). Once per share per session; the Servers settings
  // panel remains the durable place to act later.
  const notifiedSharesRef = useRef(new Set<string>());
  const incomingShares = cloud.bootstrap?.incomingShares;
  useEffect(() => {
    if (!actions || !incomingShares) {
      return;
    }
    for (const share of incomingShares) {
      if (share.status !== "pending" || share.expired) {
        continue;
      }
      if (notifiedSharesRef.current.has(share.shareId)) {
        continue;
      }
      notifiedSharesRef.current.add(share.shareId);
      const owner = share.ownerName ?? share.ownerEmail ?? "Another Cesium user";
      const notificationId = pushNotification({
        kind: SERVER_SHARE_NOTIFICATION_KIND,
        severity: "info",
        title: "Server shared with you",
        message: `${owner} wants to share the server "${share.serverName}" with your account.`,
        persistent: true,
        actions: [
          {
            id: "accept",
            label: "Accept",
            primary: true,
            onClick: () => {
              void actions
                .respondServerShare({ shareId: share.shareId, accept: true })
                .then(() => {
                  pushNotification({
                    kind: SERVER_SHARE_NOTIFICATION_KIND,
                    severity: "info",
                    title: "Server share accepted",
                    message: `"${share.serverName}" was added to your servers list.`,
                  });
                })
                .catch((error: unknown) => {
                  pushNotification({
                    kind: SERVER_SHARE_NOTIFICATION_KIND,
                    severity: "warning",
                    title: "Could not accept share",
                    message:
                      error instanceof Error ? error.message : "Accepting the share failed.",
                  });
                });
              requestDismiss(notificationId);
            },
          },
          {
            id: "decline",
            label: "Decline",
            onClick: () => {
              void actions
                .respondServerShare({ shareId: share.shareId, accept: false })
                .catch(() => undefined);
              requestDismiss(notificationId);
            },
          },
        ],
      });
    }
  }, [actions, incomingShares, pushNotification, requestDismiss]);

  return null;
}
