"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";
import { getStoredSessionToken } from "@/lib/auth-client";
import { getConfiguredServerBaseUrl } from "@/lib/configured-server-base-url";
import { safeReadLocationSearchParam } from "@/lib/safe-url";
import {
  dispatchMobileBridgeMessage,
  MOBILE_BRIDGE_MESSAGE_EVENT,
  MOBILE_IDLE_CLASS,
  parseMobileBridgeMessage,
  postMobileBridgeMessage,
  type MobileNativeToWebMessage,
  type MobileWebToNativeMessage,
} from "@/lib/mobile-bridge";
import {
  deriveMobileAgentProjection,
  type MobileAgentProjection,
} from "@/lib/mobile-agent-projection";
import { toWatchAgentProjection, toWatchSyncEnvelope } from "@/lib/watch-agent-contract";

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
  const { activeServer } = useServerConnections();
  const {
    activeWorkspaceId,
    flushWorkspaceSessionNow,
    updateWorkspaceSession,
    workspaceSession,
  } = useWorkspace();
  const {
    cancelConversation,
    conversationsById,
    eventsByConversationId,
    flushAgentSubscription,
    syncConversationSnapshot,
  } = useAgentConversations();
  const previousProjectionRef = useRef<MobileAgentProjection | null>(null);
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

  const projection = useMemo(() => {
    if (!focusedConversation) {
      return null;
    }
    return deriveMobileAgentProjection(
      focusedConversation,
      eventsByConversationId[focusedConversation.id] ?? [],
      {
        previous: previousProjectionRef.current,
      }
    );
  }, [eventsByConversationId, focusedConversation]);

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
    });
  }, [activeWorkspaceId, focusedConversationId]);

  // Keep the native shell (agent status polling, phone control, notifications)
  // pointed at whichever server the workbench is actually using, e.g. after
  // switching to the on-device Termux server from the connection screen.
  useEffect(() => {
    postMobileBridgeMessage({
      type: "serverConfigured",
      server: {
        baseUrl: activeServer.baseUrl,
        label: activeServer.label,
        authToken: getStoredSessionToken(activeServer.baseUrl),
      },
    });
  }, [activeServer.baseUrl, activeServer.label]);

  useEffect(() => {
    postMobileBridgeMessage({
      type: "focusedConversationChanged",
      workspaceId: activeWorkspaceId,
      conversationId: focusedConversationId,
      lastEventSeq: projection?.lastEventSeq ?? 0,
    });
  }, [activeWorkspaceId, focusedConversationId, projection?.lastEventSeq]);

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
    const onNativeMessage = (event: Event) => {
      const message = (event as CustomEvent<MobileNativeToWebMessage>).detail;
      if (!message) {
        return;
      }
      if (message.type === "lifecycle") {
        const idle = message.state !== "active";
        document.documentElement.classList.toggle(MOBILE_IDLE_CLASS, idle);
        postMobileBridgeMessage({ type: "webIdleMode", enabled: idle });
        if (idle) {
          void flushWorkspaceSessionNow().catch(() => undefined);
        } else if (focusedConversationId) {
          flushAgentSubscription([focusedConversationId]);
          void syncConversationSnapshot(focusedConversationId, {
            hydrateRuntime: true,
          }).catch(() => undefined);
        }
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
    return () => {
      window.removeEventListener(MOBILE_BRIDGE_MESSAGE_EVENT, onNativeMessage);
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
