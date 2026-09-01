"use client";

import { useEffect, useRef } from "react";
import {
  getAgentProjectionFeedSnapshot,
  subscribeAgentProjectionFeed,
} from "@/lib/agent-projection-feed";
import {
  DesktopAgentNotificationController,
  DESKTOP_NOTIFICATION_PREFERENCES_EVENT,
  loadDesktopAgentNotificationPreferences,
} from "@/lib/desktop-agent-notifications";
import {
  getDesktopNativeEventsBridge,
  getDesktopNotificationsBridge,
  isDesktopNativeAvailable,
  type DesktopNativeEvent,
} from "@/lib/desktop-native-bridge";
import { dispatchMobileBridgeMessage } from "@/lib/mobile-bridge";
import { parseOAuthCompletedDeepLink } from "@/lib/oauth-deep-link";

/**
 * Routes a `cesium://` deep link into the workbench:
 * - `cesium://open?conversationId=…&workspaceId=…` focuses a conversation
 *   (same path as tapping an Android notification).
 * - `cesium://share?text=…&subject=…` stages text into the share intake UI.
 * - `cesium://oauth/done?…` completes hosted Clerk / MCP OAuth in the renderer.
 */
export function handleDesktopDeepLink(url: string): void {
  const oauth = parseOAuthCompletedDeepLink(url);
  if (oauth) {
    dispatchMobileBridgeMessage({
      type: "oauthCompleted",
      sessionId: oauth.sessionId,
      ok: oauth.ok,
      kind: oauth.kind,
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const action = (parsed.host || parsed.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action === "open") {
    const conversationId = parsed.searchParams.get("conversationId");
    if (!conversationId) {
      return;
    }
    dispatchMobileBridgeMessage({
      type: "notificationAction",
      actionId: "open",
      conversationId,
      workspaceId: parsed.searchParams.get("workspaceId") ?? undefined,
    });
    return;
  }
  if (action === "share") {
    const text = parsed.searchParams.get("text");
    const subject = parsed.searchParams.get("subject");
    if (!text && !subject) {
      return;
    }
    dispatchMobileBridgeMessage({
      type: "shareIntake",
      payload: {
        text: text ?? null,
        subject: subject ?? null,
        items: [],
      },
    });
  }
}

function handleDesktopNativeEvent(event: DesktopNativeEvent): void {
  if (!event) {
    return;
  }
  if (event.kind === "notificationAction") {
    dispatchMobileBridgeMessage({
      type: "notificationAction",
      actionId: event.actionId || "open",
      conversationId: event.conversationId ?? undefined,
      workspaceId: event.workspaceId ?? undefined,
    });
    return;
  }
  if (event.kind === "shareIntake") {
    dispatchMobileBridgeMessage({
      type: "shareIntake",
      payload: event.payload,
    });
    return;
  }
  if (event.kind === "deepLink") {
    handleDesktopDeepLink(event.url);
  }
}

/**
 * Desktop analog of the mobile shell's native services: feeds agent run
 * projections into OS notifications / tray / dock badge, and routes native
 * intake (notification clicks, shared files, deep links) back into the
 * workbench. Renders nothing; inert outside the Electron shell.
 */
export function DesktopNativeSync() {
  const controllerRef = useRef<DesktopAgentNotificationController | null>(null);

  useEffect(() => {
    if (!isDesktopNativeAvailable()) {
      return;
    }
    const notifications = getDesktopNotificationsBridge();
    if (!notifications) {
      return;
    }
    const controller = new DesktopAgentNotificationController({
      notify: (payload) => notifications.notify(payload),
      syncRuns: (input) => notifications.syncAgentRuns(input),
    });
    controller.setPreferences(loadDesktopAgentNotificationPreferences());
    controller.setAppActive(
      document.visibilityState === "visible" && document.hasFocus()
    );
    controllerRef.current = controller;

    const applyFeed = (snapshot: {
      projections: Parameters<DesktopAgentNotificationController["updateAll"]>[0];
      bootstrapped: boolean;
    }) => {
      // An early empty set would tear down runs that are still being
      // hydrated; wait for conversation bootstrap like the Android shell.
      if (!snapshot.bootstrapped) {
        return;
      }
      controller.updateAll(snapshot.projections);
    };
    const unsubscribeFeed = subscribeAgentProjectionFeed(applyFeed);
    applyFeed(getAgentProjectionFeedSnapshot());

    const onFocusChange = () => {
      controller.setAppActive(
        document.visibilityState === "visible" && document.hasFocus()
      );
    };
    window.addEventListener("focus", onFocusChange);
    window.addEventListener("blur", onFocusChange);
    document.addEventListener("visibilitychange", onFocusChange);

    const onPreferencesChanged = () => {
      controller.setPreferences(loadDesktopAgentNotificationPreferences());
    };
    window.addEventListener(
      DESKTOP_NOTIFICATION_PREFERENCES_EVENT,
      onPreferencesChanged
    );

    const events = getDesktopNativeEventsBridge();
    let unsubscribeEvents: (() => void) | null = null;
    if (events) {
      unsubscribeEvents = events.onEvent(handleDesktopNativeEvent);
      void events
        .ready()
        .then((pending) => {
          for (const event of pending ?? []) {
            handleDesktopNativeEvent(event);
          }
        })
        .catch(() => undefined);
    }

    return () => {
      unsubscribeFeed();
      unsubscribeEvents?.();
      window.removeEventListener("focus", onFocusChange);
      window.removeEventListener("blur", onFocusChange);
      document.removeEventListener("visibilitychange", onFocusChange);
      window.removeEventListener(
        DESKTOP_NOTIFICATION_PREFERENCES_EVENT,
        onPreferencesChanged
      );
      controllerRef.current = null;
    };
  }, []);

  return null;
}
