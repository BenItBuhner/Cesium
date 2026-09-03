"use client";

import { useEffect, useState } from "react";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useShellView } from "@/components/layout/ShellViewContext";
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

type PendingRoute = {
  conversationId: string;
  requestedAt: number;
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
        requestedAt: Date.now(),
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
    const summary = findConversationSummaryById(pendingRoute.conversationId);
    if (!summary) {
      // Rail still loading (cold start) - this effect re-runs when the groups
      // behind findConversationSummaryById change, so just keep waiting.
      return;
    }
    setPendingRoute(null);
    // A tap must always land on the conversation, even when the app was left
    // inside Settings.
    if (shellView === "settings") {
      setShellView("agent");
    }
    void openConversationSummary(summary).then(() => {
      flushAgentSubscription([summary.id]);
      void syncConversationSnapshot(summary.id, { hydrateRuntime: true }).catch(
        () => undefined
      );
    });
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
