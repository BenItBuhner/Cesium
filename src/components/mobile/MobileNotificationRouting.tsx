"use client";

import { useEffect, useState } from "react";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useShellView } from "@/components/layout/ShellViewContext";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import {
  MOBILE_BRIDGE_MESSAGE_EVENT,
  type MobileNativeToWebMessage,
} from "@/lib/mobile-bridge";

/**
 * How long a notification-tap routing request stays valid while waiting for
 * the conversation rail to load the target conversation. Long enough to ride
 * out a cold start on a slow connection; anything older is a stale request
 * the user has surely navigated away from.
 */
const PENDING_ROUTE_TTL_MS = 60_000;

/**
 * Grace period for the rail index to produce the tapped conversation's full
 * summary before routing falls back to a synthetic one. The real summary is
 * preferred because it carries server identity (multi-engine rails); the
 * fallback guarantees a tap still lands even when the rail request is slow
 * or failing - the notification itself already carries the two ids that
 * matter.
 */
const RAIL_SUMMARY_GRACE_MS = 4_000;

type PendingRoute = {
  conversationId: string;
  workspaceId: string | null;
  requestedAt: number;
  allowFallback: boolean;
};

/**
 * Routes notification taps (Android live notifications, Electron notification
 * clicks, `cesium://open` deep links - all delivered as `notificationAction`
 * bridge messages) to the conversation they point at.
 *
 * This intentionally goes through `openConversationSummary` rather than
 * patching the workspace session directly: the session-only patch the bridge
 * used before was overridden by the URL's stale `?conversationId=` during the
 * next selection resolution, which is exactly why tapping a notification
 * landed on "wherever you last were". The pending-selection path beats the
 * URL deep-link, switches workspace / server when the conversation lives
 * elsewhere, and rewrites both session and URL on completion.
 */
export function MobileNotificationRouting() {
  const { findConversationSummaryById, openConversationSummary } =
    useAgentShellState();
  const { flushAgentSubscription, syncConversationSnapshot } =
    useAgentConversations();
  const { shellView, setShellView } = useShellView();
  const [pendingRoute, setPendingRoute] = useState<PendingRoute | null>(null);

  useEffect(() => {
    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message || message.type !== "notificationAction") {
        return;
      }
      // Cancel is an in-place action handled by MobileBridgeSync; everything
      // else (open / respond) means "take me to this conversation".
      if (message.actionId === "cancel" || !message.conversationId) {
        return;
      }
      setPendingRoute({
        conversationId: message.conversationId,
        workspaceId: message.workspaceId ?? null,
        requestedAt: Date.now(),
        allowFallback: false,
      });
    };
    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    };
  }, []);

  useEffect(() => {
    if (!pendingRoute) {
      return;
    }
    if (Date.now() - pendingRoute.requestedAt > PENDING_ROUTE_TTL_MS) {
      setPendingRoute(null);
      return;
    }

    const route = (summary: AgentRailConversationSummary) => {
      setPendingRoute(null);
      // A tap must always land on the conversation, even when the app was
      // left inside Settings.
      if (shellView === "settings") {
        setShellView("agent");
      }
      void openConversationSummary(summary).then(() => {
        flushAgentSubscription([summary.id]);
        void syncConversationSnapshot(summary.id, {
          hydrateRuntime: true,
        }).catch(() => undefined);
      });
    };

    const summary = findConversationSummaryById(pendingRoute.conversationId);
    if (summary) {
      route(summary);
      return;
    }

    if (pendingRoute.allowFallback && pendingRoute.workspaceId) {
      // The rail index does not (yet) know this conversation - a fresh run,
      // a slow or failing rail request, a cold start. The notification's own
      // ids are authoritative, so route with a minimal summary; the rail
      // catches up on its own and the selection logic already honors ids it
      // has not indexed yet.
      route({
        id: pendingRoute.conversationId,
        workspaceId: pendingRoute.workspaceId,
        title: "",
        createdAt: pendingRoute.requestedAt,
        updatedAt: pendingRoute.requestedAt,
        lastEventSeq: 0,
        status: "running",
        archivedAt: null,
        backendId: "cesium-agent",
        mode: "agent",
        experimental: false,
        hasPendingPermission: false,
      });
      return;
    }

    // Rail still loading - re-check when the groups behind
    // findConversationSummaryById change, and arm the fallback in case they
    // never produce the summary.
    const fallbackTimer = setTimeout(() => {
      setPendingRoute((current) =>
        current && current.requestedAt === pendingRoute.requestedAt
          ? { ...current, allowFallback: true }
          : current
      );
    }, RAIL_SUMMARY_GRACE_MS);
    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [
    findConversationSummaryById,
    flushAgentSubscription,
    openConversationSummary,
    pendingRoute,
    setShellView,
    shellView,
    syncConversationSnapshot,
  ]);

  return null;
}
