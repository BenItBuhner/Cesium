"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAgentConversations,
  useConversationEvents,
} from "@/components/chat/AgentConversationsContext";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";
import { getStoredSessionToken } from "@/lib/auth-client";
import { getConfiguredServerBaseUrl } from "@/lib/configured-server-base-url";
import { safeReadLocationSearchParam } from "@/lib/safe-url";
import {
  applyMobileHostConfig,
  dispatchMobileBridgeMessage,
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  MOBILE_IDLE_CLASS,
  parseMobileBridgeMessage,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
  type MobileWebToNativeMessage,
} from "@/lib/mobile-bridge";
import {
  deriveMobileAgentProjection,
  isMobileAgentRunActive,
  type MobileAgentProjection,
} from "@/lib/mobile-agent-projection";
import { publishAgentProjectionFeed } from "@/lib/agent-projection-feed";
import { toWatchAgentProjection, toWatchSyncEnvelope } from "@/lib/watch-agent-contract";

// Cheap pre-filter before deriving a full projection per conversation.
const BUSY_AGENT_STATUSES = new Set<string>([
  "running",
  "pause_requested",
  "pausing",
  "awaiting_permission",
  "awaiting_question",
]);

// Keep terminal runs projected briefly so the native side can post the final
// completion/failure alert before tracking stops.
const TERMINAL_AGENT_LINGER_MS = 30_000;

function areProjectionListsEqual(
  current: MobileAgentProjection[],
  next: MobileAgentProjection[]
): boolean {
  if (current.length !== next.length) {
    return false;
  }
  return current.every((entry, index) => {
    const other = next[index];
    return (
      other != null &&
      entry.conversationId === other.conversationId &&
      entry.lastEventSeq === other.lastEventSeq &&
      entry.status === other.status &&
      entry.pendingIntervention === other.pendingIntervention &&
      entry.updatedAt === other.updatedAt
    );
  });
}

function readNativeReadyMessage(): MobileNativeToWebMessage | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.__CESIUM_MOBILE_NATIVE_READY__;
  if (!raw) {
    return null;
  }
  return parseMobileBridgeMessage<MobileNativeToWebMessage>(raw);
}

export function MobileBridgeSync() {
  const { activeServer, hasServer } = useServerConnections();
  const {
    activeWorkspaceId,
    flushWorkspaceSessionNow,
    updateWorkspaceSession,
    workspaceSession,
  } = useWorkspace();
  const {
    bootstrapped,
    cancelConversation,
    conversationsById,
    conversationEventsStore,
    flushAgentSubscription,
    syncConversationSnapshot,
  } = useAgentConversations();
  const previousProjectionRef = useRef<MobileAgentProjection | null>(null);
  /** Last applied idle state so the bridge lifecycle message and visibilitychange dedupe against each other. */
  const lastLifecycleIdleRef = useRef<boolean | null>(null);
  const trackedAgentsRef = useRef(
    new Map<string, { previous: MobileAgentProjection; terminalSince: number | null }>()
  );
  const { shellView } = useShellView();
  const activeChatTab = workspaceSession.chat.tabs.find((tab) => tab.active);
  const requestedConversationIdFromLocation =
    shellView === "agent" && typeof window !== "undefined"
      ? safeReadLocationSearchParam("conversationId")
      : null;
  const normalizeConversationId = (id: string | null | undefined): string | null =>
    id && id !== AGENT_NEW_CHAT_SESSION_ID ? id : null;
  // Track the same conversation the agent view shows (URL param → agentView
  // selection), then fall back to the IDE chat tab. Live notifications and the
  // native agent-status subscription previously keyed off `chat.tabs` only,
  // which stays on "new" in agent view — so nothing was ever projected.
  const focusedConversationId =
    normalizeConversationId(requestedConversationIdFromLocation) ??
    normalizeConversationId(workspaceSession.agentView.selectedConversationId) ??
    normalizeConversationId(activeChatTab?.id);
  const focusedConversation = focusedConversationId
    ? conversationsById[focusedConversationId] ?? null
    : null;
  const focusedConversationEvents = useConversationEvents(focusedConversationId);

  const projection = useMemo(() => {
    if (!focusedConversation) {
      return null;
    }
    return deriveMobileAgentProjection(focusedConversation, focusedConversationEvents, {
      previous: previousProjectionRef.current,
    });
  }, [focusedConversationEvents, focusedConversation]);

  // Project every conversation with an active agent run (not just the focused
  // one) so each agent keeps its own live notification. Terminal runs linger
  // briefly so their completion alert is delivered before tracking stops.
  // Computed in an effect because the tracked map carries impure bookkeeping
  // (previous projections, linger timestamps).
  const [activeProjections, setActiveProjections] = useState<MobileAgentProjection[]>(
    []
  );
  useEffect(() => {
    const recompute = () => {
      const now = Date.now();
      const tracked = trackedAgentsRef.current;
      const result: MobileAgentProjection[] = [];
      const seen = new Set<string>();
      for (const conversation of Object.values(conversationsById)) {
        const entry = tracked.get(conversation.id);
        const maybeBusy =
          BUSY_AGENT_STATUSES.has(conversation.status) ||
          conversation.pendingPermission != null ||
          conversation.pendingQuestion != null;
        if (!maybeBusy && !entry) {
          continue;
        }
        const nextProjection = deriveMobileAgentProjection(
          conversation,
          conversationEventsStore.get(conversation.id),
          { previous: entry?.previous ?? null }
        );
        if (isMobileAgentRunActive(nextProjection.status)) {
          tracked.set(conversation.id, { previous: nextProjection, terminalSince: null });
        } else if (entry == null) {
          // Finished before we ever tracked it — nothing to notify about.
          continue;
        } else {
          const terminalSince = entry.terminalSince ?? now;
          if (now - terminalSince > TERMINAL_AGENT_LINGER_MS) {
            tracked.delete(conversation.id);
            continue;
          }
          tracked.set(conversation.id, { previous: nextProjection, terminalSince });
        }
        seen.add(conversation.id);
        result.push(nextProjection);
      }
      for (const conversationId of [...tracked.keys()]) {
        if (!seen.has(conversationId) && !conversationsById[conversationId]) {
          tracked.delete(conversationId);
        }
      }
      setActiveProjections((current) =>
        areProjectionListsEqual(current, result) ? current : result
      );
    };

    recompute();
    // Event-log churn is throttled: downstream native messages are already
    // rate-limited (500ms), so re-projecting every busy conversation on every
    // stream flush would be pure waste. Status/permission flips still land
    // immediately through the `conversationsById` dependency.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = conversationEventsStore.subscribeAny(() => {
      if (timer != null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        recompute();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timer != null) {
        clearTimeout(timer);
      }
    };
  }, [conversationsById, conversationEventsStore]);

  // Mirror the projection set to non-RN shells (Electron desktop) without
  // re-deriving it there. No-op consumers simply never subscribe.
  useEffect(() => {
    publishAgentProjectionFeed({ projections: activeProjections, bootstrapped });
  }, [activeProjections, bootstrapped]);

  const activeConversationIds = useMemo(
    () =>
      activeProjections
        .filter((entry) => isMobileAgentRunActive(entry.status))
        .map((entry) => entry.conversationId)
        .sort(),
    [activeProjections]
  );

  useEffect(() => {
    const nativeReady = readNativeReadyMessage();
    if (nativeReady) {
      dispatchMobileBridgeMessage(nativeReady);
    }
  }, []);

  useEffect(() => {
    postMobileBridgeMessage({
      type: "webReady",
      workspaceId: activeWorkspaceId,
      focusedConversationId,
      authToken: getStoredSessionToken(),
      protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
    });
  }, [activeWorkspaceId, focusedConversationId]);

  // Keep the native shell (agent status polling, phone control, notifications)
  // pointed at whichever server the workbench is actually using, e.g. after
  // switching to the on-device Termux server from the connection screen.
  useEffect(() => {
    if (!hasServer) {
      return;
    }
    postMobileBridgeMessage({
      type: "serverConfigured",
      server: {
        baseUrl: activeServer.baseUrl,
        label: activeServer.label,
        authToken: getStoredSessionToken(activeServer.baseUrl),
      },
    });
  }, [activeServer.baseUrl, activeServer.label, hasServer]);

  const activeConversationIdsKey = activeConversationIds.join(",");
  useEffect(() => {
    postMobileBridgeMessage({
      type: "focusedConversationChanged",
      workspaceId: activeWorkspaceId,
      conversationId: focusedConversationId,
      lastEventSeq: projection?.lastEventSeq ?? 0,
      activeConversationIds: activeConversationIdsKey
        ? activeConversationIdsKey.split(",")
        : [],
    });
  }, [
    activeWorkspaceId,
    activeConversationIdsKey,
    focusedConversationId,
    projection?.lastEventSeq,
  ]);

  const serverBaseUrl = getConfiguredServerBaseUrl();
  const watchProjection = useMemo(
    () =>
      projection
        ? toWatchAgentProjection(projection, {
            source: "phone_companion",
          })
        : null,
    [projection]
  );
  const wearSyncMessage = useMemo<MobileWebToNativeMessage>(
    () => ({
      type: "wearSyncEnvelope",
      envelopeJson: JSON.stringify(
        toWatchSyncEnvelope({
          projection: watchProjection,
          source: "phone_companion",
          server: {
            label: "This device",
            baseUrl: serverBaseUrl,
          },
          focused: {
            workspaceId: activeWorkspaceId,
            conversationId: focusedConversationId,
            lastEventSeq: projection?.lastEventSeq ?? 0,
          },
        })
      ),
      config: {
        serverBaseUrl,
        serverLabel: "This device",
        authToken: getStoredSessionToken(serverBaseUrl),
        workspaceId: activeWorkspaceId,
        conversationId: focusedConversationId,
      },
    }),
    [
      activeWorkspaceId,
      focusedConversationId,
      projection,
      serverBaseUrl,
      watchProjection,
    ]
  );
  useThrottledMobileBridgeMessage(wearSyncMessage, 1500);

  // Full multi-agent set for the native live-notification controller. Only
  // sent once conversations are bootstrapped: an early empty list would tear
  // down live notifications for agents that are still running.
  const agentProjectionsMessage = useMemo<MobileWebToNativeMessage | null>(
    () =>
      bootstrapped
        ? {
            type: "agentProjections",
            projections: activeProjections,
          }
        : null,
    [activeProjections, bootstrapped]
  );
  useThrottledMobileBridgeMessage(agentProjectionsMessage, 500);

  // Legacy single-projection message keeps older native shells working.
  const agentProjectionMessage = useMemo<MobileWebToNativeMessage | null>(
    () =>
      projection
        ? {
            type: "agentProjection",
            projection,
          }
        : null,
    [projection]
  );
  useThrottledMobileBridgeMessage(agentProjectionMessage, 500);

  useEffect(() => {
    previousProjectionRef.current = projection;
  }, [projection]);

  useEffect(() => {
    // Applied from BOTH the native lifecycle message and the page's own
    // visibilitychange. The bridge postMessage races the WebView pause and can
    // be dropped, which used to leave the idle class stuck and skip the resume
    // resync; visibilitychange is delivered synchronously by Chromium. Deduped
    // so whichever signal lands first wins and the other is a no-op.
    const applyLifecycleIdle = (idle: boolean) => {
      if (lastLifecycleIdleRef.current === idle) return;
      lastLifecycleIdleRef.current = idle;
      document.documentElement.classList.toggle(MOBILE_IDLE_CLASS, idle);
      if (idle) {
        void flushWorkspaceSessionNow().catch(() => undefined);
      } else if (focusedConversationId) {
        flushAgentSubscription([focusedConversationId]);
        void syncConversationSnapshot(focusedConversationId, {
          hydrateRuntime: true,
        }).catch(() => undefined);
      }
    };

    const onVisibilityChange = () => {
      if (!window.ReactNativeWebView) return;
      applyLifecycleIdle(document.visibilityState === "hidden");
    };

    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message) {
        return;
      }
      if (message.type === "nativeConfigChanged") {
        applyMobileHostConfig(message.server);
        return;
      }

      if (message.type === "lifecycle") {
        applyLifecycleIdle(message.state !== "active");
        return;
      }

      if (message.type === "notificationAction" && message.actionId === "cancel") {
        const conversationId = message.conversationId ?? focusedConversationId;
        if (!conversationId) {
          return;
        }
        void cancelConversation(conversationId).finally(() => {
          flushAgentSubscription([conversationId]);
          void syncConversationSnapshot(conversationId, {
            hydrateRuntime: true,
          }).catch(() => undefined);
        });
        return;
      }

      if (message.type === "notificationAction" || message.type === "resumeCatchUp") {
        const conversationId = message.conversationId ?? focusedConversationId;
        if (!conversationId) {
          return;
        }
        updateWorkspaceSession((current) => {
          const existing = current.chat.tabs.find((tab) => tab.id === conversationId);
          const nextTabs = current.chat.tabs.map((tab) => ({
            ...tab,
            active: tab.id === conversationId,
          }));
          if (!existing) {
            nextTabs.push({
              id: conversationId,
              title: conversationsById[conversationId]?.title ?? "Conversation",
              active: true,
            });
          }
          return {
            ...current,
            chat: {
              ...current.chat,
              tabs: nextTabs,
            },
            // Also select it in the agent view — tapping a notification should
            // land on that conversation, not just activate a hidden chat tab.
            agentView: {
              ...current.agentView,
              selectedConversationId: conversationId,
            },
          };
        });
        flushAgentSubscription([conversationId]);
        void syncConversationSnapshot(conversationId, {
          hydrateRuntime: true,
        }).catch(() => undefined);
      }
    };

    window.addEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    cancelConversation,
    conversationsById,
    flushAgentSubscription,
    flushWorkspaceSessionNow,
    focusedConversationId,
    syncConversationSnapshot,
    updateWorkspaceSession,
  ]);

  return null;
}

function useThrottledMobileBridgeMessage(
  message: MobileWebToNativeMessage | null,
  minimumIntervalMs: number
) {
  const pendingRef = useRef<MobileWebToNativeMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentAtRef = useRef(0);

  useEffect(() => {
    if (!message) {
      pendingRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    pendingRef.current = message;
    if (timerRef.current) return;

    const flush = () => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending) return;
      postMobileBridgeMessage(pending);
      lastSentAtRef.current = Date.now();
    };
    const remaining = Math.max(
      0,
      minimumIntervalMs - (Date.now() - lastSentAtRef.current)
    );
    if (remaining === 0) {
      flush();
      return;
    }
    timerRef.current = setTimeout(flush, remaining);
  }, [message, minimumIntervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
    },
    []
  );
}
